import type { FetchLike, Playback } from '../types.ts';

// Twitch's website API is undocumented and can change independently of Helix.
// The public client identifier is also used by yt-dlp's Twitch extractor.
const CLIENT_ID = 'ue6666qo983tsx6so1t0vnawi233wa';

export interface TwitchOptions {
  fetch?: FetchLike;
}

export interface TwitchStatus {
  provider: 'twitch';
  id: string;
  channel: string;
  title: string;
  live: boolean;
  viewers: number;
}

interface ChannelStatusData {
  user: null | {
    displayName?: unknown;
    broadcastSettings?: { title?: unknown } | null;
    stream: null | { id?: unknown; viewersCount?: unknown };
  };
}

interface PlaybackTokenData {
  streamPlaybackAccessToken?: { value?: unknown; signature?: unknown } | null;
}

export class TwitchError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TwitchError';
    this.status = status;
    this.code = code;
  }
}

function normalizeChannel(channel: unknown): string {
  if (typeof channel === 'string') {
    const link = channel.match(/^https:\/\/(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]{1,25})\/?$/i);
    const name = link ? link[1] : channel;
    if (/^[a-zA-Z0-9_]{1,25}$/.test(name)) return name.toLowerCase();
  }
  throw new TwitchError(400, 'INVALID_CHANNEL', 'Enter a Twitch channel name or an HTTPS twitch.tv channel link.');
}

async function requestText(url: string, init: RequestInit, fetchImpl: FetchLike): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403, 429].includes(response.status)) {
        throw new TwitchError(503, 'TWITCH_UNAVAILABLE', 'Twitch is restricting playback requests. Try again later.');
      }
      throw new TwitchError(502, 'TWITCH_UPSTREAM_ERROR', 'Twitch could not complete the request. Try again.');
    }
    if (!response.body) {
      throw new TwitchError(502, 'TWITCH_INVALID_RESPONSE', 'Twitch returned an empty response.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1_048_576) {
          await reader.cancel();
          throw new TwitchError(502, 'TWITCH_INVALID_RESPONSE', 'Twitch returned an unexpectedly large response.');
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof TwitchError) throw error;
    const name = error instanceof Error ? error.name : '';
    if (controller.signal.aborted || name === 'AbortError' || name === 'TimeoutError') {
      throw new TwitchError(504, 'TWITCH_TIMEOUT', 'Twitch took too long to respond. Try again.');
    }
    throw new TwitchError(502, 'TWITCH_UPSTREAM_ERROR', 'Could not reach Twitch. Try again.');
  } finally {
    clearTimeout(timer);
  }
}

async function queryTwitch<T>(query: string, channel: string, fetchImpl: FetchLike): Promise<T> {
  const text = await requestText('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-ID': CLIENT_ID },
    body: JSON.stringify({ query, variables: { channel } }),
  }, fetchImpl);
  let result: { data?: T; errors?: unknown[] } | null;
  try {
    result = JSON.parse(text) as { data?: T; errors?: unknown[] } | null;
  } catch {
    throw new TwitchError(502, 'TWITCH_INVALID_RESPONSE', 'Twitch returned an invalid response.');
  }
  if (!result?.data || result.errors?.length) {
    throw new TwitchError(502, 'TWITCH_UPSTREAM_ERROR', 'Twitch could not provide channel information. Try again later.');
  }
  return result.data;
}

export async function statusTwitch(channel: unknown, { fetch: fetchImpl = globalThis.fetch }: TwitchOptions = {}): Promise<TwitchStatus> {
  const id = normalizeChannel(channel);
  const data = await queryTwitch<ChannelStatusData>(`query ChannelStatus($channel: String!) {
    user(login: $channel) {
      displayName
      broadcastSettings { title }
      stream { id viewersCount }
    }
  }`, id, fetchImpl);
  if (data.user === null) {
    throw new TwitchError(404, 'TWITCH_NOT_FOUND', 'That Twitch channel does not exist.');
  }
  const user = data.user;
  if (!user || (user.stream !== null && !user.stream?.id)) {
    throw new TwitchError(502, 'TWITCH_INVALID_RESPONSE', 'Twitch did not return channel status.');
  }
  const viewers = user.stream?.viewersCount;
  return {
    provider: 'twitch',
    id,
    channel: id,
    title: typeof user.broadcastSettings?.title === 'string' ? user.broadcastSettings.title : id,
    live: user.stream !== null,
    viewers: typeof viewers === 'number' && Number.isFinite(viewers) ? viewers : 0,
  };
}

export async function resolveTwitch(channel: unknown, { fetch: fetchImpl = globalThis.fetch }: TwitchOptions = {}): Promise<Playback & TwitchStatus> {
  const status = await statusTwitch(channel, { fetch: fetchImpl });
  if (!status.live) {
    throw new TwitchError(409, 'TWITCH_OFFLINE', 'This Twitch channel is currently offline.');
  }
  const data = await queryTwitch<PlaybackTokenData>(`query PlaybackAccessToken($channel: String!) {
    streamPlaybackAccessToken(channelName: $channel, params: {
      platform: "web", playerBackend: "mediaplayer", playerType: "site"
    }) { value signature }
  }`, status.id, fetchImpl);
  const token = data.streamPlaybackAccessToken;
  if (typeof token?.value !== 'string' || !token.value || typeof token.signature !== 'string' || !token.signature) {
    throw new TwitchError(503, 'TWITCH_PLAYBACK_UNAVAILABLE', 'Twitch did not make public playback available for this channel.');
  }
  const streamUrl = new URL(`https://usher.ttvnw.net/api/channel/hls/${status.id}.m3u8`);
  streamUrl.search = new URLSearchParams({
    sig: token.signature,
    token: token.value,
    allow_source: 'true',
    allow_audio_only: 'true',
    platform: 'web',
    player: 'twitchweb',
    supported_codecs: 'h264',
  }).toString();
  // A playback token alone does not prove that Twitch will serve the stream.
  const playlist = await requestText(streamUrl.href, {}, fetchImpl);
  if (!playlist.trimStart().startsWith('#EXTM3U') || !/^#EXT-X-STREAM-INF:[^\r\n]*\r?\n[^#\s][^\r\n]*$/m.test(playlist)) {
    throw new TwitchError(502, 'TWITCH_PLAYBACK_UNAVAILABLE', 'Twitch did not return a playable stream.');
  }
  return { ...status, streamUrl: streamUrl.href, type: 'hls' };
}
