import type { Innertube } from 'youtubei.js/cf-worker';
import type { VideoSummary } from './types.ts';

export class AccountFeedError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type AccountFeedName = 'home' | 'subscriptions' | 'liked' | 'shorts';

export interface AccountFeedRequest {
  feed: AccountFeedName;
  cursor?: string;
  seed?: string;
}

export interface AccountFeedPage {
  provider: 'youtube';
  feed: AccountFeedName;
  videos: VideoSummary[];
  nextCursor: string | null;
}

// InnerTube responses have no published schema; nodes are walked and checked at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const browseIds: Record<Exclude<AccountFeedName, 'shorts'>, string> = { home: 'FEwhat_to_watch', subscriptions: 'FEsubscriptions', liked: 'VLLL' };

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && /^[A-Za-z0-9_%=+/-]+$/.test(value);
}

function text(value: Node): string {
  if (typeof value === 'string') return value;
  if (typeof value?.content === 'string') return value.content;
  if (typeof value?.simpleText === 'string') return value.simpleText;
  return Array.isArray(value?.runs) ? value.runs.map((run: Node) => run.text || '').join('') : '';
}

function thumbnail(sources: Node): string | null {
  for (const source of Array.isArray(sources) ? sources : []) {
    try {
      const url = new URL(source.url);
      if (url.protocol === 'https:' && url.hostname === 'i.ytimg.com' && !url.username && !url.password && !url.port) return url.href;
    } catch { /* An absent poster does not invalidate the video. */ }
  }
  return null;
}

function duration(value: Node): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const label = text(value);
  if (!/^\d{1,3}(:\d{2}){1,2}$/.test(label)) return null;
  return label.split(':').reduce((total, part) => total * 60 + Number(part), 0) || null;
}

function videoCard(key: string, node: Node): VideoSummary | null {
  let endpoint: Node;
  let id: unknown;
  let title: Node;
  let channel: Node;
  let sources: Node;
  let length: Node;
  let live = false;
  let tvShort = false;
  if (key === 'lockupViewModel') {
    tvShort = node.contentType === 'LOCKUP_CONTENT_TYPE_SHORT';
    if (!tvShort && node.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
    const context = node.rendererContext?.commandContext;
    endpoint = context?.onTap?.innertubeCommand;
    const metadata = node.metadata?.lockupMetadataViewModel;
    const picture = node.contentImage?.thumbnailViewModel;
    const badges: Node[] = picture?.overlays?.flatMap((overlay: Node) => overlay.thumbnailBottomOverlayViewModel?.badges || []) || [];
    title = metadata?.title;
    channel = context?.onLongPress?.innertubeCommand?.showMenuCommand?.subtitle
      || metadata?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text;
    sources = picture?.image?.sources;
    length = badges.map(badge => badge.thumbnailBadgeViewModel?.text).find(value => duration(value));
    live = badges.some(badge => badge.thumbnailBadgeViewModel?.badgeStyle === 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE');
    id = node.contentId;
  } else if (key === 'shortsLockupViewModel') {
    endpoint = node.onTap?.innertubeCommand || node.onTap;
    title = node.overlayMetadata?.primaryText;
    sources = node.thumbnail?.sources || node.thumbnail?.thumbnails;
  } else if (key === 'tileRenderer') {
    endpoint = node.onSelectCommand;
    title = node.metadata?.tileMetadataRenderer?.title;
    sources = node.header?.tileHeaderRenderer?.thumbnail?.thumbnails;
    length = node.header?.tileHeaderRenderer?.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text;
  } else {
    endpoint = node.navigationEndpoint;
    id = node.videoId;
    title = node.title || node.headline;
    channel = node.shortBylineText || node.longBylineText || node.ownerText;
    sources = node.thumbnail?.thumbnails;
    length = node.lengthSeconds ? Number(node.lengthSeconds) : node.lengthText;
    const overlay = node.thumbnailOverlays?.find((item: Node) => item.thumbnailOverlayTimeStatusRenderer)?.thumbnailOverlayTimeStatusRenderer;
    length ||= overlay?.text;
    live = overlay?.style === 'LIVE';
  }
  const reel = endpoint?.reelWatchEndpoint;
  const watch = reel || endpoint?.watchEndpoint;
  id = watch?.videoId || id;
  if (!watch || typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) return null;
  const label = text(title).trim();
  if (!label && !reel) return null;
  return {
    id, title: label.slice(0, 300), channel: text(channel).slice(0, 150),
    thumbnail: thumbnail(sources || reel?.thumbnail?.thumbnails),
    duration: duration(length), live, isShort: tvShort || Boolean(reel),
  };
}

interface BrowsePage {
  videos: VideoSummary[];
  nextCursor: string | null;
  firstShort: string | undefined;
}

function browsePage(data: Node): BrowsePage {
  const roots: Node[] = [data.contents, data.continuationContents, data.onResponseReceivedActions, data.onResponseReceivedCommands].filter(Boolean);
  if (!roots.length) throw new Error('Missing browse content');
  const videos: VideoSummary[] = [];
  const seen = new Set<string>();
  let firstShort: string | undefined;
  let nextCursor: string | null = null;
  let cursorDepth = Infinity;
  let visited = 0;
  let hasContent = false;
  const stack: { node: Node; depth: number }[] = roots.reverse().map(node => ({ node, depth: 0 }));
  while (stack.length) {
    const { node, depth } = stack.pop() as { node: Node; depth: number };
    if (!node || typeof node !== 'object') continue;
    if (++visited > 20_000) throw new Error('Oversized browse response');
    if (Array.isArray(node)) {
      stack.push(...node.slice().reverse().map((item: Node) => ({ node: item, depth: depth + 1 })));
      continue;
    }
    for (const [key, value] of Object.entries(node as Record<string, Node>).reverse()) {
      if (/^(sectionList|richGrid|playlistVideoList|grid|horizontalList|itemSection)(Renderer|Continuation)$/.test(key)
        || key === 'appendContinuationItemsAction') hasContent = true;
      if (/^(lockupViewModel|shortsLockupViewModel|tileRenderer|videoRenderer|gridVideoRenderer|compactVideoRenderer|playlistVideoRenderer|reelItemRenderer)$/.test(key)) {
        hasContent = true;
        const video = value && videoCard(key, value);
        if (video && !seen.has(video.id)) {
          seen.add(video.id);
          if (video.isShort && !firstShort) firstShort = video.id;
          if (videos.length < 30) videos.push(video);
        }
        continue;
      }
      if (key === 'nextContinuationData' && validToken(value?.continuation) && depth < cursorDepth) {
        nextCursor = value.continuation;
        cursorDepth = depth;
      }
      if (key === 'continuationItemRenderer') {
        const endpoint = value?.continuationEndpoint;
        if (endpoint?.continuationCommand?.request === 'CONTINUATION_REQUEST_TYPE_BROWSE'
          && validToken(endpoint.continuationCommand.token) && depth < cursorDepth) {
          nextCursor = endpoint.continuationCommand.token;
          cursorDepth = depth;
        }
        continue;
      }
      // Menus, ads, and headers contain unrelated watch commands and pagination.
      if (/^(header|menu|onLongPress|trackingParams|frameworkUpdates)$/.test(key) || /^(adSlot|inFeedAd|displayAd|promoted)/i.test(key)) continue;
      stack.push({ node: value, depth: depth + 1 });
    }
  }
  if (!hasContent) throw new Error('Unsupported browse content');
  return { videos, nextCursor, firstShort };
}

async function execute(client: Innertube, endpoint: string, parameters: Record<string, unknown>): Promise<Node> {
  const response = await client.actions.execute(endpoint, { ...parameters, client: 'TV' });
  const data: Node = response?.data;
  if (response?.status_code === 401 || data?.responseContext?.mainAppWebResponseContext?.loggedOut === true) {
    throw new AccountFeedError('Reconnect your YouTube account to load this feed.', 401, 'ACCOUNT_AUTH_EXPIRED');
  }
  if (!response?.success || !data || typeof data !== 'object' || data.error
    || data.alerts?.some((alert: Node) => alert.alertRenderer?.type === 'ERROR')) throw new Error('Account feed request failed');
  return data;
}

function isFeedRequest(body: unknown): body is AccountFeedRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const input = body as Record<string, unknown>;
  return !Object.keys(input).some(key => !['feed', 'cursor', 'seed'].includes(key))
    && typeof input.feed === 'string'
    && (input.feed === 'shorts' || Object.hasOwn(browseIds, input.feed))
    && (input.cursor === undefined || validToken(input.cursor))
    && (input.seed === undefined || (input.feed === 'shorts' && typeof input.seed === 'string' && /^[\w-]{11}$/.test(input.seed)));
}

export async function loadAccountFeed(body: unknown, client: Innertube | undefined): Promise<AccountFeedPage> {
  if (!isFeedRequest(body)) {
    throw new AccountFeedError('Choose a valid account feed and page.', 400, 'INVALID_ACCOUNT_FEED');
  }
  if (client?.session?.logged_in !== true) {
    throw new AccountFeedError('Connect your YouTube account to load this feed.', 401, 'ACCOUNT_REQUIRED');
  }
  try {
    if (body.feed !== 'shorts') {
      const page = browsePage(await execute(client, '/browse', body.cursor
        ? { continuation: body.cursor } : { browseId: browseIds[body.feed] }));
      return { provider: 'youtube', feed: body.feed, videos: page.videos, nextCursor: page.nextCursor };
    }
    let sequenceParams = body.cursor;
    if (!sequenceParams) {
      const seed = body.seed || browsePage(await execute(client, '/browse', { browseId: browseIds.home })).firstShort;
      if (!seed) throw new AccountFeedError('Choose a Short to start your account recommendations.', 409, 'ACCOUNT_SHORTS_SEED_REQUIRED');
      // Same ReelSequence protobuf as YouTube.js: shortId(1), params(5).number(3)=5, feature2(10)=25.
      sequenceParams = encodeURIComponent(btoa(String.fromCharCode(10, 11, ...new TextEncoder().encode(seed), 42, 2, 24, 5, 80, 25)));
    }
    const page = await execute(client, '/reel/reel_watch_sequence', { sequenceParams });
    if (!Array.isArray(page.entries)) throw new Error('Missing reel sequence');
    const seen = new Set<string>();
    const videos: VideoSummary[] = [];
    for (const entry of page.entries.slice(0, 100) as Node[]) {
      const endpoint = entry.command?.reelWatchEndpoint;
      const id = endpoint?.videoId;
      if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      videos.push({
        id, title: '', channel: '', thumbnail: thumbnail(endpoint.thumbnail?.thumbnails),
        duration: null, live: false, isShort: true,
      });
      if (videos.length === 30) break;
    }
    return { provider: 'youtube', feed: body.feed, videos, nextCursor: validToken(page.continuation) ? page.continuation : null };
  } catch (error) {
    if (error instanceof AccountFeedError) throw error;
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new AccountFeedError('Your YouTube feed took too long to load. Please try again.', 504, 'ACCOUNT_FEED_TIMEOUT');
    }
    throw new AccountFeedError('YouTube could not load this account feed. Please try again.', 502, 'ACCOUNT_FEED_UNAVAILABLE');
  }
}
