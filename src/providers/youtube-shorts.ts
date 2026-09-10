import { Innertube, Log, YTNodes } from 'youtubei.js/cf-worker';
import { YouTubeError, type YouTubeOptions } from './youtube.ts';
import type { VideoSummary } from '../types.ts';

// Shorts results carry no live flag; every Short is a recording.
export type ShortVideo = Omit<VideoSummary, 'live'>;

Log.setLevel(Log.Level.NONE);

export interface ShortsOptions extends YouTubeOptions {
  cursor?: string;
}

export interface ShortsPage {
  provider: 'youtube';
  query: string;
  videos: ShortVideo[];
  nextCursor: string | null;
}

// YouTube.js node classes differ per result type; the members read here are checked at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

function validCursor(cursor: unknown): cursor is string {
  return typeof cursor === 'string' && cursor.length <= 2048 && /^[A-Za-z0-9_%=+/-]+$/.test(cursor);
}

function thumbnailFor(node: Node, endpoint: Node): string | null {
  const thumbnails: Node[] = [...(node.thumbnail || node.thumbnails || []), ...(endpoint.payload?.thumbnail?.thumbnails || [])];
  for (const thumbnail of thumbnails) {
    try {
      const url = new URL(thumbnail.url);
      if (url.protocol === 'https:' && url.hostname === 'i.ytimg.com' && !url.username && !url.password && !url.port) return url.href;
    } catch { /* Missing artwork does not invalidate a verified Short. */ }
  }
  return null;
}

export async function searchYouTubeShorts(input: unknown, {
  cursor,
  fetch: fetchImpl = globalThis.fetch,
  createClient = options => Innertube.create(options),
}: ShortsOptions = {}): Promise<ShortsPage> {
  if (typeof input !== 'string' || !input.trim() || input.trim().length > 120 || /[\x00-\x1f\x7f]/.test(input)) {
    throw new YouTubeError('Search Shorts with between 1 and 120 characters.', 400, 'INVALID_SHORTS_QUERY');
  }
  if (cursor !== undefined && !validCursor(cursor)) {
    throw new YouTubeError('This Shorts page link is invalid. Start a new search.', 400, 'INVALID_SHORTS_CURSOR');
  }
  const query = input.trim();
  const deadline = AbortSignal.timeout(20_000);
  try {
    const client = await createClient({
      generate_session_locally: false,
      retrieve_player: false,
      fail_fast: true,
      fetch: (url, init) => fetchImpl(url, { ...init, signal: deadline }),
    });
    let memo: Node;
    let headerMemo: Node;
    if (cursor) {
      // A cursor is data for this fixed endpoint, never a caller-selected URL.
      const page: Node = await client.actions.execute('/search', { continuation: cursor, parse: true });
      memo = page.on_response_received_commands_memo;
      headerMemo = page.header_memo;
    } else {
      // YouTube.js encodes the dedicated SHORTS search filter, rather than short video duration.
      const page: Node = await client.search(query, { type: 'shorts' });
      memo = page.memo;
      headerMemo = page.page?.header_memo;
    }
    if (!memo || typeof memo.getType !== 'function') throw new Error('Missing Shorts results');
    const videos: ShortVideo[] = [];
    const seen = new Set<string>();
    for (const node of (memo.getType(YTNodes.ShortsLockupView, YTNodes.ReelItem, YTNodes.Video) as Node[]).slice(0, 100)) {
      const endpoint = node.on_tap_endpoint || node.endpoint;
      if (endpoint?.name !== 'reelWatchEndpoint') continue;
      const id = endpoint.payload?.videoId || node.video_id || node.id;
      const text = node.overlay_metadata?.primary_text || node.title;
      const title = typeof text === 'string' ? text : text?.toString();
      if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id) || seen.has(id) || !title || title === '[object Object]') continue;
      seen.add(id);
      const seconds = node.duration?.seconds;
      videos.push({
        id,
        title: title.slice(0, 300),
        channel: typeof node.author?.name === 'string' ? node.author.name.slice(0, 150) : '',
        thumbnail: thumbnailFor(node, endpoint),
        duration: typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : null,
      });
      if (videos.length === 30) break;
    }
    const headers: Node[] = headerMemo?.getType(YTNodes.ContinuationItem, YTNodes.ContinuationItemView) || [];
    const continuation = (memo.getType(YTNodes.ContinuationItem, YTNodes.ContinuationItemView) as Node[]).find(node => (
      !headers.includes(node) && /^\/?search$/.test(node.endpoint?.metadata?.api_url || '') && validCursor(node.endpoint?.payload?.token)
    ));
    return { provider: 'youtube', query, videos, nextCursor: continuation?.endpoint.payload.token || null };
  } catch (error) {
    if (error instanceof YouTubeError) throw error;
    const name = error instanceof Error ? error.name : '';
    if (deadline.aborted || name === 'AbortError' || name === 'TimeoutError') {
      throw new YouTubeError('YouTube Shorts took too long to load. Please try again.', 504, 'YOUTUBE_SHORTS_TIMEOUT');
    }
    throw new YouTubeError('YouTube Shorts are unavailable right now. Try another search.', 502, 'YOUTUBE_SHORTS_UNAVAILABLE');
  }
}
