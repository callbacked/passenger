import { ClientType, Innertube, Log } from 'youtubei.js/cf-worker';
import { AccountFeedError, loadAccountFeed } from './account-feeds.ts';
import { renderSVG } from 'uqr';
import { base64url as base64, createSecureStore, type SecureStore } from './secure-store.ts';
import type { Env } from './env.ts';
import type { FetchLike } from './types.ts';

Log.setLevel(Log.Level.NONE);

const COOKIE = '__Host-passenger_account';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SCOPE = 'http://gdata.youtube.com';
const CLIENT_NAME = 'YouTube on TV';
const CODE_URL = 'https://www.youtube.com/o/oauth2/device/code';
const TOKEN_URL = 'https://www.youtube.com/o/oauth2/token';

export type ClientOptions = NonNullable<Parameters<typeof Innertube.create>[0]>;
export type ClientFactory = (options: ClientOptions) => Promise<Innertube>;

interface OAuthIdentity {
  client_id: string;
  client_secret: string;
}

interface PendingRecord {
  status: 'pending';
  client: OAuthIdentity;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  nextPollAt: number;
  expiresAt: number;
}

interface ConnectedRecord {
  status: 'connected';
  client: OAuthIdentity;
  expiresAt: number;
  tokens: { accessToken: string; refreshToken: string; expiresAt: number };
}

type AccountRecord = PendingRecord | ConnectedRecord;

interface StartLimit {
  count: number;
  expiresAt: number;
  nextStartAt?: number;
}

// Google's OAuth device endpoints answer with loosely shaped JSON that is validated below.
interface OAuthResponse {
  error?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  device_code?: unknown;
  user_code?: unknown;
  verification_url?: unknown;
  verification_uri?: unknown;
  interval?: unknown;
}

class AccountError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 502, code = 'ACCOUNT_UNAVAILABLE') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cookie(value: string, age = SESSION_SECONDS): string {
  return `${COOKIE}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
}

function sessionId(request: Request): string | null {
  const values = (request.headers.get('Cookie') || '').split(';').map(value => value.trim());
  const matches = values.filter(value => value.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const id = matches[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(id) ? id : null;
}

function json(value: unknown, status = 200, setCookie?: string, retryAfter?: number): Response {
  const headers: Record<string, string> = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  if (retryAfter) headers['Retry-After'] = String(retryAfter);
  return Response.json(value, { status, headers });
}

async function readJson(request: Request, limit = 8192): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new AccountError('Send a JSON request.', 415, 'INVALID_ACCOUNT_REQUEST');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError('Send a JSON request.', 400, 'INVALID_ACCOUNT_REQUEST');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw new AccountError('Request body is too large.', 413, 'INVALID_ACCOUNT_REQUEST');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* Return the same validation error below. */ }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AccountError('Send a JSON object.', 400, 'INVALID_ACCOUNT_REQUEST');
  }
  return body as Record<string, unknown>;
}

async function storage(env: Env): Promise<SecureStore> {
  if (!env.APP_DATA || typeof env.MEDIA_SIGNING_SECRET !== 'string' || env.MEDIA_SIGNING_SECRET.length < 32) {
    throw new AccountError('Account sign-in is not configured yet.', 503, 'ACCOUNT_SETUP_REQUIRED');
  }
  // Key derivation parameters must stay fixed: existing YouTube connections are stored with them.
  return createSecureStore(env as Env & { MEDIA_SIGNING_SECRET: string },
    { prefix: 'account:', salt: 'passenger-account-v1', info: 'private-account-storage' });
}

function activationUrl(record: PendingRecord): string {
  // Google's device page reads user_code from the query and fills the code in.
  const url = new URL(record.verificationUrl);
  url.searchParams.set('user_code', record.userCode);
  return url.href;
}

function pending(record: PendingRecord, now: number) {
  const activation = activationUrl(record);
  return { status: 'pending', client: CLIENT_NAME, userCode: record.userCode, verificationUrl: record.verificationUrl,
    activationUrl: activation,
    // A phone camera opens the activation address directly; the SVG carries nothing else.
    qrSvg: renderSVG(activation, { ecc: 'M', border: 2, pixelSize: 4 }),
    expiresAt: record.expiresAt, pollAfter: Math.max(1, Math.ceil((record.nextPollAt - now) / 1000)) };
}

function connected(record: ConnectedRecord) {
  return { status: 'connected', client: CLIENT_NAME, expiresAt: record.expiresAt };
}

async function oauth(fetchImpl: FetchLike, url: string, body: Record<string, unknown>): Promise<OAuthResponse> {
  const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), redirect: 'manual' });
  const reader = response.body?.getReader();
  if (!reader) throw new AccountError('YouTube sign-in is unavailable. Try again.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) {
      await reader.cancel();
      throw new AccountError('YouTube sign-in returned an unexpected response. Try again.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let data: OAuthResponse;
  try { data = JSON.parse(new TextDecoder().decode(bytes)) as OAuthResponse; } catch { throw new AccountError('YouTube sign-in is unavailable. Try again.'); }
  if (!response.ok && !data.error) throw new AccountError('YouTube sign-in is unavailable. Try again.');
  return data;
}

function validToken(data: OAuthResponse): data is OAuthResponse & { access_token: string; expires_in: number } {
  return typeof data.access_token === 'string' && data.access_token.length > 0 && data.access_token.length < 16384 &&
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0 && data.expires_in <= 86400;
}

async function limitStarts(request: Request, store: SecureStore, now: number): Promise<void> {
  // KV provides best-effort abuse limiting; Google remains authoritative for device polling limits.
  const identity = `start:${request.headers.get('CF-Connecting-IP') || 'local'}`;
  const previous = await store.get<StartLimit>(identity);
  const record: StartLimit = previous && previous.expiresAt > now ? previous : { count: 0, expiresAt: now + 600_000 };
  if (record.nextStartAt !== undefined && record.nextStartAt > now) throw new AccountError('Wait a few seconds before trying sign-in again.', 429, 'ACCOUNT_RATE_LIMIT');
  if (record.count >= 5) throw new AccountError('Too many sign-in attempts. Try again in a few minutes.', 429, 'ACCOUNT_RATE_LIMIT');
  record.count++;
  record.nextStartAt = now + 15_000;
  await store.put(identity, record, now);
}

function accountFetch(fetchImpl: FetchLike, signal: AbortSignal): FetchLike {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['www.youtube.com', 'youtubei.googleapis.com'].includes(url.hostname) || url.protocol !== 'https:') {
      throw new AccountError('YouTube account request could not be completed.');
    }
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    if (headers.get('Authorization')?.startsWith('Bearer ') && url.pathname.startsWith('/youtubei/')) {
      url.hostname = 'youtubei.googleapis.com';
      headers.set('Origin', url.origin);
      input = input instanceof Request ? new Request(url, input) : url;
    }
    // workerd supports manual redirects but rejects the browser's redirect:'error' mode.
    const response = await fetchImpl(input, { ...init, headers, signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new AccountError('YouTube account request was redirected. Please try again.');
    }
    return response;
  };
}

async function authenticatedClient(record: ConnectedRecord, id: string, store: SecureStore, now: number,
  fetchImpl: FetchLike, createClient: ClientFactory): Promise<Innertube> {
  if (record.tokens.expiresAt <= now + 60_000) {
    const data = await oauth(fetchImpl, TOKEN_URL, { ...record.client, refresh_token: record.tokens.refreshToken,
      grant_type: 'refresh_token' });
    if (data.error === 'invalid_grant' || data.error === 'invalid_token') {
      await store.delete(id);
      throw new AccountError('Your YouTube connection expired. Sign in again.', 401, 'ACCOUNT_SIGN_IN_REQUIRED');
    }
    if (!validToken(data) || data.error) throw new AccountError('YouTube could not refresh your connection. Try again.');
    record.tokens = { accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : record.tokens.refreshToken,
      expiresAt: now + data.expires_in * 1000 };
    await store.put(id, record, now);
  }
  const client = await createClient({ client_type: ClientType.TV, generate_session_locally: false, retrieve_player: false,
    retrieve_innertube_config: false, enable_session_cache: false, fail_fast: true, fetch: fetchImpl });
  await client.session.signIn({ access_token: record.tokens.accessToken, refresh_token: record.tokens.refreshToken,
    expiry_date: new Date(record.tokens.expiresAt).toISOString(), client: record.client });
  return client;
}

interface ProbeRow {
  client: string;
  status?: string;
  reason?: string;
  hls?: boolean;
  dash?: boolean;
  formats?: number;
  ciphered?: boolean;
  error?: string;
}

// Diagnostic: which InnerTube clients accept this browser's signed-in session for playback, and what they return.
async function probePlayback(client: Innertube, video: string | null): Promise<{ video: string; clients: ProbeRow[] }> {
  const id = typeof video === 'string' && /^[\w-]{11}$/.test(video) ? video : 'M7lc1UVf-VE';
  const names = ['TV', 'VISIONOS', 'IOS', 'ANDROID_VR', 'ANDROID', 'WEB', 'MWEB', 'WEB_EMBEDDED', 'TV_EMBEDDED', 'YTMUSIC'] as const;
  const rows: ProbeRow[] = [];
  for (const name of names) {
    const row: ProbeRow = { client: name };
    try {
      const info = await client.getBasicInfo(id, name === 'TV' ? undefined : { client: name });
      row.status = info.playability_status?.status;
      row.reason = info.playability_status?.reason;
      const data = info.streaming_data;
      row.hls = Boolean(data?.hls_manifest_url);
      row.dash = Boolean(data?.dash_manifest_url);
      const formats = [...(data?.formats || []), ...(data?.adaptive_formats || [])];
      row.formats = formats.length;
      row.ciphered = formats.some(format => !format.url && Boolean(format.signature_cipher || format.cipher));
    } catch (error) {
      row.error = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
    }
    console.log({ event: 'youtube.probe', ...row });
    rows.push(row);
  }
  return { video: id, clients: rows };
}

export interface AccountServices {
  fetch?: FetchLike;
  createClient?: ClientFactory;
  now?: () => number;
  waitUntil?: (task: Promise<unknown>) => void;
}

// The signed-in YouTube session of the browser that sent this request, or null when it has none.
export async function connectedYouTubeClient(request: Request, env: Env, {
  fetch: fetchImpl = globalThis.fetch,
  createClient = options => Innertube.create(options),
  now: time = () => Date.now(),
}: AccountServices = {}): Promise<Innertube | null> {
  const id = sessionId(request);
  if (!id || !env.APP_DATA || typeof env.MEDIA_SIGNING_SECRET !== 'string' || env.MEDIA_SIGNING_SECRET.length < 32) return null;
  const store = await storage(env);
  const record = await store.get<AccountRecord>(id);
  const now = time();
  if (!record || record.status !== 'connected' || record.expiresAt <= now) return null;
  return authenticatedClient(record, id, store, now, accountFetch(fetchImpl, AbortSignal.timeout(25_000)), createClient);
}

export async function handleAccount(request: Request, env: Env, {
  fetch: fetchImpl = globalThis.fetch,
  createClient = options => Innertube.create(options),
  now: time = () => Date.now(),
  waitUntil,
}: AccountServices = {}): Promise<Response> {
  const url = new URL(request.url);
  const action = url.pathname.slice('/api/account/'.length);
  if (!['status', 'start', 'poll', 'disconnect', 'feed', 'probe'].includes(action)) return json({ error: 'Endpoint not found.' }, 404);
  const method = action === 'status' || action === 'probe' ? 'GET' : 'POST';
  if (request.method !== method) return json({ error: `Use ${method}.` }, 405);
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site' ||
    (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) ||
    (method === 'POST' && request.headers.get('Origin') !== url.origin)) {
    return json({ error: 'Open Passenger to manage your YouTube connection.' }, 403);
  }
  try {
    const body = method === 'POST' ? await readJson(request) : {};
    if (action !== 'feed' && Object.keys(body).length) throw new AccountError('This request does not accept account details.', 400, 'INVALID_ACCOUNT_REQUEST');
    const now = time();
    const store = await storage(env);
    const id = sessionId(request);
    const record = await store.get<AccountRecord>(id);
    if (action === 'disconnect') {
      // Removing this browser's credential avoids revoking a shared YouTube TV app grant on other devices.
      await store.delete(id);
      return json({ status: 'signed_out', client: CLIENT_NAME }, 200, cookie('', 0));
    }
    if (action === 'status') {
      if (!record || record.expiresAt <= now) return json({ status: 'signed_out', client: CLIENT_NAME }, 200, id ? cookie('', 0) : undefined);
      return json(record.status === 'pending' ? pending(record, now) : connected(record));
    }
    const fetchAccount = accountFetch(fetchImpl, AbortSignal.timeout(25_000));
    if (action === 'start') {
      if (record && record.expiresAt > now) return json(record.status === 'pending' ? pending(record, now) : connected(record));
      await limitStarts(request, store, now);
      const client = await createClient({ client_type: ClientType.TV, generate_session_locally: true, retrieve_player: false,
        retrieve_innertube_config: false, enable_session_cache: false, fetch: fetchAccount });
      const identity = await client.session.oauth.getClientID();
      if (typeof identity?.client_id !== 'string' || typeof identity.client_secret !== 'string') {
        throw new AccountError('YouTube TV pairing is unavailable right now. Try again.');
      }
      // The TV client rejects youtube.readonly; the legacy YouTube scope works without paid-content access.
      const data = await oauth(fetchAccount, CODE_URL, { client_id: identity.client_id, scope: SCOPE,
        device_id: crypto.randomUUID(), device_model: 'ytlr::' });
      if (data.error || typeof data.device_code !== 'string' || !data.device_code || data.device_code.length > 4096 ||
        typeof data.user_code !== 'string' || !/^[A-Z0-9 -]{4,32}$/.test(data.user_code) ||
        typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
        throw new AccountError('YouTube TV pairing is unavailable right now. Try again.');
      }
      const verification = new URL(String(data.verification_url || data.verification_uri));
      if (verification.protocol !== 'https:' || !['www.google.com', 'google.com', 'accounts.google.com', 'g.co'].includes(verification.hostname) ||
        verification.username || verification.password || verification.port) throw new AccountError('YouTube returned an invalid sign-in address.');
      const interval = typeof data.interval === 'number' && Number.isFinite(data.interval) ? Math.max(5, Math.ceil(data.interval)) : 5;
      const nextId = base64(crypto.getRandomValues(new Uint8Array(32)));
      const next: PendingRecord = { status: 'pending', client: { client_id: identity.client_id, client_secret: identity.client_secret },
        deviceCode: data.device_code, userCode: data.user_code,
        verificationUrl: verification.href, interval, nextPollAt: now + interval * 1000,
        expiresAt: now + Math.min(data.expires_in, 1800) * 1000 };
      await store.put(nextId, next, now);
      await store.delete(id);
      return json(pending(next, now), 201, cookie(nextId));
    }
    if (!record || record.expiresAt <= now) {
      if (id) await store.delete(id);
      return json({ status: record?.status === 'pending' ? 'expired' : 'signed_out', client: CLIENT_NAME },
        action === 'feed' || action === 'probe' ? 401 : 200, cookie('', 0));
    }
    if (action === 'poll') {
      if (record.status === 'connected') return json(connected(record));
      if (record.nextPollAt > now) return json(pending(record, now), 200, undefined, Math.ceil((record.nextPollAt - now) / 1000));
      record.nextPollAt = now + record.interval * 1000;
      const data = await oauth(fetchAccount, TOKEN_URL, { ...record.client, code: record.deviceCode,
        grant_type: 'http://oauth.net/grant_type/device/1.0' });
      if (data.error === 'authorization_pending') {
        await store.put(id as string, record, now);
        return json(pending(record, now));
      }
      if (data.error === 'slow_down') {
        record.interval += 5;
        record.nextPollAt = now + record.interval * 1000;
        await store.put(id as string, record, now);
        return json(pending(record, now), 200, undefined, record.interval);
      }
      if (data.error === 'access_denied' || data.error === 'expired_token') {
        await store.delete(id);
        return json({ status: data.error === 'access_denied' ? 'denied' : 'expired', client: CLIENT_NAME }, 200, cookie('', 0));
      }
      if (data.error || !validToken(data) || typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 16384) {
        throw new AccountError('YouTube could not finish sign-in. Try again.');
      }
      const next: ConnectedRecord = { status: 'connected', client: record.client, expiresAt: now + SESSION_SECONDS * 1000,
        tokens: { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: now + data.expires_in * 1000 } };
      const nextId = base64(crypto.getRandomValues(new Uint8Array(32)));
      await store.put(nextId, next, now);
      await store.delete(id);
      // Diagnostic while playback through accounts is being worked out: record what each client returns for this session.
      waitUntil?.(authenticatedClient(next, nextId, store, now, fetchAccount, createClient).then(client => probePlayback(client, null))
        .catch(error => console.log({ event: 'youtube.probe_failed', error: error instanceof Error ? error.message : String(error) })));
      return json(connected(next), 200, cookie(nextId));
    }
    if (record.status !== 'connected') return json({ error: 'Finish YouTube sign-in to see your feeds.', status: 'pending', code: 'ACCOUNT_SIGN_IN_REQUIRED' }, 401);
    const client = await authenticatedClient(record, id as string, store, now, fetchAccount, createClient);
    if (action === 'probe') return json(await probePlayback(client, url.searchParams.get('video')));
    return json(await loadAccountFeed(body, client));
  } catch (error) {
    if (error instanceof AccountError) return json({ error: error.message, code: error.code,
      ...(error.status === 401 ? { status: 'signed_out' } : {}) }, error.status,
    error.status === 401 ? cookie('', 0) : undefined);
    if (error instanceof AccountFeedError) return json({ error: error.message, code: error.code }, error.status);
    return json({ error: 'Your YouTube connection is temporarily unavailable. Try again.', code: 'ACCOUNT_UNAVAILABLE' }, 502);
  }
}
