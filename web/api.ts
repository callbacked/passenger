// Shared shapes for JSON payloads exchanged with the Worker (see src/app.js, src/account.js,
// src/account-feeds.js, src/auth.js, src/providers/*.js for the server side of each contract).

export type ProviderId = 'youtube' | 'twitch';

/** A resolved, signed, playable source returned by POST /api/resolve. */
export interface PlaybackSource {
  provider: ProviderId;
  id: string;
  title: string;
  channel: string;
  live: boolean;
  duration: number;
  type: 'mp4' | 'hls';
  streamUrl: string;
  expiresAt: number;
}

/** One video/short entry as returned by search, Shorts, and account feed endpoints. */
export interface VideoSummary {
  id: string;
  title: string;
  channel?: string;
  thumbnail: string | null;
  duration: number | null;
  live: boolean;
}

/** POST /api/search response. */
export interface SearchResponse {
  provider: ProviderId;
  query: string;
  videos: VideoSummary[];
}

/** POST /api/shorts response. */
export interface ShortsResponse {
  provider: ProviderId;
  query: string;
  videos: VideoSummary[];
  nextCursor: string | null;
}

/** POST /api/account/feed response (both browse feeds and the Shorts reel sequence). */
export interface AccountFeedResponse {
  provider: ProviderId;
  feed: string;
  videos: VideoSummary[];
  nextCursor: string | null;
}

/** GET /api/health response. */
export interface HealthResponse {
  ok: boolean;
  runtime?: string;
  providers?: string[];
  configured?: boolean;
}

/** A generic error body shape used across every JSON endpoint on failure. */
export interface ApiErrorPayload {
  error?: string;
  error_description?: string;
  message?: string;
  code?: string;
  status?: string;
}

// --- YouTube account connection (public/account.js, GET/POST /api/account/*) ---

export interface AccountPendingState {
  status: 'pending';
  client?: string;
  userCode?: string;
  verificationUrl?: string;
  activationUrl?: string;
  qrSvg?: string;
  expiresAt?: number;
  pollAfter?: number;
}

export interface AccountConnectedState {
  status: 'connected';
  client?: string;
  expiresAt?: number;
}

export interface AccountSignedOutState {
  status: 'signed_out';
  client?: string;
}

export type AccountState = AccountPendingState | AccountConnectedState | AccountSignedOutState;

/** The extra outcomes /api/account/poll can report beyond the steady states above. */
export type AccountPollResult = AccountState | { status: 'expired' | 'denied'; client?: string };

// --- Passenger sign-in (public/gate.js, public/approve.html) ---

export interface PassengerUser {
  email?: string;
  name?: string;
}

/** GET /api/passenger/status response. `status`/`user` are absent when sign-in is disabled. */
export interface PassengerStatus {
  enabled: boolean;
  googleConfigured?: boolean;
  status?: 'signed_in' | 'signed_out';
  user?: PassengerUser;
}

export interface DeviceCodePending {
  status: 'pending';
  deviceCode: string;
  code: string;
  approveUrl: string;
  qrSvg: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceCodeSignedIn {
  status: 'signed_in';
  user: PassengerUser;
}

/** POST /api/passenger/device-code response. */
export type DeviceCodeResponse = DeviceCodePending | DeviceCodeSignedIn;

/** POST /api/auth/device/token response (Better Auth's device authorization plugin, RFC 8628). */
export interface DeviceTokenResponse {
  access_token?: string;
  error?: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | string;
  error_description?: string;
}

/** POST /api/auth/passenger/adopt response. */
export interface PassengerAdoptResponse {
  user: PassengerUser;
}

/** POST /api/auth/sign-in/social response. */
export interface SocialSignInResponse {
  url?: string;
}

/** GET /api/auth/device?user_code=... response (approve.html's own status check). */
export interface DeviceStatusResponse {
  status?: string;
}
