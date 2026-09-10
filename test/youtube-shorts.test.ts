import test from 'node:test';
import assert from 'node:assert/strict';
import { searchYouTubeShorts } from '../src/providers/youtube-shorts.ts';
import type { ClientFactory, ClientOptions } from '../src/providers/youtube.ts';
import type { ShortsOptions } from '../src/providers/youtube-shorts.ts';

// InnerTube node shapes vary per result type; the fixtures below are checked at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

function short(id = 'M7lc1UVf-VE', overrides: Node = {}): Node {
  return {
    type: 'ShortsLockupView',
    overlay_metadata: { primary_text: { toString: () => 'A real Short' } },
    thumbnail: [],
    on_tap_endpoint: { name: 'reelWatchEndpoint', payload: {
      videoId: id, thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/frame0.jpg` }] },
    } },
    ...overrides,
  };
}

function continuation(token = 'NEXT_PAGE_123%3D'): Node {
  return { type: 'ContinuationItem', endpoint: { payload: { token }, metadata: { api_url: 'search' } } };
}

function memo(nodes: Node[]): Node {
  return { getType: (...types: Node[]) => nodes.filter(node => types.some(type => type.type === node.type)) };
}

function clientWith(nodes: Node[]): { createClient: ClientFactory } {
  return { createClient: (async () => ({ search: async () => ({ memo: memo(nodes) }) })) as unknown as ClientFactory };
}

test('Shorts discovery uses the actual Shorts filter and returns real reel metadata', async () => {
  const result = await searchYouTubeShorts(' animals ', { createClient: (async (options: ClientOptions) => {
    assert.equal(options.generate_session_locally, false);
    assert.equal(options.retrieve_player, false);
    assert.equal(options.fail_fast, true);
    return { search: async (query: string, filters: Node) => {
      assert.equal(query, 'animals');
      assert.deepEqual(filters, { type: 'shorts' });
      return { memo: memo([short(), continuation()]) };
    } };
  }) as unknown as ClientFactory });
  assert.deepEqual(result, { provider: 'youtube', query: 'animals', videos: [{
    id: 'M7lc1UVf-VE', title: 'A real Short', channel: '', duration: null,
    thumbnail: 'https://i.ytimg.com/vi/M7lc1UVf-VE/frame0.jpg',
  }], nextCursor: 'NEXT_PAGE_123%3D' });
});

test('a short ordinary video is not misrepresented as a YouTube Short', async () => {
  const result = await searchYouTubeShorts('animals', clientWith([
    { type: 'Video', video_id: 'jNQXAC9IVRw', title: 'An ordinary 19-second video', duration: { seconds: 19 },
      endpoint: { name: 'watchEndpoint', payload: { videoId: 'jNQXAC9IVRw' } } },
    short(), short(),
  ]));
  assert.deepEqual(result.videos.map(video => video.id), ['M7lc1UVf-VE']);
  assert.equal(result.nextCursor, null);
});

test('continuation is sent as data to the fixed search endpoint and returns new verified Shorts', async () => {
  const result = await searchYouTubeShorts('animals', {
    cursor: 'NEXT_PAGE_123%3D',
    createClient: (async () => ({ actions: { execute: async (path: string, parameters: Node) => {
      assert.equal(path, '/search');
      assert.deepEqual(parameters, { continuation: 'NEXT_PAGE_123%3D', parse: true });
      return { on_response_received_commands_memo: memo([short('jNQXAC9IVRw')]) };
    } } })) as unknown as ClientFactory,
  });
  assert.deepEqual(result.videos.map(video => video.id), ['jNQXAC9IVRw']);
  assert.equal(result.nextCursor, null);
});

test('Shorts queries and opaque cursors are bounded before any upstream request', async () => {
  const noClient: ShortsOptions = { createClient: (() => assert.fail('Must reject before creating a client')) as unknown as ClientFactory };
  for (const query of ['', '  ', null, {}, 'x'.repeat(121), 'line\nbreak']) {
    await assert.rejects(searchYouTubeShorts(query, noClient), { status: 400, code: 'INVALID_SHORTS_QUERY' });
  }
  for (const cursor of ['', null, {}, 'x'.repeat(2049), 'https://attacker.test/path', '../path?query=x', 'bad token']) {
    await assert.rejects(searchYouTubeShorts('animals', { ...noClient, cursor } as unknown as ShortsOptions), { status: 400, code: 'INVALID_SHORTS_CURSOR' });
  }
});

test('each page is limited to thirty actual IDs and preserves supplied channel and duration', async () => {
  const nodes = Array.from({ length: 40 }, (_, index) => short(`id${String(index).padStart(9, '0')}`, {
    author: { name: 'Actual channel' }, duration: { seconds: 23 },
  }));
  const result = await searchYouTubeShorts('animals', clientWith(nodes));
  assert.deepEqual(result.videos.map(video => video.id), nodes.slice(0, 30).map(node => node.on_tap_endpoint.payload.videoId));
  assert.equal(result.videos[0].channel, 'Actual channel');
  assert.equal(result.videos[0].duration, 23);
});

test('untrusted artwork and unrelated continuation endpoints are omitted', async () => {
  const item = short();
  item.on_tap_endpoint.payload.thumbnail.thumbnails = [{ url: 'https://i.ytimg.com.attacker.test/image.jpg' }];
  const next = continuation();
  next.endpoint.metadata.api_url = 'https://attacker.test/search';
  const result = await searchYouTubeShorts('animals', clientWith([item, next]));
  assert.equal(result.videos[0].thumbnail, null);
  assert.equal(result.nextCursor, null);
});

test('header continuations are excluded from page navigation', async () => {
  const header = continuation('HEADER_TOKEN');
  const body = continuation('BODY_TOKEN');
  const result = await searchYouTubeShorts('animals', { createClient: (async () => ({ search: async () => ({
    memo: memo([short(), header, body]), page: { header_memo: memo([header]) },
  }) })) as unknown as ClientFactory });
  assert.equal(result.nextCursor, 'BODY_TOKEN');
});

test('empty results differ from upstream failures and errors do not leak source data', async () => {
  assert.deepEqual((await searchYouTubeShorts('animals', clientWith([]))).videos, []);
  await assert.rejects(searchYouTubeShorts('animals', { createClient: (async () => { throw new Error('private token value'); }) as unknown as ClientFactory }), {
    status: 502, code: 'YOUTUBE_SHORTS_UNAVAILABLE', message: 'YouTube Shorts are unavailable right now. Try another search.',
  });
  await assert.rejects(searchYouTubeShorts('animals', {
    fetch: async (url, init) => {
      assert.ok(init?.signal instanceof AbortSignal);
      throw new DOMException('private upstream timeout', 'AbortError');
    },
    createClient: (async (options: ClientOptions) => { await options.fetch?.('https://www.youtube.com/youtubei/v1/search', {}); }) as unknown as ClientFactory,
  }), { status: 504, code: 'YOUTUBE_SHORTS_TIMEOUT' });
});
