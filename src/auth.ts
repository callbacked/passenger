import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { deviceAuthorization } from 'better-auth/plugins/device-authorization';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import * as z from 'zod';
import { renderSVG } from 'uqr';
import * as schema from './db/schema.ts';
import type { Env } from './env.ts';

export const DEVICE_CLIENT_ID = 'passenger-screen';
const SESSION_SECONDS = 90 * 24 * 60 * 60;
// No 0/O or 1/I, so a code read off a screen cannot be misread.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type AdapterDatabase = Parameters<typeof drizzleAdapter>[0];

export interface AuthOverrides {
  // Tests supply an in-memory Drizzle database instead of the D1 binding.
  db?: AdapterDatabase;
  // Tests poll immediately; production waits between polls.
  pollInterval?: `${number}s`;
}

export interface AuthUser {
  email: string;
  name: string;
}

export function googleConfigured(env: Env): boolean {
  return typeof env.GOOGLE_CLIENT_ID === 'string' && env.GOOGLE_CLIENT_ID.length > 0 &&
    typeof env.GOOGLE_CLIENT_SECRET === 'string' && env.GOOGLE_CLIENT_SECRET.length > 0;
}

function devPasswordEnabled(env: Env): boolean {
  return env.AUTH_DEV_PASSWORD === 'true';
}

// Sign-in turns on once the database, secret and a way to sign in exist; otherwise the player stays open.
export function signInEnabled(env: Env, overrides: AuthOverrides = {}): boolean {
  return Boolean(env.DB || overrides.db) && typeof env.BETTER_AUTH_SECRET === 'string' && env.BETTER_AUTH_SECRET.length >= 32 &&
    (googleConfigured(env) || devPasswordEnabled(env));
}

export function generateUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

export function normalizeUserCode(value: unknown): string | null {
  const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === 6 && [...code].every(char => CODE_ALPHABET.includes(char)) ? code : null;
}

export function displayUserCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

function passengerPlugin() {
  return {
    id: 'passenger',
    endpoints: {
      // The signing-in screen receives a session token from /device/token; this turns it into its browser cookie.
      adoptDeviceSession: createAuthEndpoint('/passenger/adopt', {
        method: 'POST',
        body: z.object({ token: z.string().min(16).max(512) }),
      }, async (ctx) => {
        const found = await ctx.context.internalAdapter.findSession(ctx.body.token);
        if (!found || new Date(found.session.expiresAt) <= new Date()) {
          throw new APIError('UNAUTHORIZED', { message: 'That sign-in is no longer valid. Get a new code.' });
        }
        await setSessionCookie(ctx, found);
        return ctx.json({ user: { email: found.user.email, name: found.user.name } });
      }),
    },
  } satisfies BetterAuthPlugin;
}

export function authOptions(env: Env, origin: string, overrides: AuthOverrides = {}) {
  const database = overrides.db ?? drizzle(env.DB as D1Database, { schema });
  return {
    appName: 'Passenger',
    baseURL: origin,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(database, { provider: 'sqlite', schema }),
    trustedOrigins: [origin],
    socialProviders: googleConfigured(env)
      ? { google: { clientId: env.GOOGLE_CLIENT_ID as string, clientSecret: env.GOOGLE_CLIENT_SECRET as string, prompt: 'select_account' as const } }
      : {},
    // Local development only: lets tests sign a phone in without Google.
    emailAndPassword: { enabled: devPasswordEnabled(env) },
    session: { expiresIn: SESSION_SECONDS, updateAge: 24 * 60 * 60, cookieCache: { enabled: true, maxAge: 60 } },
    advanced: { useSecureCookies: origin.startsWith('https:') },
    rateLimit: { enabled: true, window: 60, max: 120 },
    plugins: [
      deviceAuthorization({
        verificationUri: '/approve',
        expiresIn: '10m',
        interval: overrides.pollInterval || '3s',
        userCodeLength: 6,
        generateUserCode,
        validateClient: async (id: string) => id === DEVICE_CLIENT_ID,
      }),
      passengerPlugin(),
    ],
  };
}

export function createAuth(env: Env, origin: string, overrides?: AuthOverrides) {
  return betterAuth(authOptions(env, origin, overrides));
}

export type Auth = ReturnType<typeof createAuth>;

export async function currentUser(auth: Auth, request: Request): Promise<AuthUser | null> {
  const result = await auth.api.getSession({ headers: request.headers });
  return result?.user ? { email: result.user.email, name: result.user.name } : null;
}

export interface DevicePairing {
  deviceCode: string;
  code: string;
  approveUrl: string;
  qrSvg: string;
  expiresIn: number;
  interval: number;
}

// Starts the screen's device flow and adds a QR code of the approval link for the phone camera.
export async function startDeviceCode(auth: Auth, request: Request): Promise<DevicePairing> {
  const data = await auth.api.deviceCode({ body: { client_id: DEVICE_CLIENT_ID }, headers: request.headers });
  return {
    deviceCode: data.device_code,
    code: displayUserCode(data.user_code),
    approveUrl: data.verification_uri_complete,
    qrSvg: renderSVG(data.verification_uri_complete, { ecc: 'M', border: 2, pixelSize: 4 }),
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}
