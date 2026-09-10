import test from 'node:test';
import assert from 'node:assert/strict';
import { searchYouTube } from '../src/providers/youtube-search.ts';
import type { ClientFactory, ClientOptions } from '../src/providers/youtube.ts';

// InnerTube search results have no published schema; the fixtures below are checked at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

function video(overrides: Node = {}): Node {
  return {
    video_id: 'M7lc1UVf-VE',
    title: { toString: () => 'YouTube Player API' },
    author: { name: 'YouTube Developers' },
    duration: { seconds: 1322 },
    is_live: false,
    thumbnails: [{ url: 'https://i.ytimg.com/vi/M7lc1UVf-VE/mqdefault.jpg', width: 320 }],
    ...overrides,
  };
}

function results(videos: Node): { createClient: ClientFactory } {
  return { createClient: (async () => ({ search: async () => ({ videos }) })) as unknown as ClientFactory };
}

test('public search returns usable video metadata without an account or player script', async () => {
  const result = await searchYouTube('  player api  ', { createClient: (async (options: ClientOptions) => {
    assert.equal(options.generate_session_locally, false);
    assert.equal(options.retrieve_player, false);
    assert.equal(options.fail_fast, true);
    return { search: async (query: string, filters: Node) => {
      assert.equal(query, 'player api');
      assert.deepEqual(filters, { type: 'video' });
      return { videos: [video()] };
    } };
  }) as unknown as ClientFactory });
  assert.deepEqual(result, {
    provider: 'youtube', query: 'player api', videos: [{
      id: 'M7lc1UVf-VE', title: 'YouTube Player API', channel: 'YouTube Developers', duration: 1322, live: false,
      thumbnail: 'https://i.ytimg.com/vi/M7lc1UVf-VE/mqdefault.jpg',
    }],
  });
});

test('search validates its query before contacting YouTube', async () => {
  for (const query of ['', '   ', null, {}, 'x'.repeat(121), 'query\nwith control', '\0']) {
    await assert.rejects(searchYouTube(query, { createClient: (() => assert.fail('Invalid query must not fetch')) as unknown as ClientFactory }), {
      status: 400, code: 'INVALID_SEARCH',
    });
  }
});

test('results are bounded, deduplicated, and retain their actual video IDs', async () => {
  const candidates = Array.from({ length: 30 }, (_, index) => video({ video_id: `id${String(index).padStart(9, '0')}` }));
  const result = await searchYouTube('space', results([candidates[0], candidates[0], ...candidates]));
  assert.deepEqual(result.videos.map(item => item.id), candidates.slice(0, 12).map(item => item.video_id));
});

test('skips non-video results and does not expose unsafe thumbnail URLs', async () => {
  const result = await searchYouTube('space', results([
    video({ video_id: 'invalid' }),
    video({ title: null }),
    video({ is_live: true, duration: { seconds: Number.NaN }, author: null, thumbnails: [
      { url: 'https://i.ytimg.com.evil.test/image.jpg' }, { url: 'http://i.ytimg.com/image.jpg' },
      { url: 'https://user:password@i.ytimg.com/image.jpg' },
    ] }),
  ]));
  assert.deepEqual(result.videos, [{
    id: 'M7lc1UVf-VE', title: 'YouTube Player API', channel: '', duration: 0, live: true, thumbnail: null,
  }]);
});

test('an empty search is distinct from an invalid upstream response', async () => {
  assert.deepEqual((await searchYouTube('no matches', results([]))).videos, []);
  await assert.rejects(searchYouTube('space', results(undefined)), { status: 502, code: 'YOUTUBE_SEARCH_UNAVAILABLE' });
});

test('upstream failures are sanitized and requests carry a timeout signal', async () => {
  await assert.rejects(searchYouTube('space', {
    fetch: async (url, init) => {
      assert.ok(init?.signal instanceof AbortSignal);
      throw new DOMException('private timeout details', 'TimeoutError');
    },
    createClient: (async (options: ClientOptions) => {
      await options.fetch?.('https://www.youtube.com/youtubei/v1/search', {});
    }) as unknown as ClientFactory,
  }), { status: 504, code: 'YOUTUBE_SEARCH_TIMEOUT', message: 'YouTube search took too long. Please try again.' });
  await assert.rejects(searchYouTube('space', { createClient: (async () => { throw new Error('private response token'); }) as unknown as ClientFactory }), {
    status: 502, code: 'YOUTUBE_SEARCH_UNAVAILABLE',
    message: 'YouTube search is unavailable right now. Try again or paste a video link.',
  });
});
