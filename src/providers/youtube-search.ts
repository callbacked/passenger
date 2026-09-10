import { Innertube, Log } from 'youtubei.js/cf-worker';
import { YouTubeError, type YouTubeOptions } from './youtube.ts';
import type { VideoSummary } from '../types.ts';

Log.setLevel(Log.Level.NONE);

export interface SearchPage {
  provider: 'youtube';
  query: string;
  videos: VideoSummary[];
}

// YouTube.js exposes rich node classes; only these loosely typed members are read, each checked at runtime.
interface SearchVideo {
  video_id?: unknown;
  title?: unknown;
  author?: { name?: unknown };
  duration?: { seconds?: unknown };
  is_live?: unknown;
  thumbnails?: unknown;
}

function thumbnailFor(thumbnails: unknown): string | null {
  if (!Array.isArray(thumbnails)) return null;
  const items = thumbnails as { width?: number; url?: string }[];
  const ordered = items.filter(thumbnail => typeof thumbnail.width === 'number' && thumbnail.width >= 320 && thumbnail.width <= 640);
  for (const thumbnail of [...ordered, ...items]) {
    try {
      const url = new URL(String(thumbnail.url));
      if (url.protocol === 'https:' && url.hostname === 'i.ytimg.com' && !url.username && !url.password && !url.port) return url.href;
    } catch { /* Omit malformed image references from otherwise useful video results. */ }
  }
  return null;
}

export async function searchYouTube(input: unknown, {
  fetch: fetchImpl = globalThis.fetch,
  createClient = options => Innertube.create(options),
}: YouTubeOptions = {}): Promise<SearchPage> {
  if (typeof input !== 'string' || !input.trim() || input.trim().length > 120 || /[\x00-\x1f\x7f]/.test(input)) {
    throw new YouTubeError('Search with between 1 and 120 characters.', 400, 'INVALID_SEARCH');
  }
  const query = input.trim();
  try {
    const client = await createClient({
      generate_session_locally: false,
      retrieve_player: false,
      fail_fast: true,
      fetch: (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) }),
    });
    const result = await client.search(query, { type: 'video' });
    const found = result.videos as unknown;
    if (!Array.isArray(found)) throw new Error('Missing search results');
    const videos: VideoSummary[] = [];
    const seen = new Set<string>();
    for (const video of (found as SearchVideo[]).slice(0, 100)) {
      const id = video.video_id;
      const title = typeof video.title === 'string' ? video.title : video.title?.toString();
      if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id) || seen.has(id) || !title || title === '[object Object]') continue;
      seen.add(id);
      const seconds = video.duration?.seconds;
      videos.push({
        id,
        title: title.slice(0, 300),
        channel: typeof video.author?.name === 'string' ? video.author.name.slice(0, 150) : '',
        duration: typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
        live: video.is_live === true,
        thumbnail: thumbnailFor(video.thumbnails),
      });
      if (videos.length === 12) break;
    }
    return { provider: 'youtube', query, videos };
  } catch (error) {
    if (error instanceof YouTubeError) throw error;
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new YouTubeError('YouTube search took too long. Please try again.', 504, 'YOUTUBE_SEARCH_TIMEOUT');
    }
    throw new YouTubeError('YouTube search is unavailable right now. Try again or paste a video link.', 502, 'YOUTUBE_SEARCH_UNAVAILABLE');
  }
}
