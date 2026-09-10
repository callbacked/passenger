import type { Innertube } from 'youtubei.js/cf-worker';

export type Provider = 'youtube' | 'twitch';

// Per-request context a provider may use while resolving playback.
export interface ResolveOptions {
  // The signed-in YouTube session of this browser, tried when the anonymous request is refused.
  youtubeClient?: () => Promise<Innertube | null>;
}

// Structured log lines land in Workers Logs (`npx wrangler tail`).
export type LogEvent = (event: Record<string, unknown>) => void;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// What a provider returns before the Worker signs the stream address.
export interface Playback {
  provider: Provider;
  id: string;
  title: string;
  channel?: string;
  duration?: number;
  live: boolean;
  type: 'hls' | 'mp4';
  streamUrl: string;
}

export interface VideoSummary {
  id: string;
  title: string;
  channel: string;
  duration: number | null;
  live: boolean;
  thumbnail: string | null;
  isShort?: boolean;
}
