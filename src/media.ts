import type { Env } from './env.ts';
import type { FetchLike, Provider } from './types.ts';

const encoder = new TextEncoder();
const mediaDomains: Record<Provider, string> = { youtube: 'googlevideo.com', twitch: 'ttvnw.net' };

export interface MediaPayload {
  url: string;
  provider: Provider;
  expiresAt: number;
}

class MediaError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && Object.hasOwn(mediaDomains, value);
}

function validateUpstream(value: string, provider: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaError(400, 'MEDIA_INVALID_URL', 'The media address is invalid.');
  }
  const domain = isProvider(provider) ? mediaDomains[provider] : undefined;
  if (!domain || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !(url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw new MediaError(403, 'MEDIA_FORBIDDEN_URL', 'The media address is not allowed for this provider.');
  }
  return url;
}

async function signingKey(secret: string | undefined): Promise<CryptoKey> {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new MediaError(503, 'MEDIA_NOT_CONFIGURED', 'Media playback is not configured.');
  }
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function encodeBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[\w-]+$/.test(value) || value.length % 4 === 1) throw new Error('Invalid encoding');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) throw new Error('Invalid encoding');
  return bytes;
}

function validateExpiry(expiresAt: unknown): asserts expiresAt is number {
  if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) <= 0) {
    throw new MediaError(400, 'MEDIA_INVALID_TOKEN', 'The media link is invalid.');
  }
  if ((expiresAt as number) <= Date.now()) {
    throw new MediaError(403, 'MEDIA_EXPIRED', 'This media link has expired. Load the video again.');
  }
}

async function signMediaUrl(url: string, provider: Provider, expiresAt: number, origin: string, key: CryptoKey): Promise<string> {
  validateExpiry(expiresAt);
  const upstream = validateUpstream(url, provider);
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({ url: upstream.href, provider, expiresAt })));
  // SHA-256 signatures encode to 43 characters, plus the separating dot.
  if (payload.length + 44 > 8192) {
    throw new MediaError(400, 'MEDIA_INVALID_URL', 'The media address is too long.');
  }
  const signature = encodeBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  const result = new URL('/api/media', origin);
  if (!['https:', 'http:'].includes(result.protocol) || result.username || result.password) {
    throw new MediaError(400, 'MEDIA_INVALID_ORIGIN', 'The player address is invalid.');
  }
  result.searchParams.set('token', `${payload}.${signature}`);
  return result.href;
}

export async function createMediaUrl(upstreamUrl: string,
  { provider, origin, secret, expiresAt }: { provider: Provider; origin: string; secret: string | undefined; expiresAt: number }): Promise<string> {
  return signMediaUrl(upstreamUrl, provider, expiresAt, origin, await signingKey(secret));
}

async function verifyToken(token: unknown, key: CryptoKey): Promise<MediaPayload> {
  if (typeof token !== 'string' || token.length > 8192) {
    throw new MediaError(400, 'MEDIA_INVALID_TOKEN', 'The media link is invalid.');
  }
  let payload: { url: string; provider: string; expiresAt: unknown };
  try {
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error('Invalid token');
    const signature = decodeBase64Url(parts[1]);
    const bytes = decodeBase64Url(parts[0]);
    if (signature.byteLength !== 32 || !await crypto.subtle.verify('HMAC', key, signature, encoder.encode(parts[0]))) {
      throw new Error('Invalid signature');
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { url?: unknown }).url !== 'string' ||
        typeof (parsed as { provider?: unknown }).provider !== 'string') throw new Error('Invalid payload');
    payload = parsed as { url: string; provider: string; expiresAt: unknown };
  } catch {
    throw new MediaError(403, 'MEDIA_INVALID_TOKEN', 'The media link is invalid.');
  }
  validateExpiry(payload.expiresAt);
  validateUpstream(payload.url, payload.provider);
  return { url: payload.url, provider: payload.provider as Provider, expiresAt: payload.expiresAt };
}

interface UpstreamMedia {
  response: Response;
  url: string;
  finish: () => void;
}

async function fetchMedia(url: string, provider: Provider, request: Request, fetchImpl: FetchLike): Promise<UpstreamMedia> {
  const headers = new Headers();
  for (const name of ['Range', 'If-Range']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  let upstream = validateUpstream(url, provider);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const finish = () => clearTimeout(timer);
    let response: Response;
    try {
      response = await fetchImpl(upstream.href, { method: request.method, headers, redirect: 'manual', signal: controller.signal });
    } catch (error) {
      finish();
      throw error;
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      finish();
      await response.body?.cancel();
      const location = response.headers.get('Location');
      if (redirects === 3 || !location) {
        throw new MediaError(502, 'MEDIA_UPSTREAM_ERROR', 'The media provider could not serve this stream.');
      }
      upstream = validateUpstream(new URL(location, upstream).href, provider);
      continue;
    }
    return { response, url: upstream.href, finish };
  }
  throw new MediaError(502, 'MEDIA_UPSTREAM_ERROR', 'The media provider could not serve this stream.');
}

async function readManifest(response: Response): Promise<string> {
  if (!response.body) throw new MediaError(502, 'MEDIA_INVALID_MANIFEST', 'The media provider returned an empty playlist.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2_097_152) {
        await reader.cancel();
        throw new MediaError(502, 'MEDIA_INVALID_MANIFEST', 'The media provider returned an oversized playlist.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!/^#EXTM3U(?:\r?\n|$)/.test(text) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    throw new MediaError(502, 'MEDIA_INVALID_MANIFEST', 'The media provider returned an invalid playlist.');
  }
  return text;
}

type Attributes = Map<string, string>;

function hlsAttributes(line: string): Attributes {
  const text = line.slice(line.indexOf(':') + 1);
  const attributes: Attributes = new Map();
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^",]+)(?:,|$)/gy;
  while (pattern.lastIndex < text.length) {
    const match = pattern.exec(text);
    if (!match || attributes.has(match[1])) {
      throw new MediaError(502, 'MEDIA_INVALID_MANIFEST', 'The media provider returned invalid playlist attributes.');
    }
    attributes.set(match[1], match[2].startsWith('"') ? match[2].slice(1, -1) : match[2]);
  }
  return attributes;
}

function setHlsAttribute(line: string, name: string, value: string): string {
  const start = line.indexOf(':') + 1;
  let replaced = false;
  const attributes = line.slice(start).replace(/([A-Z0-9-]+)=(?:"[^"]*"|[^",]+)(?:,|$)/g, (field: string, key: string) => {
    if (key !== name) return field;
    replaced = true;
    return `${name}=${value}${field.endsWith(',') ? ',' : ''}`;
  });
  return line.slice(0, start) + attributes + (replaced ? '' : `,${name}=${value}`);
}

function filterYouTubeMaster(text: string): string {
  const lines = text.split(/\r?\n/);
  if (!lines.some(line => /^#EXT-X-(?:STREAM-INF|I-FRAME-STREAM-INF):/.test(line.trim()))) return text;

  const variants: { index: number; uriIndex: number; attributes: Attributes }[] = [];
  const renditions = new Map<number, Attributes>();
  const removed = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line.startsWith('#EXT-X-MEDIA:')) renditions.set(index, hlsAttributes(line));
    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) removed.add(index);
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    let uriIndex = index + 1;
    while (uriIndex < lines.length && !lines[uriIndex].trim()) uriIndex++;
    if (uriIndex === lines.length || lines[uriIndex].trim().startsWith('#')) {
      throw new MediaError(502, 'MEDIA_INVALID_MANIFEST', 'The media provider returned an incomplete playlist variant.');
    }
    variants.push({ index, uriIndex, attributes: hlsAttributes(line) });
    removed.add(index);
    removed.add(uriIndex);
  }

  const audioGroups = new Set([...renditions.values()]
    .filter(attributes => attributes.get('TYPE') === 'AUDIO').map(attributes => attributes.get('GROUP-ID')));
  const usedGroups = new Set<string>();
  let compatible = 0;
  for (const { index, uriIndex, attributes } of variants) {
    const resolution = attributes.get('RESOLUTION')?.match(/^(\d+)x(\d+)$/);
    const codecs = attributes.get('CODECS')?.split(',').map(codec => codec.trim()) || [];
    const audio = attributes.get('AUDIO');
    // Bound software decoding, including every variant the player can switch to.
    if (!resolution || Number(resolution[1]) <= 0 || Number(resolution[2]) <= 0 || Number(resolution[2]) > 480 ||
        codecs.length !== 2 || !codecs.some(codec => /^avc1\.[0-9a-f]{6}$/i.test(codec)) || !codecs.includes('mp4a.40.2') ||
        attributes.has('VIDEO') || audio !== undefined && !audioGroups.has(audio)) continue;
    compatible++;
    removed.delete(index);
    removed.delete(uriIndex);
    // Caption playlists lead outside the media CDN and this player has no subtitle controls.
    lines[index] = lines[index].trim().replace(/([A-Z0-9-]+)=("[^"]*"|[^",]+)(?:,|$)/g,
      (field: string, name: string) => name === 'SUBTITLES' ? '' : field).replace(/,$/, '');
    for (const type of ['AUDIO', 'CLOSED-CAPTIONS']) {
      const group = attributes.get(type);
      if (group && group !== 'NONE') usedGroups.add(`${type}:${group}`);
    }
  }
  if (!compatible) {
    throw new MediaError(502, 'YOUTUBE_FORMAT_UNAVAILABLE', 'This YouTube video has no compatible stream at 480p or lower. Try another video.');
  }
  for (const [index, attributes] of renditions) {
    if (!usedGroups.has(`${attributes.get('TYPE')}:${attributes.get('GROUP-ID')}`)) removed.add(index);
  }
  for (const group of audioGroups) {
    const tracks = [...renditions.entries()].filter(([index, attributes]) => !removed.has(index)
      && attributes.get('TYPE') === 'AUDIO' && attributes.get('GROUP-ID') === group);
    const originals = tracks.filter(([, attributes]) => / - original$/i.test(attributes.get('NAME') || ''));
    const defaults = tracks.filter(([, attributes]) => attributes.get('DEFAULT') === 'YES');
    const preferred = originals.length === 1 ? originals[0] : defaults.length === 1 ? defaults[0] : null;
    if (!preferred) continue;
    if (originals.length === 1) {
      for (const [index] of tracks) lines[index] = setHlsAttribute(lines[index], 'DEFAULT', index === preferred[0] ? 'YES' : 'NO');
      lines[preferred[0]] = setHlsAttribute(lines[preferred[0]], 'AUTOSELECT', 'YES');
    }
    // libmedia starts with the first rendition; YouTube can mark every track DEFAULT=NO.
    const ordered = [preferred, ...tracks.filter(([index]) => index !== preferred[0])].map(([index]) => lines[index]);
    tracks.forEach(([index], position) => { lines[index] = ordered[position]; });
  }
  return lines.filter((line, index) => !removed.has(index)).join('\n');
}

async function rewriteManifest(text: string, baseUrl: string, payload: MediaPayload, origin: string, key: CryptoKey): Promise<string> {
  const lines = (payload.provider === 'youtube' ? filterYouTubeMaster(text) : text).split(/\r?\n/);
  let references = 0;
  async function replaceUri(uri: string): Promise<string> {
    if (!uri || /[\r\n]/.test(uri) || ++references > 4096) {
      throw new MediaError(502, 'MEDIA_INVALID_MANIFEST', 'The media provider returned an unsupported playlist.');
    }
    return signMediaUrl(new URL(uri, baseUrl).href, payload.provider, payload.expiresAt, origin, key);
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    if (!line.startsWith('#')) {
      lines[index] = await replaceUri(line);
    } else if (line.startsWith('#EXT')) {
      // Attribute names and quoted strings are defined by HLS, not HTML.
      const attributes = [...line.matchAll(/(?:[:,])\s*URI\s*=/gi)];
      const quotedUris = [...line.matchAll(/([:,]\s*URI\s*=\s*")([^"]*)"/gi)];
      if (attributes.length !== quotedUris.length) {
        throw new MediaError(502, 'MEDIA_INVALID_MANIFEST', 'The media provider returned an invalid playlist URI.');
      }
      let rewritten = '';
      let position = 0;
      for (const match of quotedUris) {
        rewritten += line.slice(position, match.index) + match[1] + await replaceUri(match[2]) + '"';
        position = match.index + match[0].length;
      }
      lines[index] = rewritten + line.slice(position);
    }
  }
  return lines.join('\n');
}

function responseHeaders(upstream: Headers): Headers {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    const value = upstream.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

export async function handleMedia(request: Request, env: Env, { fetch: fetchImpl = globalThis.fetch }: { fetch?: FetchLike } = {}): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return Response.json({ error: 'Use GET or HEAD to request media.', code: 'METHOD_NOT_ALLOWED' }, {
      status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
    });
  }
  try {
    const url = new URL(request.url);
    const tokens = url.searchParams.getAll('token');
    if (tokens.length !== 1) throw new MediaError(400, 'MEDIA_INVALID_TOKEN', 'The media link is invalid.');
    const key = await signingKey(env.MEDIA_SIGNING_SECRET);
    const payload = await verifyToken(tokens[0], key);
    const { response, url: finalUrl, finish } = await fetchMedia(payload.url, payload.provider, request, fetchImpl);
    try {
      if (![200, 206, 416].includes(response.status)) {
        await response.body?.cancel();
        console.warn({ event: 'media.upstream_refused', provider: payload.provider, status: response.status });
        throw new MediaError(response.status === 429 ? 503 : 502, 'MEDIA_UPSTREAM_ERROR', 'The media provider could not serve this stream. Load the video again.');
      }
      const headers = responseHeaders(response.headers);
      if (response.status === 416) {
        await response.body?.cancel();
        headers.delete('Content-Length');
        return new Response(null, { status: 416, headers });
      }
      const isPlaylist = new URL(finalUrl).pathname.toLowerCase().endsWith('.m3u8') || /(?:vnd\.apple\.mpegurl|x-mpegurl|\/mpegurl)/i.test(headers.get('Content-Type') || '');
      if (isPlaylist) {
        for (const header of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) headers.delete(header);
        headers.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        if (request.method === 'HEAD') {
          await response.body?.cancel();
          return new Response(null, { status: 200, headers });
        }
        if (response.status === 206) {
          await response.body?.cancel();
          throw new MediaError(400, 'MEDIA_PLAYLIST_RANGE', 'Playlist byte ranges are not supported.');
        }
        const text = await readManifest(response);
        const rewritten = await rewriteManifest(text, finalUrl, payload, url.origin, key);
        return new Response(rewritten, { headers });
      }
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
      if (request.method === 'HEAD') {
        await response.body?.cancel();
        return new Response(null, { status: response.status, headers });
      }
      return new Response(response.body, { status: response.status, headers });
    } finally {
      finish();
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const timeout = name === 'AbortError' || name === 'TimeoutError';
    const status = error instanceof MediaError ? error.status : timeout ? 504 : 502;
    const code = error instanceof MediaError ? error.code : timeout ? 'MEDIA_TIMEOUT' : 'MEDIA_UPSTREAM_ERROR';
    const message = error instanceof MediaError ? error.message : timeout ? 'The media provider took too long to respond.' : 'The media provider could not serve this stream.';
    return Response.json({ error: message, code }, { status, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
