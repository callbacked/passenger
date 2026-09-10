import type { DeviceStatusResponse, PassengerStatus, SocialSignInResponse } from './api.ts';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}.`);
  return element as T;
}

class ApproveApiError extends Error {
  code?: string;
  status: number;

  constructor(message: string, code: string | undefined, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const params = new URLSearchParams(window.location.search);
const clean = (value: string | null): string => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
const format = (value: string): string => value.length > 3 ? `${value.slice(0, 3)}-${value.slice(3)}` : value;
let code = clean(params.get('user_code') || params.get('code'));
const sections = ['loading', 'signin', 'confirm', 'result'];
const show = (name: string): void => { sections.forEach((id) => { $(id).hidden = id !== name; }); };
const message = (text: string | undefined): void => { $('message').textContent = text || ''; };

async function api<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as {
    error_description?: string; message?: string; error?: string; code?: string;
  };
  if (!response.ok) {
    throw new ApproveApiError(
      data.error_description || data.message || (typeof data.error === 'string' && data.error) || 'Something went wrong.',
      data.error || data.code,
      response.status,
    );
  }
  return data as T;
}

function result(title: string, copy: string, done: boolean): void {
  show('result');
  $('result-title').textContent = title;
  $('result-copy').textContent = copy;
  $('result-open').hidden = !done;
}

function explain(error: unknown): string {
  const err = error instanceof Error ? error : new Error(String(error));
  const code = err instanceof ApproveApiError ? err.code : undefined;
  if (/invalid_user_code|INVALID/i.test(code || '') || /invalid/i.test(err.message)) return 'That code is not valid. Check the screen and try again.';
  if (/expired/i.test(code || err.message)) return 'That code expired. Get a fresh code on the screen you scanned.';
  if (/already/i.test(err.message)) return 'That code was already used. Get a fresh code on the screen you scanned.';
  return err.message;
}

async function startGoogle(): Promise<void> {
  $<HTMLButtonElement>('continue').disabled = true;
  try {
    const target = new URL('/approve', window.location.origin);
    if (code) target.searchParams.set('user_code', code);
    const data = await api<SocialSignInResponse>('/api/auth/sign-in/social', { provider: 'google', callbackURL: `${target.pathname}${target.search}` });
    if (!data.url) throw new Error('Google sign-in could not start.');
    window.location.href = data.url;
  } catch (error) {
    message(error instanceof Error ? error.message : String(error));
    $<HTMLButtonElement>('continue').disabled = false;
  }
}

async function decide(action: 'approve' | 'deny'): Promise<void> {
  $<HTMLButtonElement>('approve').disabled = true;
  $<HTMLButtonElement>('deny').disabled = true;
  message('');
  try {
    // Verifying claims the code for this account; approve or deny then finishes it.
    const status = await api<DeviceStatusResponse>(`/api/auth/device?user_code=${encodeURIComponent(code)}`);
    if (status.status && status.status !== 'pending') throw new Error('That code was already used. Get a fresh code on the screen you scanned.');
    await api(`/api/auth/device/${action}`, { userCode: code });
    if (action === 'approve') result('Done', 'The screen you scanned is signing in now. You can put your phone away.', true);
    else result('Denied', 'That screen was not signed in. Close this page.', false);
  } catch (error) {
    message(explain(error));
    $<HTMLButtonElement>('approve').disabled = false;
    $<HTMLButtonElement>('deny').disabled = false;
  }
}

async function boot(): Promise<void> {
  let state: PassengerStatus = { enabled: false };
  try { state = await api<PassengerStatus>('/api/passenger/status'); } catch { /* Handled below. */ }
  if (!state.enabled) { result('Not set up yet', 'Sign-in is not configured on this Passenger.', false); return; }
  if (state.status === 'signed_in') {
    if (!code) { show('signin'); $<HTMLFormElement>('form').hidden = true; message('Open this page from the QR code on the screen you want to sign in.'); return; }
    show('confirm');
    $('who').textContent = state.user?.email || state.user?.name || 'your account';
    $('code-display').textContent = format(code);
    return;
  }
  show('signin');
  $<HTMLInputElement>('code').value = format(code);
  if (!state.googleConfigured) { $<HTMLButtonElement>('continue').disabled = true; message('Google sign-in is not configured yet.'); }
  if (!code) $<HTMLInputElement>('code').focus();
}

$<HTMLInputElement>('code').addEventListener('input', () => {
  const input = $<HTMLInputElement>('code');
  input.value = format(clean(input.value));
});
$<HTMLFormElement>('form').addEventListener('submit', (event) => {
  event.preventDefault();
  code = clean($<HTMLInputElement>('code').value);
  if (code.length !== 6) { $<HTMLInputElement>('code').focus(); return; }
  void startGoogle();
});
$('approve').addEventListener('click', () => void decide('approve'));
$('deny').addEventListener('click', () => void decide('deny'));
$('switch').addEventListener('click', async () => {
  try { await api('/api/auth/sign-out', {}); } catch { /* Continue to Google either way. */ }
  show('signin');
  $<HTMLInputElement>('code').value = format(code);
  void startGoogle();
});
void boot();
