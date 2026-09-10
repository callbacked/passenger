import type { AccountFeedResponse, AccountPollResult, AccountState } from './api.ts';

class AccountRequestError extends Error {
  code?: string;
  retryAfter: number;

  constructor(message: string, code: string | undefined, retryAfter: number) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

let accountState: AccountState = { status: 'signed_out' };
let notifyState: (next: AccountState) => void = () => {};
let pollTimer: number | undefined;
let dialog: HTMLDialogElement;
let openButton: HTMLButtonElement;
let busy = false;
let sequence = 0;

function requireQuery<T extends Element = HTMLElement>(scope: ParentNode, selector: string): T {
  const found = scope.querySelector<T>(selector);
  if (!found) throw new Error(`Expected an element matching "${selector}".`);
  return found;
}

async function accountRequest<T>(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/account/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin', cache: 'no-store', signal,
  });
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new Error('The account service is unavailable. Try again.'); }
  if (!response.ok) {
    const payload = (data && typeof data === 'object' ? data : {}) as { status?: string; error?: string; code?: string };
    if (response.status === 401 && payload.status !== 'pending' && dialog) {
      sequence += 1;
      clearTimeout(pollTimer);
      applyState({ status: 'signed_out' });
    }
    throw new AccountRequestError(
      typeof payload.error === 'string' ? payload.error : 'The account request failed. Try again.',
      payload.code,
      Number(response.headers.get('Retry-After')) || 0,
    );
  }
  return data as T;
}

export async function fetchAccountFeed({ feed, cursor, seed }: { feed?: string; cursor?: string | null; seed?: string | null } = {}): Promise<AccountFeedResponse> {
  return accountRequest<AccountFeedResponse>('feed', { feed, ...(cursor ? { cursor } : {}), ...(seed ? { seed } : {}) }, AbortSignal.timeout(30_000));
}

function safeGoogleUrl(value: string | undefined): string {
  try {
    const url = new URL(value ?? '');
    if (url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'google.com' || url.hostname.endsWith('.google.com') || url.hostname === 'g.co')) return url.href;
  } catch { /* Never navigate to an unexpected activation address. */ }
  return '';
}

function showMessage(message: string): void {
  requireQuery(dialog, '[data-account-message]').textContent = message;
}

function applyState(next: AccountState): void {
  accountState = next;
  const connected = next.status === 'connected';
  const pending = next.status === 'pending';
  openButton.textContent = connected ? 'YouTube connected' : pending ? 'Finish connecting' : 'Connect YouTube';
  requireQuery(dialog, '[data-account-intro]').hidden = connected || pending;
  requireQuery(dialog, '[data-account-pending]').hidden = !pending;
  requireQuery(dialog, '[data-account-connected]').hidden = !connected;
  requireQuery(dialog, '[data-account-start]').hidden = connected || pending;
  requireQuery(dialog, '[data-account-disconnect]').hidden = !connected && !pending;
  requireQuery(dialog, '[data-account-disconnect]').textContent = pending ? 'Cancel connection' : 'Disconnect this browser';
  if (next.status === 'pending') {
    requireQuery(dialog, '[data-account-code]').textContent = next.userCode || 'Connection pending';
    const link = requireQuery<HTMLAnchorElement>(dialog, '[data-account-link]');
    const verification = safeGoogleUrl(next.activationUrl) || safeGoogleUrl(next.verificationUrl);
    link.hidden = !verification;
    if (verification) link.href = verification;
    else link.removeAttribute('href');
    const qr = requireQuery<HTMLImageElement>(dialog, '[data-account-qr]');
    const svg = typeof next.qrSvg === 'string' && /^<svg[\s>]/.test(next.qrSvg) && next.qrSvg.length <= 65536 ? next.qrSvg : '';
    // An image data URL draws the SVG without running anything it could contain.
    qr.hidden = !svg;
    if (svg) qr.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    else qr.removeAttribute('src');
  }
  notifyState(next);
}

function schedulePoll(): void {
  clearTimeout(pollTimer);
  if (accountState.status !== 'pending') return;
  const delay = Math.max(5, Math.min(60, Number(accountState.pollAfter) || 5)) * 1000;
  const current = sequence;
  pollTimer = window.setTimeout(async () => {
    try {
      const result = await accountRequest<AccountPollResult>('poll', {}, AbortSignal.timeout(20_000));
      if (current !== sequence) return;
      // A switch (rather than an if/else on result.status) is required here: this compiler
      // only narrows away the expired|denied member of AccountPollResult case-by-case.
      switch (result.status) {
        case 'expired':
        case 'denied':
          applyState({ status: 'signed_out' });
          showMessage(result.status === 'expired' ? 'The code expired. Start a new connection.' : 'The connection was declined. You can try again.');
          return;
        default:
          applyState(result);
          showMessage(result.status === 'connected' ? 'Connected. Your account feeds are now available in the navigation.' : 'Waiting for Google approval…');
          schedulePoll();
      }
    } catch (error) {
      if (current !== sequence) return;
      showMessage(error instanceof Error ? error.message : String(error));
      const retryAfter = error instanceof AccountRequestError ? error.retryAfter : 0;
      if (retryAfter > 0 && accountState.status === 'pending') accountState = { ...accountState, pollAfter: retryAfter };
      const expiresAt = accountState.status === 'pending' ? accountState.expiresAt : undefined;
      if (Number(expiresAt) > Date.now()) schedulePoll();
      else applyState({ status: 'signed_out' });
    }
  }, delay);
}

export function initAccount({ onState = () => {} }: { onState?: (next: AccountState) => void } = {}): void {
  const mount = document.getElementById('account-controls');
  if (!mount || dialog) return;
  notifyState = onState;
  const styles = document.createElement('link');
  styles.rel = 'stylesheet';
  styles.href = '/account.css';
  document.head.append(styles);
  openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'account-open';
  openButton.textContent = 'Connect YouTube';
  mount.append(openButton);
  dialog = document.createElement('dialog');
  dialog.className = 'account-dialog';
  dialog.setAttribute('aria-labelledby', 'account-dialog-title');
  dialog.innerHTML = `
    <div class="account-dialog-heading"><h2 id="account-dialog-title">Your YouTube account</h2><button type="button" class="account-close" aria-label="Close account dialog">×</button></div>
    <div data-account-intro>
      <p>Connect with Google's YouTube on TV pairing. On your phone, choose the Google account you want to use here.</p>
      <p class="account-note">Google will show the TV permissions it requests. Passenger uses the connection to read your feeds. Watching here does not update your YouTube history.</p>
    </div>
    <div data-account-pending hidden>
      <p>Point your phone camera at this code, then approve with the account you want to use here.</p>
      <div class="account-pairing">
        <img class="account-qr" data-account-qr width="200" height="200" alt="QR code that opens Google activation with your code filled in" hidden>
        <div class="account-pairing-manual">
          <p class="account-note">No camera? Open Google on your phone and enter this code:</p>
          <strong class="account-code" data-account-code></strong>
          <a class="account-primary" data-account-link target="_blank" rel="noopener noreferrer">Open Google activation ↗</a>
        </div>
      </div>
      <p class="account-note">This window updates automatically after approval.</p>
    </div>
    <div data-account-connected hidden>
      <p>Your YouTube account is connected to this browser.</p>
      <p class="account-note">Use Home, Subscriptions, Liked videos, or Shorts to browse your account. Disconnecting removes the connection stored for this browser.</p>
    </div>
    <p class="account-message" data-account-message role="status" aria-live="polite"></p>
    <div class="account-actions"><button type="button" class="account-primary" data-account-start>Get connection code</button><button type="button" class="account-secondary" data-account-disconnect hidden>Disconnect this browser</button></div>`;
  document.body.append(dialog);
  const refreshStatus = async (): Promise<void> => {
    const current = sequence;
    try {
      const result = await accountRequest<AccountState>('status', undefined, AbortSignal.timeout(10_000));
      if (current !== sequence) return;
      applyState(result);
      schedulePoll();
    } catch { /* Public browsing remains available without an account connection. */ }
  };
  openButton.addEventListener('click', () => { dialog.showModal(); void refreshStatus(); });
  requireQuery<HTMLButtonElement>(dialog, '.account-close').addEventListener('click', () => dialog.close());
  requireQuery<HTMLButtonElement>(dialog, '[data-account-start]').addEventListener('click', async (event) => {
    if (busy) return;
    busy = true;
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    sequence += 1;
    const current = sequence;
    showMessage('Getting a connection code…');
    try {
      const result = await accountRequest<AccountState>('start', {}, AbortSignal.timeout(30_000));
      if (current !== sequence) return;
      applyState(result);
      showMessage(result.status === 'connected' ? 'Connected.' : 'Waiting for Google approval…');
      schedulePoll();
    } catch (error) { showMessage(error instanceof Error ? error.message : String(error)); }
    finally { busy = false; requireQuery<HTMLButtonElement>(dialog, '[data-account-start]').disabled = false; }
  });
  requireQuery<HTMLButtonElement>(dialog, '[data-account-disconnect]').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    sequence += 1;
    clearTimeout(pollTimer);
    showMessage('Disconnecting…');
    try {
      await accountRequest('disconnect', {}, AbortSignal.timeout(20_000));
      applyState({ status: 'signed_out' });
      showMessage('Disconnected from this browser.');
    } catch (error) { showMessage(error instanceof Error ? error.message : String(error)); schedulePoll(); }
    finally { busy = false; }
  });
  window.addEventListener('pagehide', () => { sequence += 1; clearTimeout(pollTimer); });
  window.addEventListener('pageshow', (event) => { if ((event as PageTransitionEvent).persisted) void refreshStatus(); });
  void refreshStatus();
}
