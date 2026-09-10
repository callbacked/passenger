import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { handleRequest } from '../src/app.ts';
import type { Services } from '../src/app.ts';
import type { Env } from '../src/env.ts';
import { normalizeUserCode } from '../src/auth.ts';
import * as schema from '../src/db/schema.ts';

// JSON responses from the Worker are loosely inspected across many assertions below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const ORIGIN = 'https://player.test';
const providers = { youtube: {}, twitch: { status: async () => ({ live: false }) } };

interface CallOptions {
  body?: unknown;
  cookie?: string;
  method?: string;
  headers?: Record<string, string>;
}

async function setup(overrides: Record<string, unknown> = {}) {
  // The checked-in D1 migrations build the schema, so the tests also prove those files.
  const db = drizzle(new Database(':memory:'), { schema });
  migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  const env = {
    MEDIA_SIGNING_SECRET: 'auth-test-media-secret-that-is-longer-than-32-chars',
    BETTER_AUTH_SECRET: 'auth-test-better-auth-secret-longer-than-32-chars',
    AUTH_DEV_PASSWORD: 'true',
    DB: {},
    APP_DATA: { async get() { return null; }, async put() {}, async delete() {} },
    ASSETS: { fetch: async () => new Response('static asset') },
    ...overrides,
  } as unknown as Env;
  // Tests poll immediately, so the device flow's polling interval is switched off.
  const services = { providers, auth: { db, pollInterval: '0s' } } as unknown as Services;
  const call = (path: string, { body, cookie, method, headers = {} }: CallOptions = {}) => handleRequest(new Request(`${ORIGIN}${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: ORIGIN }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, services);
  const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).filter(value => !value.endsWith('='));
  const cookieHeader = (response: Response) => cookies(response).join('; ');
  return { env, call, cookies, cookieHeader };
}

test('Sign-in stays off until Better Auth is configured', async () => {
  const { call } = await setup({ BETTER_AUTH_SECRET: undefined });
  assert.deepEqual(await (await call('/api/passenger/status')).json() as Node, { enabled: false, googleConfigured: false, status: 'signed_out' });
  assert.equal((await call('/api/twitch/status?channel=x')).status, 200, 'The API stays open without sign-in');
  assert.equal((await call('/api/auth/get-session')).status, 404);
  assert.equal((await call('/api/passenger/device-code', { body: {} })).status, 409);
});

test('Screen device code, phone approval, cookie adoption, gating and sign-out', async () => {
  const { call, cookies, cookieHeader } = await setup();
  assert.equal((await call('/api/twitch/status?channel=x')).status, 401, 'Every API needs a session once sign-in is configured');
  assert.deepEqual(await (await call('/api/passenger/status')).json() as Node, { enabled: true, googleConfigured: false, status: 'signed_out' });

  const start = await call('/api/passenger/device-code', { body: {} });
  assert.equal(start.status, 201);
  const pairing = await start.json() as Node;
  assert.equal(pairing.status, 'pending');
  assert.match(pairing.code, /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/, 'Codes avoid 0/O and 1/I');
  const userCode = normalizeUserCode(pairing.code);
  assert.equal(pairing.approveUrl, `${ORIGIN}/approve?user_code=${userCode}`);
  assert.match(pairing.qrSvg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
  assert.equal(pairing.interval, 0);
  assert.ok(pairing.deviceCode.length >= 16);
  const grant = { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: pairing.deviceCode, client_id: 'passenger-screen' };
  const pending = await call('/api/auth/device/token', { body: grant });
  assert.equal(pending.status, 400);
  assert.equal((await pending.json() as Node).error, 'authorization_pending');

  // The phone signs in (local password mode stands in for Google), verifies the code, and approves it.
  const signUp = await call('/api/auth/sign-up/email', { body: { email: 'wife@example.com', password: 'a-long-password', name: 'Wife' } });
  assert.equal(signUp.status, 200);
  const phone = cookieHeader(signUp);
  assert.deepEqual(await (await call('/api/passenger/status', { cookie: phone })).json() as Node,
    { enabled: true, googleConfigured: false, status: 'signed_in', user: { email: 'wife@example.com', name: 'Wife' } });
  assert.equal((await call('/api/auth/device/approve', { body: { userCode }, cookie: phone })).status, 400, 'Approval needs the code claimed first');
  const verify = await call(`/api/auth/device?user_code=${userCode}`, { cookie: phone });
  assert.equal(verify.status, 200);
  assert.equal((await verify.json() as Node).status, 'pending');
  assert.equal((await call('/api/auth/device/approve', { body: { userCode }, cookie: phone })).status, 200);

  // The screen polls, receives a session token, and turns it into its own cookie.
  const token = await call('/api/auth/device/token', { body: grant });
  assert.equal(token.status, 200);
  const { access_token: accessToken } = await token.json() as Node;
  assert.ok(accessToken);
  const adopt = await call('/api/auth/passenger/adopt', { body: { token: accessToken } });
  assert.equal(adopt.status, 200);
  assert.deepEqual(await adopt.json() as Node, { user: { email: 'wife@example.com', name: 'Wife' } });
  const screen = cookieHeader(adopt);
  assert.ok(cookies(adopt).some(value => value.startsWith('__Secure-better-auth.session_token=')), 'The screen gets a secure session cookie');
  assert.equal((await call('/api/twitch/status?channel=x', { cookie: screen })).status, 200);
  assert.equal((await (await call('/api/passenger/status', { cookie: screen })).json() as Node).status, 'signed_in');
  assert.equal((await call('/api/passenger/device-code', { body: {}, cookie: screen })).status, 200, 'A signed-in screen does not get another code');
  assert.equal((await call('/api/auth/device/token', { body: grant })).status, 400, 'A device code cannot be redeemed twice');
  assert.equal((await call('/api/auth/passenger/adopt', { body: { token: 'not-a-real-session-token' } })).status, 401);

  const signOut = await call('/api/auth/sign-out', { body: {}, cookie: screen });
  assert.equal(signOut.status, 200);
  const cleared = cookieHeader(signOut);
  assert.equal((await call('/api/twitch/status?channel=x', { cookie: cleared })).status, 401, 'Sign-out ends the screen session');
  assert.equal((await call('/api/twitch/status?channel=x', { cookie: phone })).status, 200, 'The phone stays signed in');
});

test('Denied, expired and forged approvals never sign the screen in', async () => {
  const { call, cookieHeader } = await setup();
  const pairing = await (await call('/api/passenger/device-code', { body: {} })).json() as Node;
  const userCode = normalizeUserCode(pairing.code);
  const grant = { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: pairing.deviceCode, client_id: 'passenger-screen' };
  assert.equal((await call('/api/auth/device/approve', { body: { userCode } })).status, 401, 'Approval needs a signed-in phone');
  const phone = cookieHeader(await call('/api/auth/sign-up/email', { body: { email: 'friend@example.com', password: 'another-long-password', name: 'Friend' } }));
  assert.equal((await call('/api/auth/device?user_code=ZZZZZZ', { cookie: phone })).status, 400, 'Unknown codes are rejected');
  await call(`/api/auth/device?user_code=${userCode}`, { cookie: phone });
  assert.equal((await call('/api/auth/device/deny', { body: { userCode }, cookie: phone })).status, 200);
  const denied = await call('/api/auth/device/token', { body: grant });
  assert.equal((await denied.json() as Node).error, 'access_denied');
  assert.equal((await call('/api/auth/device/token', { body: { ...grant, client_id: 'someone-else' } })).status, 400);
  assert.equal((await call('/api/passenger/device-code', { body: {}, headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await call('/api/auth/sign-up/email', { body: { email: 'x@example.com', password: 'another-long-password', name: 'X' }, headers: { Origin: 'https://evil.test' } })).status, 403, 'Better Auth refuses cross-origin posts');
});

test('User codes normalize typed input', () => {
  assert.equal(normalizeUserCode(' abc-def '), 'ABCDEF');
  assert.equal(normalizeUserCode('ABC-DE'), null);
  assert.equal(normalizeUserCode('ABC0EF'), null, 'Zero is never part of a code');
});
