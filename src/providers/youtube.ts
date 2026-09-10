import { Innertube, Log } from 'youtubei.js/cf-worker';
import type { FetchLike, LogEvent, Playback, ResolveOptions } from '../types.ts';

Log.setLevel(Log.Level.NONE);

export type ClientOptions = NonNullable<Parameters<typeof Innertube.create>[0]>;
export type ClientFactory = (options: ClientOptions) => Promise<Innertube>;

export interface YouTubeOptions extends ResolveOptions {
  fetch?: FetchLike;
  createClient?: ClientFactory;
  log?: LogEvent;
}

export class YouTubeError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 502, code = 'YOUTUBE_UNAVAILABLE') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function youtubeId(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) {
    throw new YouTubeError('Enter a YouTube video link or video ID.', 400, 'INVALID_VIDEO');
  }
  const value = input.trim();
  if (/^[\w-]{11}$/.test(value)) return value;
  let url: URL | undefined;
  try {
    const link = /^(?:(?:www\.|m\.)?youtube\.com|youtu\.be)\//i.test(value) ? `https://${value}` : value;
    url = new URL(link);
  } catch { /* The error below also covers malformed URLs. */ }
  if (url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
    const host = url.hostname.toLowerCase();
    let id: string | null | undefined;
    if (host === 'youtu.be') id = url.pathname.split('/')[1];
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(host)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else if (/^\/(shorts|live|embed)\//.test(url.pathname)) id = url.pathname.split('/')[2];
    }
    if (id && /^[\w-]{11}$/.test(id)) return id;
  }
  throw new YouTubeError('Enter a YouTube video link or video ID.', 400, 'INVALID_VIDEO');
}

// Only serialized session data is shared, never an in-flight network request.
const sessionCache = new Map<string, { value: ArrayBuffer; expires: number }>();
const cache: NonNullable<ClientOptions['cache']> = {
  cache_dir: '',
  async get(key: string) {
    const entry = sessionCache.get(key);
    if (entry && entry.expires > Date.now()) return entry.value;
    sessionCache.delete(key);
    return undefined;
  },
  async set(key: string, value: ArrayBuffer) {
    if (sessionCache.size >= 4) sessionCache.delete(sessionCache.keys().next().value as string);
    sessionCache.set(key, { value, expires: Date.now() + 3_600_000 });
  },
  async remove(key: string) { sessionCache.delete(key); },
};

export async function resolveYouTube(input: unknown, {
  fetch: fetchImpl = globalThis.fetch,
  createClient = options => Innertube.create(options),
  youtubeClient,
  log = event => console.log(event),
}: YouTubeOptions = {}): Promise<Playback> {
  const id = youtubeId(input);
  try {
    let info: Awaited<ReturnType<Innertube['getBasicInfo']>> | undefined;
    let accountTried = false;
    let accountError = '';
    if (youtubeClient) {
      // YouTube's bot check is about address reputation; a signed-in session passes where anonymous datacenter requests are refused.
      try {
        const client = await youtubeClient();
        if (client) {
          info = await client.getBasicInfo(id, { client: 'VISIONOS' });
          accountTried = true;
          log({ event: 'youtube.resolve', id, attempt: 0, authenticated: true, status: info.playability_status?.status, reason: info.playability_status?.reason });
        }
      } catch (error) {
        accountError = error instanceof Error ? error.message : String(error);
        log({ event: 'youtube.account_resolve_failed', id, error: accountError });
      }
    }
    if (info?.playability_status?.status !== 'OK') {
      for (let attempt = 1; ; attempt++) {
        const client = await createClient({
          // After a refusal, a locally generated visitor session avoids reusing one YouTube handed a flagged address.
          generate_session_locally: attempt > 1,
          retrieve_player: false,
          fail_fast: true,
          cache,
          fetch: (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) }),
        });
        // A real VISIONOS session exposes complete public HLS without player-script execution.
        info = await client.getBasicInfo(id, { client: 'VISIONOS' });
        log({ event: 'youtube.resolve', id, attempt, authenticated: false, status: info.playability_status?.status, reason: info.playability_status?.reason });
        if (info.playability_status?.status !== 'LOGIN_REQUIRED' || attempt >= 2) break;
        // YouTube challenges some sessions as bots; a fresh session usually passes on the next try.
        sessionCache.clear();
      }
    }
    if (!info) throw new Error('No playability response');
    if (info.playability_status?.status !== 'OK') {
      const refused = info.playability_status?.status === 'LOGIN_REQUIRED';
      throw new YouTubeError(
        refused
          ? (accountTried
            ? 'YouTube refused this request even with your connected account. Try again in a moment.'
            : accountError
              ? `YouTube is refusing requests from the server right now (bot check), and your connected account could not be used for playback (${/status code (\d+)/.exec(accountError)?.[0] || 'error'}). Try again in a moment.`
              : 'YouTube is refusing requests from the server right now (bot check). Try again, or connect your YouTube account so playback can use it.')
          : 'This YouTube video is unavailable or restricted.',
        refused ? 503 : 404,
        refused ? 'YOUTUBE_BOT_CHECK' : 'YOUTUBE_UNAVAILABLE',
      );
    }
    const data = info.streaming_data;
    const author: unknown = info.basic_info?.author;
    const metadata = {
      provider: 'youtube' as const, id,
      title: info.basic_info?.title || 'YouTube video',
      channel: typeof author === 'string' ? author : '',
      duration: info.basic_info?.duration || 0,
      live: Boolean(info.basic_info?.is_live),
    };
    if (data?.hls_manifest_url) {
      return { ...metadata, type: 'hls', streamUrl: data.hls_manifest_url };
    }
    throw new YouTubeError('YouTube did not provide a compatible segmented stream for this video.', 422, 'YOUTUBE_FORMAT_UNAVAILABLE');
  } catch (error) {
    if (error instanceof YouTubeError) throw error;
    const name = error instanceof Error ? error.name : '';
    log({ event: 'youtube.resolve_failed', id, error: name, message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new YouTubeError('YouTube took too long to respond. Please try again.', 504, 'YOUTUBE_TIMEOUT');
    }
    throw new YouTubeError('YouTube could not load this video. Try another public video or try again later.');
  }
}
