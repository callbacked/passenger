import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/app.ts';
import type { Services } from '../src/app.ts';
import type { Env } from '../src/env.ts';
import type { FetchLike, Playback } from '../src/types.ts';
import { searchYouTube } from '../src/providers/youtube-search.ts';
import type { ClientFactory } from '../src/providers/youtube.ts';

// JSON responses from the Worker are loosely inspected across many assertions below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

interface TestEnv {
  MEDIA_SIGNING_SECRET?: string;
  APP_DATA?: { put(key: string, value: string, options?: Record<string, unknown>): Promise<void> };
  ASSETS: { fetch: () => Promise<Response> };
}

interface TestServices {
  providers: {
    youtube: {
      resolve: (input: string) => Promise<Playback>;
      search: (query: string) => Promise<unknown>;
    };
    twitch: {
      resolve: (input: string) => Promise<Playback>;
      status: (channel: string | null) => Promise<unknown>;
    };
  };
  fetch?: FetchLike;
}

function setup() {
  const stored = new Map<string, { value: string; options: Record<string, unknown> }>();
  const env: TestEnv = {
    MEDIA_SIGNING_SECRET: 'test-only-signing-secret-with-more-than-32-characters',
    APP_DATA: { async put(key: string, value: string, options?: Record<string, unknown>) { stored.set(key, { value, options: options ?? {} }); } },
    ASSETS: { fetch: async () => new Response('static asset') },
  };
  const services: TestServices = { providers: {
    youtube: {
      resolve: async (input: string): Promise<Playback> => ({ provider: 'youtube', id: input, title: 'Sample', live: false, duration: 120, type: 'hls',
        streamUrl: 'https://manifest.googlevideo.com/api/manifest/master.m3u8' }),
      search: (query: string) => searchYouTube(query, { createClient: (async () => ({ search: async (normalized: string) => {
        assert.equal(normalized, 'space');
        return { videos: [{ video_id: 'M7lc1UVf-VE', title: 'Space video', author: { name: 'Space channel' },
          duration: { seconds: 120 }, is_live: false, thumbnails: [] }] };
      } })) as unknown as ClientFactory }),
    },
    twitch: {
      resolve: async (input: string): Promise<Playback> => ({ provider: 'twitch', id: input, title: 'Live', live: true, type: 'hls',
        streamUrl: 'https://usher.ttvnw.net/api/channel/hls/channel.m3u8' }),
      status: async (channel: string | null) => ({ channel, live: false }),
    },
  } };
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`https://player.test${path}`, body === undefined ? { headers } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { env, services, stored, request, call: (req: Request) => handleRequest(req, env as unknown as Env, services as unknown as Services) };
}

test('Worker health, assets and unavailable endpoints use their public routing boundaries', async () => {
  const { call, request } = setup();
  assert.deepEqual(await (await call(request('/api/health'))).json() as Node, {
    ok: true, runtime: 'cloudflare-workers', providers: ['youtube', 'twitch'], configured: true,
  });
  assert.equal(await (await call(request('/'))).text(), 'static asset');
  assert.equal((await call(request('/api/unknown'))).status, 404);
});

test('YouTube resolve signs HLS and nested media streams through the public route with byte ranges', async () => {
  const { call, request, services, stored } = setup();
  const fetched: string[] = [];
  services.fetch = async (url, init) => {
    fetched.push(url as string);
    const path = new URL(url as string).pathname;
    if (path.endsWith('/master.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"\n480/index.m3u8\n');
    if (path.endsWith('/480/index.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\npart.ts\n#EXT-X-ENDLIST\n');
    assert.equal(path, '/api/manifest/480/part.ts');
    assert.equal(new Headers(init?.headers).get('Range'), 'bytes=0-3');
    return new Response('abcd', { status: 206, headers: { 'Content-Type': 'video/mp2t', 'Content-Range': 'bytes 0-3/100' } });
  };
  const response = await call(request('/api/resolve', { provider: 'youtube', input: 'M7lc1UVf-VE' }));
  assert.equal(response.status, 200);
  const playback = await response.json() as Node;
  assert.equal(playback.type, 'hls');
  assert.equal(playback.title, 'Sample');
  assert.equal(playback.duration, 120);
  assert.equal(playback.live, false);
  assert.match(playback.streamUrl, /^https:\/\/player.test\/api\/media\?token=/);
  const master = await (await call(new Request(playback.streamUrl))).text();
  const child = master.split('\n').find(line => line.startsWith('https://'))!;
  assert.equal(new URL(child).origin, 'https://player.test');
  const childResponse = await call(new Request(child));
  assert.equal(childResponse.status, 200);
  const segment = (await childResponse.text()).split('\n').find(line => line.startsWith('https://'))!;
  const media = await call(new Request(segment, { headers: { Range: 'bytes=0-3' } }));
  assert.equal(media.status, 206);
  assert.equal(media.headers.get('Content-Range'), 'bytes 0-3/100');
  assert.equal(await media.text(), 'abcd');
  assert.deepEqual(fetched, ['https://manifest.googlevideo.com/api/manifest/master.m3u8',
    'https://manifest.googlevideo.com/api/manifest/480/index.m3u8', 'https://manifest.googlevideo.com/api/manifest/480/part.ts']);
  assert.equal(stored.size, 0);
});

test('Twitch live playback and channel status retain their public metadata', async () => {
  const { call, request, stored } = setup();
  const value = await (await call(request('/api/resolve', { provider: 'twitch', input: 'channel' }))).json() as Node;
  assert.equal(value.live, true);
  assert.match(value.streamUrl, /^https:\/\/player.test\/api\/media\?token=/);
  assert.equal(stored.size, 0);
  for (const route of ['/api/twitch/live', '/api/twitch/status']) {
    assert.deepEqual(await (await call(request(`${route}?channel=channel`))).json() as Node, { channel: 'channel', live: false });
  }
});

test('HLS playback requires a signing secret and does not require report storage', async () => {
  const { call, request, env } = setup();
  delete env.APP_DATA;
  assert.equal((await call(request('/api/resolve', { provider: 'youtube', input: 'M7lc1UVf-VE' }))).status, 200);
  delete env.MEDIA_SIGNING_SECRET;
  assert.equal((await call(request('/api/resolve', { provider: 'youtube', input: 'M7lc1UVf-VE' }))).status, 503);
});

test('Resolve rejects methods, malformed bodies and cross-origin requests before provider calls', async () => {
  const { call, request, services } = setup();
  services.providers.youtube.resolve = () => assert.fail('Invalid request must not reach a provider');
  assert.equal((await call(request('/api/resolve'))).status, 405);
  for (const headers of [{ Origin: 'https://attacker.test' }, { 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) {
    assert.equal((await call(request('/api/resolve', { provider: 'youtube', input: 'id' }, headers))).status, 403);
  }
  for (const body of [[], null, { provider: 'other', input: 'id' }, { provider: 'youtube', input: 12 }, { provider: 'youtube', input: 'id', url: 'https://evil.test' }]) {
    assert.equal((await call(request('/api/resolve', body))).status, 400);
  }
  assert.equal((await call(request('/api/resolve', { provider: 'youtube', input: 'x'.repeat(5000) }))).status, 413);
  assert.equal((await call(new Request('https://player.test/api/resolve', { method: 'POST', body: '{invalid' }))).status, 400);
});

test('Signed playback expires with the upstream HLS path or query expiry', async context => {
  const { call, request, services } = setup();
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const originalResolve = services.providers.youtube.resolve;
  const signed: string[] = [];
  for (const streamUrl of [`https://manifest.googlevideo.com/master.m3u8?expire=${expires}`,
    `https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/${expires}/file/index.m3u8`]) {
    services.providers.youtube.resolve = async input => ({ ...await originalResolve(input), streamUrl });
    const response = await call(request('/api/resolve', { provider: 'youtube', input: 'M7lc1UVf-VE' }));
    assert.equal(response.status, 200);
    const playback = await response.json() as Node;
    assert.equal(playback.expiresAt, expires * 1000);
    signed.push(playback.streamUrl);
  }
  services.fetch = () => assert.fail('Expired media must not contact the source');
  context.mock.method(Date, 'now', () => expires * 1000 + 1);
  for (const url of signed) {
    const response = await call(new Request(url));
    assert.equal(response.status, 403);
    assert.equal((await response.json() as Node).code, 'MEDIA_EXPIRED');
  }
  assert.equal((await call(request('/api/resolve', { provider: 'youtube', input: 'M7lc1UVf-VE' }))).status, 502);
});

test('Search returns discoverable videos and validates queries through the actual provider contract', async () => {
  const { call, request, env } = setup();
  delete env.MEDIA_SIGNING_SECRET;
  delete env.APP_DATA;
  const response = await call(request('/api/search', { query: ' space ' }, { Origin: 'https://player.test' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json() as Node, { provider: 'youtube', query: 'space', videos: [{
    id: 'M7lc1UVf-VE', title: 'Space video', channel: 'Space channel', duration: 120, live: false, thumbnail: null,
  }] });
  for (const query of ['', '   ', 'x'.repeat(121), 'line\nbreak']) {
    assert.equal((await call(request('/api/search', { query }))).status, 400);
  }
});

test('Search rejects methods, cross-origin access, body overflow and schema extensions', async () => {
  const { call, request, services } = setup();
  services.providers.youtube.search = () => assert.fail('Invalid request must not search');
  assert.equal((await call(request('/api/search'))).status, 405);
  for (const headers of [{ Origin: 'https://attacker.test' }, { 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) {
    assert.equal((await call(request('/api/search', { query: 'space' }, headers))).status, 403);
  }
  for (const body of [[], null, {}, { query: 12 }, { query: 'space', provider: 'youtube' }]) {
    assert.equal((await call(request('/api/search', body))).status, 400);
  }
  assert.equal((await call(request('/api/search', { query: 'x'.repeat(1500) }))).status, 413);
  assert.equal((await call(new Request('https://player.test/api/search', { method: 'POST', body: '{invalid' }))).status, 400);
});

test('Browser reports preserve diagnostic values in expiring Workers storage', async () => {
  const { call, request, stored, env } = setup();
  const data = { ua: 'Tesla', apis: { WebAssembly: true, VideoDecoder: false }, webgl: 'OK' };
  const response = await call(request('/api/probe-report', data));
  assert.equal(response.status, 201);
  const result = await response.json() as Node;
  const saved = stored.get(`probe:${result.id}`)!;
  assert.deepEqual(JSON.parse(saved.value).data, data);
  assert.ok(Number.isFinite(Date.parse(JSON.parse(saved.value).receivedAt)));
  assert.equal(saved.options.expirationTtl, 604800);
  assert.equal((await call(request('/api/probe-report', []))).status, 400);
  assert.equal((await call(request('/api/probe-report', data, { Origin: 'https://attacker.test' }))).status, 403);
  assert.equal((await call(request('/api/probe-report', { data: 'x'.repeat(33000) }))).status, 413);
  delete env.APP_DATA;
  assert.equal((await call(request('/api/probe-report', data))).status, 503);
});

test('Internal playback and search errors do not leak upstream details', async () => {
  const { call, request, services } = setup();
  services.providers.youtube.resolve = services.providers.youtube.search = async () => { throw new Error('private upstream URL and token'); };
  for (const [route, body] of [['/api/resolve', { provider: 'youtube', input: 'id' }], ['/api/search', { query: 'space' }]] as [string, unknown][]) {
    const response = await call(request(route, body));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json() as Node, { error: 'Something went wrong. Please try again.' });
  }
});
