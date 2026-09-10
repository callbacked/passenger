import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedYouTubeClient, handleAccount } from '../src/account.ts';
import type { AccountServices, ClientOptions } from '../src/account.ts';
import type { Env } from '../src/env.ts';
import type { FetchLike } from '../src/types.ts';

// OAuth and InnerTube fixtures below have no published schema and are checked at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

interface StoredEntry {
  value: string;
  options: Record<string, unknown>;
}

function setup() {
  const values = new Map<string, StoredEntry>();
  const requests: { url: string; body: Node }[] = [];
  const clientOptions: ClientOptions[] = [];
  const signIns: Node[] = [];
  let now = 1_800_000_000_000;
  let reply: Node = { error: 'authorization_pending' };
  let nextCode = 0;
  const env = {
    MEDIA_SIGNING_SECRET: 'account-test-secret-is-at-least-32-characters-long',
    APP_DATA: {
      async get(key: string) { return values.get(key)?.value || null; },
      async put(key: string, value: string, options?: Record<string, unknown>) { values.set(key, { value, options: options ?? {} }); },
      async delete(key: string) { values.delete(key); },
    },
  } as unknown as Env;
  const services: { now: () => number; createClient: Node; fetch: FetchLike } = {
    now: () => now,
    createClient: async (options: ClientOptions) => {
      clientOptions.push(options);
      const client = { session: {
        logged_in: false,
        oauth: { getClientID: async () => ({ client_id: 'test-tv-client', client_secret: 'private-client-secret' }) },
        signIn: async (tokens: Node) => { signIns.push(tokens); client.session.logged_in = true; },
      }, actions: { execute: async (endpoint: string, body: Node) => {
        assert.equal(endpoint, '/browse');
        assert.equal(body.client, 'TV');
        return { success: true, status_code: 200, data: { contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: {
          content: { sectionListRenderer: { contents: [] } },
        } } } } } };
      } } };
      return client;
    },
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const body = JSON.parse((init?.body ?? '{}') as string);
      requests.push({ url: url.href, body });
      if (url.pathname === '/o/oauth2/device/code') {
        nextCode++;
        assert.equal(body.scope, 'http://gdata.youtube.com');
        return Response.json({ device_code: `private-device-code-${nextCode}`, user_code: `ABCD-${1000 + nextCode}`,
          verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 });
      }
      assert.equal(url.pathname, '/o/oauth2/token');
      return Response.json(reply, { status: reply.error ? 400 : 200 });
    },
  };
  const request = (action: string, body: Node = {}, cookie?: string, overrides: Record<string, string> = {}) => new Request(`https://player.test/api/account/${action}`, {
    method: action === 'status' || action === 'probe' ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://player.test',
      ...(cookie ? { Cookie: cookie } : {}), ...overrides },
    ...(action === 'status' || action === 'probe' ? {} : { body: JSON.stringify(body) }),
  });
  const call = (...args: Parameters<typeof request>) => handleAccount(request(...args), env, services as unknown as AccountServices);
  const takeCookie = (response: Response) => response.headers.get('Set-Cookie')?.split(';')[0];
  async function connect() {
    const start = await call('start');
    const pendingCookie = takeCookie(start);
    now += 5000;
    reply = { access_token: 'private-access-token', refresh_token: 'private-refresh-token', expires_in: 3600 };
    const poll = await call('poll', {}, pendingCookie);
    assert.equal(poll.status, 200);
    assert.equal((await poll.json() as Node).status, 'connected');
    return { cookie: takeCookie(poll), pendingCookie };
  }
  return { call, request, takeCookie, connect, env, services, values, requests, clientOptions, signIns,
    advance: (ms: number) => { now += ms; }, setReply: (value: Node) => { reply = value; } };
}

test('Signed-out status never creates a session or calls YouTube; mutations require same-origin JSON', async () => {
  const { call, values, requests, request, env, services } = setup();
  const response = await call('status');
  assert.deepEqual(await response.json() as Node, { status: 'signed_out', client: 'YouTube on TV' });
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(values.size, 0);
  assert.equal(requests.length, 0);
  for (const action of ['start', 'poll', 'disconnect', 'feed']) {
    assert.equal((await call(action, {}, undefined, { Origin: 'https://attacker.test' })).status, 403);
    assert.equal((await call(action, {}, undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const missingOrigin = request(action);
    missingOrigin.headers.delete('Origin');
    assert.equal((await handleAccount(missingOrigin, env, services as unknown as AccountServices)).status, 403);
  }
  assert.equal((await call('start', { token: 'caller-supplied-identity' })).status, 400);
  assert.equal((await call('start', [], undefined)).status, 400);
  assert.equal((await call('start', {}, undefined, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await call('start', { x: 'x'.repeat(9000) })).status, 413);
  assert.equal((await handleAccount(new Request('https://player.test/api/account/start'), env, services as unknown as AccountServices)).status, 405);
  assert.equal((await call('unknown')).status, 404);
  assert.equal(values.size, 0);
  assert.equal(requests.length, 0);
});

test('Starting and resuming pairing expose only the Google activation code and keep credentials encrypted', async () => {
  const { call, takeCookie, requests, values, clientOptions } = setup();
  const start = await call('start');
  assert.equal(start.status, 201);
  assert.match(start.headers.get('Set-Cookie')!, /^__Host-passenger_account=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
  const { qrSvg, ...body } = await start.json() as Node;
  assert.deepEqual(body, { status: 'pending', client: 'YouTube on TV', userCode: 'ABCD-1001',
    verificationUrl: 'https://www.google.com/device', activationUrl: 'https://www.google.com/device?user_code=ABCD-1001',
    expiresAt: 1_800_001_800_000, pollAfter: 5 });
  assert.match(qrSvg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+">/);
  assert.ok(!/<script|javascript:|href|<image|<foreignObject|<use/i.test(qrSvg), 'The QR SVG must contain only shapes');
  assert.ok(qrSvg.length < 16384, 'The QR SVG must stay small');
  assert.equal(clientOptions[0].enable_session_cache, false);
  assert.equal(clientOptions[0].retrieve_player, false);
  assert.deepEqual(await (await call('status', {}, takeCookie(start))).json() as Node, { ...body, qrSvg });
  assert.deepEqual(await (await call('start', {}, takeCookie(start))).json() as Node, { ...body, qrSvg });
  assert.equal(requests.length, 1, 'Resuming an existing code must not issue another device code');
  for (const entry of values.values()) {
    assert.deepEqual(Object.keys(JSON.parse(entry.value)).sort(), ['data', 'iv', 'version']);
    assert.ok((entry.options.expirationTtl as number) <= 1800);
    for (const secret of ['private-device-code', 'private-client-secret', 'ABCD-1001']) assert.ok(!entry.value.includes(secret));
  }
});

test('Polling honors the server interval and slow_down without an upstream request for early polls', async () => {
  const { call, takeCookie, requests, advance, setReply } = setup();
  const start = await call('start');
  const cookie = takeCookie(start);
  assert.equal((await call('poll', {}, cookie)).headers.get('Retry-After'), '5');
  assert.equal(requests.length, 1);
  advance(5000);
  assert.equal((await (await call('poll', {}, cookie)).json() as Node).pollAfter, 5);
  assert.equal(requests.length, 2);
  assert.equal((await call('poll', {}, cookie)).headers.get('Retry-After'), '5');
  assert.equal(requests.length, 2);
  advance(5000);
  setReply({ error: 'slow_down' });
  const slower = await call('poll', {}, cookie);
  assert.equal((await slower.json() as Node).pollAfter, 10);
  assert.equal(slower.headers.get('Retry-After'), '10');
  advance(5000);
  assert.equal((await (await call('poll', {}, cookie)).json() as Node).pollAfter, 5);
  assert.equal(requests.length, 3);
});

test('Successful pairing rotates the browser session, protects tokens, and disconnects only that browser', async () => {
  const { call, connect, requests, values } = setup();
  const { cookie, pendingCookie } = await connect();
  assert.notEqual(cookie, pendingCookie);
  assert.equal((await (await call('status', {}, pendingCookie)).json() as Node).status, 'signed_out');
  assert.equal((await (await call('status', {}, cookie)).json() as Node).status, 'connected');
  assert.equal((await (await call('status')).json() as Node).status, 'signed_out');
  const rawStorage = [...values.values()].map(entry => entry.value).join('');
  assert.ok(!rawStorage.includes('private-access-token'));
  assert.ok(!rawStorage.includes('private-refresh-token'));
  const before = requests.length;
  const disconnect = await call('disconnect', {}, cookie);
  assert.deepEqual(await disconnect.json() as Node, { status: 'signed_out', client: 'YouTube on TV' });
  assert.match(disconnect.headers.get('Set-Cookie')!, /Max-Age=0/);
  assert.equal((await (await call('status', {}, cookie)).json() as Node).status, 'signed_out');
  assert.equal(requests.length, before, 'Local disconnect must not revoke the shared TV OAuth app grant');
});

test('Two browsers cannot read or disconnect each other’s connection', async () => {
  const { call, connect, advance } = setup();
  const first = await connect();
  advance(15_000);
  const second = await connect();
  assert.notEqual(first.cookie, second.cookie);
  await call('disconnect', {}, first.cookie);
  assert.equal((await (await call('status', {}, first.cookie)).json() as Node).status, 'signed_out');
  assert.equal((await (await call('status', {}, second.cookie)).json() as Node).status, 'connected');
  assert.equal((await call('disconnect', { sessionId: second.cookie }, first.cookie)).status, 400);
});

test('Denied or expired pairing deletes private state and returns a clear terminal status', async () => {
  for (const [error, status] of [['access_denied', 'denied'], ['expired_token', 'expired']]) {
    const { call, takeCookie, advance, setReply } = setup();
    const cookie = takeCookie(await call('start'));
    advance(5000);
    setReply({ error });
    const poll = await call('poll', {}, cookie);
    assert.equal((await poll.json() as Node).status, status);
    assert.match(poll.headers.get('Set-Cookie')!, /Max-Age=0/);
    assert.equal((await (await call('status', {}, cookie)).json() as Node).status, 'signed_out');
  }
  const { call, takeCookie, advance, requests } = setup();
  const cookie = takeCookie(await call('start'));
  advance(1_800_001);
  assert.equal((await (await call('poll', {}, cookie)).json() as Node).status, 'expired');
  assert.equal(requests.length, 1, 'An expired code must never be sent to Google');
});

test('Storage tampering, missing keys and upstream errors never reveal account credentials', async () => {
  const { call, connect, values, env, services, advance, takeCookie } = setup();
  const { cookie } = await connect();
  for (const [key, entry] of values) values.set(key, { ...entry, value: entry.value.replace(/"data":"./, '"data":"!') });
  assert.equal((await (await call('status', {}, cookie)).json() as Node).status, 'signed_out');
  delete env.MEDIA_SIGNING_SECRET;
  assert.equal((await call('start')).status, 503);
  env.MEDIA_SIGNING_SECRET = 'another-valid-long-secret-that-is-longer-than-32';
  advance(20_000);
  services.fetch = async () => { throw new Error('private-refresh-token upstream-url private-client-secret'); };
  const failed = await call('start');
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json() as Node, { error: 'Your YouTube connection is temporarily unavailable. Try again.', code: 'ACCOUNT_UNAVAILABLE' });
  assert.equal(takeCookie(failed), undefined);
});

test('Authenticated feeds refresh expiring tokens privately and reject revoked connections', async () => {
  const { call, connect, advance, setReply, requests, signIns, clientOptions } = setup();
  const { cookie } = await connect();
  advance(3_550_000);
  setReply({ access_token: 'private-refreshed-access', expires_in: 3600 });
  const feed = await call('feed', { feed: 'home' }, cookie);
  assert.equal(feed.status, 200);
  const result = await feed.json() as Node;
  assert.deepEqual(result.videos, []);
  assert.equal(requests.at(-1)!.body.grant_type, 'refresh_token');
  assert.equal(requests.at(-1)!.body.refresh_token, 'private-refresh-token');
  assert.equal(signIns[0].access_token, 'private-refreshed-access');
  assert.equal(clientOptions.at(-1)!.client_type, 'TVHTML5');
  assert.equal(clientOptions.at(-1)!.enable_session_cache, false);
  advance(3_550_000);
  setReply({ error: 'invalid_grant' });
  const revoked = await call('feed', { feed: 'home' }, cookie);
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json() as Node).status, 'signed_out');
  assert.match(revoked.headers.get('Set-Cookie')!, /Max-Age=0/);
  assert.equal((await (await call('status', {}, cookie)).json() as Node).status, 'signed_out');
});

test('Starting new codes is rate limited and unsigned or pending browsers cannot load private feeds', async () => {
  const { call, takeCookie, requests } = setup();
  assert.equal((await call('feed', { feed: 'home' })).status, 401);
  const cookie = takeCookie(await call('start'));
  assert.equal((await call('start')).status, 429);
  assert.equal((await call('feed', { feed: 'home' }, cookie)).status, 401);
  assert.equal(requests.length, 1);
});

test('Account feed errors retain actionable codes, and malformed feed input never selects an upstream URL', async () => {
  const { call, connect } = setup();
  const { cookie } = await connect();
  const shorts = await call('feed', { feed: 'shorts' }, cookie);
  assert.equal(shorts.status, 409);
  assert.equal((await shorts.json() as Node).code, 'ACCOUNT_SHORTS_SEED_REQUIRED');
  const invalid = await call('feed', { feed: 'home', url: 'https://attacker.test' }, cookie);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as Node).code, 'INVALID_ACCOUNT_FEED');
});

test('OAuth responses stop reading at the size limit and unsafe verification links never reach the UI', async () => {
  const oversized = setup();
  let canceled = false;
  oversized.services.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(65537)); },
    cancel() { canceled = true; },
  }));
  const response = await oversized.call('start');
  assert.equal(response.status, 502);
  assert.equal(canceled, true);
  assert.equal(response.headers.get('Set-Cookie'), null);
  const unsafe = setup();
  unsafe.services.fetch = async () => Response.json({ device_code: 'private-device-code', user_code: 'ABCD-1234',
    verification_url: 'https://attacker.test/activate', expires_in: 1800, interval: 5 });
  const invalid = await unsafe.call('start');
  assert.equal(invalid.status, 502);
  assert.ok(!(await invalid.text()).includes('attacker.test'));
  assert.equal(invalid.headers.get('Set-Cookie'), null);
});

test('Account encryption is bound to its browser record and sessions have a fixed expiration', async () => {
  const { call, connect, advance, values } = setup();
  const first = await connect();
  const firstRecord = [...values.entries()].find(([, entry]) => entry.options.expirationTtl === 2592000)!;
  advance(15_000);
  const second = await connect();
  const secondRecord = [...values.entries()].find(([key, entry]) => key !== firstRecord[0] && entry.options.expirationTtl === 2592000)!;
  values.set(secondRecord[0], firstRecord[1]);
  assert.equal((await (await call('status', {}, second.cookie)).json() as Node).status, 'signed_out', 'Copying another encrypted record cannot authenticate this browser');
  assert.equal((await (await call('status', {}, first.cookie)).json() as Node).status, 'connected');
  advance(2592000 * 1000);
  const expired = await call('status', {}, first.cookie);
  assert.equal((await expired.json() as Node).status, 'signed_out');
  assert.match(expired.headers.get('Set-Cookie')!, /Max-Age=0/);
});

test('Account upstream redirects are rejected without following the new address', async () => {
  const { call, services } = setup();
  let fetched = 0;
  services.fetch = async (input, init) => {
    fetched++;
    assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://attacker.test' } });
  };
  const response = await call('start');
  assert.equal(response.status, 502);
  assert.equal(fetched, 1);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.ok(!(await response.text()).includes('attacker.test'));
});

test('Native workerd pairs through the real YouTube.js client and encrypted KV, then resumes and disconnects', async () => {
  const { build } = await import('esbuild');
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const bundle = await build({
    stdin: { contents: "import {handleAccount} from './src/account.ts'; export default {fetch(request,env){return handleAccount(request,env)}}", resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent',
  });
  const requested: string[] = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({
    script: bundle.outputFiles[0].text, modules: true, compatibilityDate: '2026-09-09', kvNamespaces: ['APP_DATA'],
    bindings: { MEDIA_SIGNING_SECRET: 'fixture-secret-long-enough-for-private-account-encryption' },
    outboundService: async request => {
      const path = new URL(request.url).pathname;
      requested.push(path);
      if (path === '/tv') return new Response('<script id="base-js" src="/tv-base.js"></script>');
      if (path === '/tv-base.js') return new Response('clientId:"fixture-tv",clientSecret:"fixture-secret"');
      assert.equal(path, '/o/oauth2/device/code');
      assert.equal((await request.json() as Node).scope, 'http://gdata.youtube.com');
      return Response.json({ device_code: 'fixture-device', user_code: 'ABCD-1234',
        verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 });
    },
  }));
  const call = (action: string, cookie?: string) => runtime.dispatchFetch(`https://player.test/api/account/${action}`, {
    method: action === 'status' ? 'GET' : 'POST',
    headers: { Origin: 'https://player.test', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(action === 'status' ? {} : { body: '{}' }),
  });
  try {
    const start = await call('start');
    assert.equal(start.status, 201);
    const pending = await start.json() as Node;
    assert.equal(pending.status, 'pending');
    assert.equal(pending.userCode, 'ABCD-1234');
    assert.equal(pending.verificationUrl, 'https://www.google.com/device');
    assert.equal(pending.activationUrl, 'https://www.google.com/device?user_code=ABCD-1234');
    assert.match(pending.qrSvg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /, 'The Worker runtime must render the QR');
    const cookie = start.headers.get('Set-Cookie')!.split(';')[0];
    assert.equal((await (await call('status', cookie)).json() as Node).userCode, pending.userCode);
    assert.equal((await (await call('poll', cookie)).json() as Node).status, 'pending');
    assert.deepEqual(requested, ['/tv', '/tv-base.js', '/o/oauth2/device/code']);
    assert.equal((await (await call('disconnect', cookie)).json() as Node).status, 'signed_out');
    assert.equal((await (await call('status', cookie)).json() as Node).status, 'signed_out');
  } finally {
    await runtime.dispose();
  }
});

test('The connected account session is available for playback only to the browser that paired it', async () => {
  const { connect, request, env, services, signIns } = setup();
  const none = await connectedYouTubeClient(request('status'), env, services as unknown as AccountServices);
  assert.equal(none, null, 'A browser without a connection gets no session');
  const { cookie, pendingCookie } = await connect();
  assert.equal(await connectedYouTubeClient(request('status', {}, pendingCookie), env, services as unknown as AccountServices), null, 'A pending pairing is not a session');
  const client = await connectedYouTubeClient(request('status', {}, cookie), env, services as unknown as AccountServices);
  assert.ok(client, 'A connected browser gets a signed-in client');
  assert.equal(client.session.logged_in, true);
  assert.equal(signIns.at(-1).access_token, 'private-access-token');
});

test('The playback probe needs a connected browser and reports every client', async () => {
  const { call, connect } = setup();
  assert.equal((await call('probe')).status, 401);
  const { cookie } = await connect();
  const probe = await call('probe', {}, cookie);
  assert.equal(probe.status, 200);
  const body = await probe.json() as Node;
  assert.equal(body.video, 'M7lc1UVf-VE');
  assert.deepEqual(body.clients.map((row: Node) => row.client), ['TV', 'VISIONOS', 'IOS', 'ANDROID_VR', 'ANDROID', 'WEB', 'MWEB', 'WEB_EMBEDDED', 'TV_EMBEDDED', 'YTMUSIC']);
  assert.ok(body.clients.every((row: Node) => typeof row.error === 'string'), 'The fake client has no player, so every row reports an error');
});
