import { createMediaUrl, handleMedia } from './media.ts';
import { connectedYouTubeClient, handleAccount } from './account.ts';
import { createAuth, currentUser, googleConfigured, signInEnabled, startDeviceCode, type AuthOverrides } from './auth.ts';
import type { Env } from './env.ts';
import type { FetchLike, Playback, Provider, ResolveOptions } from './types.ts';

export interface Providers {
  youtube: {
    resolve: (input: string, options?: ResolveOptions) => Promise<Playback>;
    search: (query: string) => Promise<unknown>;
    shorts: (query: string, options: { cursor?: string }) => Promise<unknown>;
  };
  twitch: {
    resolve: (input: string, options?: ResolveOptions) => Promise<Playback>;
    status: (channel: string | null) => Promise<unknown>;
  };
}

export interface Services {
  providers: Providers;
  fetch?: FetchLike;
  auth?: AuthOverrides;
  // Lets background work outlive the response (Cloudflare's ctx.waitUntil).
  waitUntil?: (task: Promise<unknown>) => void;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

class RequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function readJson(request: Request, limit: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError('A JSON body is required.', 400);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > limit) {
      await reader.cancel();
      throw new RequestError('Request body is too large.', 413);
    }
    chunks.push(value);
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(data)); }
  catch { throw new RequestError('Send valid JSON.', 400); }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return (!origin || origin === new URL(request.url).origin) && request.headers.get('Sec-Fetch-Site') !== 'cross-site';
}

function isProvider(value: unknown, providers: Providers): value is Provider {
  return typeof value === 'string' && Object.hasOwn(providers, value);
}

export async function handleRequest(request: Request, env: Env,
  { providers, fetch: fetchImpl = globalThis.fetch, auth: authOverrides = {}, waitUntil }: Services): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/api/health') {
      return json({ ok: true, runtime: 'cloudflare-workers', providers: Object.keys(providers),
        configured: Boolean(env.MEDIA_SIGNING_SECRET && env.APP_DATA) });
    }
    const auth = signInEnabled(env, authOverrides) ? createAuth(env, url.origin, authOverrides) : null;
    if (url.pathname.startsWith('/api/auth/')) {
      if (!auth) return json({ error: 'Sign-in is not set up on this Passenger.', code: 'AUTH_DISABLED' }, 404);
      return await auth.handler(request);
    }
    if (url.pathname === '/api/passenger/status') {
      if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
      const user = auth ? await currentUser(auth, request) : null;
      return json({ enabled: Boolean(auth), googleConfigured: Boolean(auth) && googleConfigured(env),
        status: user ? 'signed_in' : 'signed_out', ...(user ? { user } : {}) });
    }
    if (url.pathname === '/api/passenger/device-code') {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      if (!sameOrigin(request)) return json({ error: 'Open Passenger to sign in.' }, 403);
      if (!auth) return json({ error: 'Sign-in is not set up on this Passenger.', code: 'AUTH_DISABLED' }, 409);
      const user = await currentUser(auth, request);
      if (user) return json({ status: 'signed_in', user });
      return json({ status: 'pending', ...await startDeviceCode(auth, request) }, 201);
    }
    if (auth && url.pathname.startsWith('/api/') && url.pathname !== '/api/probe-report') {
      // With sign-in configured, every other API needs a signed-in Passenger session.
      if (!await currentUser(auth, request)) {
        return json({ error: 'Sign in to Passenger to continue.', code: 'AUTH_SIGN_IN_REQUIRED', status: 'signed_out' }, 401);
      }
    }
    if (url.pathname.startsWith('/api/account/')) return await handleAccount(request, env, { fetch: fetchImpl, waitUntil });
    if (url.pathname === '/api/media') return await handleMedia(request, env, { fetch: fetchImpl });
    if (url.pathname === '/api/shorts') {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      if (!sameOrigin(request)) return json({ error: 'Open the player to browse Shorts.' }, 403);
      const body = await readJson(request, 4096);
      if (!isPlainObject(body) ||
        Object.keys(body).some(key => !['query', 'cursor'].includes(key)) || typeof body.query !== 'string' ||
        (body.cursor !== undefined && typeof body.cursor !== 'string')) {
        return json({ error: 'Enter a Shorts search.' }, 400);
      }
      return json(await providers.youtube.shorts(body.query, { cursor: body.cursor as string | undefined }));
    }
    if (url.pathname === '/api/search') {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      if (!sameOrigin(request)) return json({ error: 'Open the player to search YouTube.' }, 403);
      const body = await readJson(request, 1024);
      if (!isPlainObject(body) ||
        Object.keys(body).some(key => key !== 'query') || typeof body.query !== 'string') {
        return json({ error: 'Enter a YouTube search.' }, 400);
      }
      return json(await providers.youtube.search(body.query));
    }
    if (url.pathname === '/api/resolve') {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      if (!sameOrigin(request)) return json({ error: 'Open the player to load a video.' }, 403);
      const body = await readJson(request, 4096);
      if (!isPlainObject(body) || Object.keys(body).some(k => !['provider', 'input'].includes(k)) ||
        typeof body.input !== 'string' || !isProvider(body.provider, providers)) {
        return json({ error: 'Choose YouTube or Twitch and enter a video link or channel.' }, 400);
      }
      if (typeof env.MEDIA_SIGNING_SECRET !== 'string' || env.MEDIA_SIGNING_SECRET.length < 32) {
        return json({ error: 'Playback is not configured yet. The owner needs to finish the server setup.', code: 'SETUP_REQUIRED' }, 503);
      }
      const options: ResolveOptions = body.provider === 'youtube'
        ? { youtubeClient: () => connectedYouTubeClient(request, env, { fetch: fetchImpl }) } : {};
      const playback = await providers[body.provider].resolve(body.input, options);
      let expiresAt = Date.now() + 6 * 60 * 60 * 1000;
      const upstream = new URL(playback.streamUrl);
      const expiry = Number(upstream.searchParams.get('expire') || upstream.pathname.match(/\/expire\/(\d+)(?:\/|$)/)?.[1]) * 1000;
      if (expiry > 0) expiresAt = Math.min(expiresAt, expiry);
      if (expiresAt <= Date.now() + 60_000) return json({ error: 'The source returned an expired stream. Try again.' }, 502);
      const signOptions = { provider: playback.provider, origin: url.origin, secret: env.MEDIA_SIGNING_SECRET, expiresAt };
      const streamUrl = await createMediaUrl(playback.streamUrl, signOptions);
      return json({ provider: playback.provider, id: playback.id, title: playback.title, channel: playback.channel || '',
        live: playback.live, duration: playback.duration || 0, type: playback.type, streamUrl, expiresAt });
    }
    if (url.pathname === '/api/twitch/status' || url.pathname === '/api/twitch/live') {
      if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
      return json(await providers.twitch.status(url.searchParams.get('channel')));
    }
    if (url.pathname === '/api/probe-report') {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      if (!sameOrigin(request)) return json({ error: 'Open the browser probe to send a report.' }, 403);
      if (!env.APP_DATA) return json({ error: 'Report storage is not configured.' }, 503);
      const data = await readJson(request, 32 * 1024);
      if (!isPlainObject(data)) return json({ error: 'Send a report object.' }, 400);
      const id = crypto.randomUUID();
      await env.APP_DATA.put(`probe:${id}`, JSON.stringify({ receivedAt: new Date().toISOString(), data }), { expirationTtl: 604800 });
      return json({ ok: true, id }, 201);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Endpoint not found.' }, 404);
    return env.ASSETS.fetch(request);
  } catch (error) {
    const failure = error as { status?: unknown; statusCode?: unknown; message?: unknown; code?: unknown };
    const status = Number.isInteger(failure.status) && (failure.status as number) >= 400 && (failure.status as number) <= 599 ? failure.status as number
      : Number.isInteger(failure.statusCode) && (failure.statusCode as number) >= 400 && (failure.statusCode as number) <= 599 ? failure.statusCode as number : 500;
    if (status === 500) console.error('Unexpected request failure', url.pathname, error);
    return json({ error: status === 500 ? 'Something went wrong. Please try again.' : String(failure.message),
      ...(typeof failure.code === 'string' ? { code: failure.code } : {}) }, status);
  }
}
