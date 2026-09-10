// Loads the player only after Passenger sign-in, when the owner has configured Better Auth.
import type { DeviceCodeResponse, DeviceTokenResponse, PassengerAdoptResponse, PassengerStatus, SocialSignInResponse } from './api.ts';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}.`);
  return element as T;
}

const screen = $('signin-screen');
const CLIENT_ID = 'passenger-screen';
let appLoaded = false;
let pollTimer: number | undefined;
let generation = 0;

class GateError extends Error {
  code?: string;
  status: number;

  constructor(message: string, code: string | undefined, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface RequestResult<T> {
  ok: boolean;
  status: number;
  data: T;
}

async function request<T = unknown>(path: string, body?: Record<string, unknown>): Promise<RequestResult<T>> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T;
  return { ok: response.ok, status: response.status, data };
}

function failure(result: RequestResult<unknown>, fallback: string): GateError {
  const data = (result.data && typeof result.data === 'object' ? result.data : {}) as {
    error_description?: string; message?: string; error?: string; code?: string;
  };
  return new GateError(
    data.error_description || data.message || (typeof data.error === 'string' && data.error) || fallback,
    data.code || data.error,
    result.status,
  );
}

function renderControls(state: PassengerStatus): void {
  const mount = $('access-controls');
  if (!state.enabled || !mount) return;
  mount.replaceChildren();
  const user = document.createElement('span');
  user.className = 'access-user';
  user.textContent = state.user?.email || state.user?.name || 'Signed in';
  user.title = state.user?.email || '';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'access-signout';
  button.textContent = 'Sign out';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await request('/api/auth/sign-out', {}); } catch { /* Reloading shows the current state either way. */ }
    window.location.reload();
  });
  mount.append(user, button);
  mount.hidden = false;
}

async function loadApp(state: PassengerStatus): Promise<void> {
  if (appLoaded) return;
  appLoaded = true;
  window.clearTimeout(pollTimer);
  screen.hidden = true;
  document.documentElement.classList.remove('signin-locked');
  // '/app.js' is a build output URL fetched at runtime, not a module in this TypeScript program.
  // @ts-expect-error runtime URL import, not a module in this program
  await import('/app.js');
  renderControls(state);
  document.documentElement.dataset.passenger = 'ready';
}

function showPairing(pairing: { qrSvg?: string; code?: string }): void {
  const svg = typeof pairing.qrSvg === 'string' && /^<svg[\s>]/.test(pairing.qrSvg) && pairing.qrSvg.length <= 65536 ? pairing.qrSvg : '';
  const qr = $<HTMLImageElement>('signin-qr');
  qr.hidden = !svg;
  if (svg) qr.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  else qr.removeAttribute('src');
  $('signin-code').textContent = pairing.code || '';
  $('signin-status').textContent = 'Waiting for your phone…';
}

interface DevicePairing {
  deviceCode: string;
  code: string;
  approveUrl: string;
  qrSvg: string;
  expiresIn: number;
  interval: number;
}

function schedulePoll(pairing: DevicePairing, delaySeconds: number): void {
  const current = generation;
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(async () => {
    if (current !== generation) return;
    try {
      const result = await request<DeviceTokenResponse>('/api/auth/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: pairing.deviceCode, client_id: CLIENT_ID,
      });
      if (current !== generation) return;
      if (result.ok && result.data.access_token) {
        const adopted = await request<PassengerAdoptResponse>('/api/auth/passenger/adopt', { token: result.data.access_token });
        if (!adopted.ok) throw failure(adopted, 'The sign-in could not be completed.');
        await loadApp({ enabled: true, status: 'signed_in', user: adopted.data.user });
        return;
      }
      const error = result.data.error;
      if (error === 'authorization_pending') { schedulePoll(pairing, delaySeconds); return; }
      if (error === 'slow_down') { schedulePoll(pairing, delaySeconds + 5); return; }
      if (error === 'access_denied') {
        $('signin-status').textContent = 'The phone said no. Getting a new code…';
        window.setTimeout(() => void startPairing(), 2500);
        return;
      }
      if (error === 'expired_token') { await startPairing(); return; }
      throw failure(result, 'The sign-in service is unavailable.');
    } catch (error) {
      if (current !== generation) return;
      const message = error instanceof Error ? error.message : String(error);
      $('signin-status').textContent = `${message} Retrying…`;
      schedulePoll(pairing, Math.min(30, delaySeconds + 3));
    }
  }, Math.max(2, Math.min(30, Number(delaySeconds) || 3)) * 1000);
}

async function startPairing(): Promise<void> {
  generation += 1;
  const current = generation;
  $('signin-status').textContent = 'Getting a code…';
  try {
    const result = await request<DeviceCodeResponse>('/api/passenger/device-code', {});
    if (current !== generation) return;
    if (!result.ok) throw failure(result, 'The sign-in service is unavailable.');
    if (result.data.status === 'signed_in') { await loadApp({ enabled: true, status: 'signed_in', user: result.data.user }); return; }
    showPairing(result.data);
    schedulePoll(result.data, result.data.interval);
  } catch (error) {
    if (current !== generation) return;
    const message = error instanceof Error ? error.message : String(error);
    $('signin-status').textContent = `${message} Retrying…`;
    pollTimer = window.setTimeout(() => void startPairing(), 6000);
  }
}

async function signInHere(): Promise<void> {
  const button = $<HTMLButtonElement>('signin-self');
  button.disabled = true;
  try {
    const result = await request<SocialSignInResponse>('/api/auth/sign-in/social', { provider: 'google', callbackURL: '/' });
    if (!result.ok || !result.data.url) throw failure(result, 'Google sign-in could not start.');
    window.location.href = result.data.url;
  } catch (error) {
    $('signin-status').textContent = error instanceof Error ? error.message : String(error);
    button.disabled = false;
  }
}

async function boot(): Promise<void> {
  let state: PassengerStatus;
  try {
    const result = await request<PassengerStatus>('/api/passenger/status');
    state = result.ok ? result.data : { enabled: false };
  } catch { state = { enabled: false }; }
  if (!state.enabled || state.status === 'signed_in') { await loadApp(state); return; }
  document.documentElement.classList.add('signin-locked');
  screen.hidden = false;
  $('signin-approve-host').textContent = `${window.location.host}/approve`;
  $<HTMLButtonElement>('signin-self').hidden = !state.googleConfigured;
  $('signin-self').addEventListener('click', () => void signInHere(), { once: false });
  await startPairing();
}

window.addEventListener('pageshow', (event) => { if ((event as PageTransitionEvent).persisted && !appLoaded) void boot(); });
void boot();
