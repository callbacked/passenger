import test from 'node:test';
import assert from 'node:assert/strict';
import type { Innertube } from 'youtubei.js/cf-worker';
import { AccountFeedError, loadAccountFeed } from '../src/account-feeds.ts';

// InnerTube's browse/reel responses have no published schema; the fixtures below are checked at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

interface LockupOptions {
  short?: boolean;
  title?: string;
  duration?: string;
  thumbnail?: string;
}

function lockup(id = 'M7lc1UVf-VE', { short = false, title = 'Example video', duration = '1:23', thumbnail }: LockupOptions = {}): Node {
  return { lockupViewModel: {
    contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: { thumbnailViewModel: {
      image: { sources: [{ url: thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }] },
      overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: duration } }] } }],
    } },
    metadata: { lockupMetadataViewModel: {
      title: { content: title },
      metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'Actual channel' } }] }] } },
    } },
    rendererContext: { commandContext: { onTap: { innertubeCommand: {
      [short ? 'reelWatchEndpoint' : 'watchEndpoint']: { videoId: id, playerParams: 'PRIVATE_PLAYER_PARAMS' },
    } } } },
  } };
}

function browse(contents: Node, extra: Node = {}): Node {
  return { contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: {
    content: { sectionListRenderer: { contents, ...extra } },
  } } } } };
}

function client(responder: (path: string, args: Node) => Node | Promise<Node>): Innertube {
  return { session: { logged_in: true }, actions: { execute: async (path: string, args: Node) => ({
    success: true, status_code: 200, data: await responder(path, args),
  }) } } as unknown as Innertube;
}

test('TV Home returns real lockup metadata, verified Shorts, and only safe public fields', async () => {
  const result = await loadAccountFeed({ feed: 'home' }, client((path, args) => {
    assert.equal(path, '/browse');
    assert.deepEqual(args, { browseId: 'FEwhat_to_watch', client: 'TV' });
    return browse([lockup(), lockup(), lockup('4z8Hi_uQOkE', { short: true, title: 'Actual Short' }),
      { adSlotRenderer: { fulfillmentContent: lockup('jNQXAC9IVRw') } }], {
      continuations: [{ nextContinuationData: { continuation: 'HOME_CURSOR%3D', clickTrackingParams: 'private' } }],
    });
  }));
  assert.deepEqual(result, {
    provider: 'youtube', feed: 'home', nextCursor: 'HOME_CURSOR%3D', videos: [
      { id: 'M7lc1UVf-VE', title: 'Example video', channel: 'Actual channel', thumbnail: 'https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg', duration: 83, live: false, isShort: false },
      { id: '4z8Hi_uQOkE', title: 'Actual Short', channel: 'Actual channel', thumbnail: 'https://i.ytimg.com/vi/4z8Hi_uQOkE/hqdefault.jpg', duration: 83, live: false, isShort: true },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|playerParams|tracking/);
});

test('subscriptions and liked use their own TV browse IDs without a public fallback', async () => {
  for (const [feed, browseId] of [['subscriptions', 'FEsubscriptions'], ['liked', 'VLLL']]) {
    const result = await loadAccountFeed({ feed }, client((path, args) => {
      assert.equal(path, '/browse');
      assert.deepEqual(args, { browseId, client: 'TV' });
      return browse([{ playlistVideoRenderer: {
        videoId: 'M7lc1UVf-VE', title: { runs: [{ text: 'A liked video' }] },
        shortBylineText: { runs: [{ text: 'Its creator' }] }, lengthSeconds: '235',
        thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg' }] },
        navigationEndpoint: { watchEndpoint: { videoId: 'M7lc1UVf-VE' } },
      } }]);
    }));
    assert.equal(result.feed, feed);
    assert.deepEqual(result.videos[0], { id: 'M7lc1UVf-VE', title: 'A liked video', channel: 'Its creator', duration: 235,
      thumbnail: 'https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg', live: false, isShort: false });
  }
});

test('continuations are data for fixed browse endpoint, with no header or artwork URL navigation', async () => {
  const result = await loadAccountFeed({ feed: 'home', cursor: 'PAGE_TWO%3D' }, client((path, args) => {
    assert.equal(path, '/browse');
    assert.deepEqual(args, { continuation: 'PAGE_TWO%3D', client: 'TV' });
    return { continuationContents: { sectionListContinuation: {
      contents: [lockup('M7lc1UVf-VE', { thumbnail: 'https://i.ytimg.com.attacker.test/x' })],
      continuations: [{ nextContinuationData: { continuation: 'PAGE_THREE' } }],
    } }, header: { continuations: [{ nextContinuationData: { continuation: 'WRONG_HEADER' } }] } };
  }));
  assert.equal(result.nextCursor, 'PAGE_THREE');
  assert.equal(result.videos[0].thumbnail, null);
});

test('empty feeds differ from missing, upstream error, and expired authentication responses', async () => {
  assert.deepEqual(await loadAccountFeed({ feed: 'home' }, client(() => browse([]))), {
    provider: 'youtube', feed: 'home', videos: [], nextCursor: null,
  });
  for (const response of [{}, { contents: { unsupportedRenderer: {} } }, { error: { message: 'private error' } }, { ...browse([]), alerts: [{ alertRenderer: { type: 'ERROR', text: 'private' } }] }]) {
    await assert.rejects(loadAccountFeed({ feed: 'home' }, client(() => response)), { status: 502, code: 'ACCOUNT_FEED_UNAVAILABLE' });
  }
  await assert.rejects(loadAccountFeed({ feed: 'home' }, client(() => ({ ...browse([]), responseContext: {
    mainAppWebResponseContext: { loggedOut: true },
  } }))), { status: 401, code: 'ACCOUNT_AUTH_EXPIRED' });
});

test('page continuation takes precedence over an inner shelf continuation', async () => {
  const result = await loadAccountFeed({ feed: 'home' }, client(() => browse([
    { shelfRenderer: { content: { horizontalListRenderer: {
      items: [lockup()], continuations: [{ nextContinuationData: { continuation: 'SHELF_ONLY' } }],
    } } } },
  ], { continuations: [{ nextContinuationData: { continuation: 'WHOLE_PAGE' } }] })));
  assert.equal(result.nextCursor, 'WHOLE_PAGE');
});

test('Shorts sequence uses validated seed and returns only actual reel entries with honest missing metadata', async () => {
  const result = await loadAccountFeed({ feed: 'shorts', seed: '4z8Hi_uQOkE' }, client((path, args) => {
    assert.equal(path, '/reel/reel_watch_sequence');
    assert.equal(args.client, 'TV');
    assert.deepEqual(Array.from(atob(decodeURIComponent(args.sequenceParams)), char => char.charCodeAt(0)),
      [10, 11, ...new TextEncoder().encode('4z8Hi_uQOkE'), 42, 2, 24, 5, 80, 25]);
    return { entries: [
      { command: { reelWatchEndpoint: { videoId: '2g0L9Lc1ZqY', thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/2g0L9Lc1ZqY/frame0.jpg' }] } } } },
      { command: { watchEndpoint: { videoId: 'jNQXAC9IVRw' } } },
      { command: { reelWatchEndpoint: { videoId: '2g0L9Lc1ZqY' } } },
    ], continuation: 'REEL_NEXT%3D' };
  }));
  assert.deepEqual(result, { provider: 'youtube', feed: 'shorts', nextCursor: 'REEL_NEXT%3D', videos: [{
    id: '2g0L9Lc1ZqY', title: '', channel: '', duration: null, live: false, isShort: true,
    thumbnail: 'https://i.ytimg.com/vi/2g0L9Lc1ZqY/frame0.jpg',
  }] });
});

test('Shorts without a seed discovers a real reel in account Home, never a short ordinary video', async () => {
  let requests = 0;
  await loadAccountFeed({ feed: 'shorts' }, client((path, args) => {
    requests++;
    if (path === '/browse') return browse([lockup('jNQXAC9IVRw', { duration: '0:19' }), lockup('4z8Hi_uQOkE', { short: true })]);
    assert.match(atob(decodeURIComponent(args.sequenceParams)), /4z8Hi_uQOkE/);
    return { entries: [] };
  }));
  assert.equal(requests, 2);
  await assert.rejects(loadAccountFeed({ feed: 'shorts' }, client(() => browse([lockup('jNQXAC9IVRw', { duration: '0:19' })]))), {
    status: 409, code: 'ACCOUNT_SHORTS_SEED_REQUIRED',
  });
});

test('TV explicitly typed Shorts remain Shorts when their tap command is a watch endpoint', async () => {
  const tvShort = lockup('4z8Hi_uQOkE', { title: 'TV Short', duration: '0:40' });
  tvShort.lockupViewModel.contentType = 'LOCKUP_CONTENT_TYPE_SHORT';
  const home = await loadAccountFeed({ feed: 'home' }, client(() => browse([lockup('jNQXAC9IVRw', { duration: '0:19' }), tvShort])));
  assert.deepEqual(home.videos.map(({ id, isShort }) => ({ id, isShort })), [
    { id: 'jNQXAC9IVRw', isShort: false }, { id: '4z8Hi_uQOkE', isShort: true },
  ]);
  await loadAccountFeed({ feed: 'shorts' }, client((path, args) => {
    if (path === '/browse') return browse([tvShort]);
    assert.match(atob(decodeURIComponent(args.sequenceParams)), /4z8Hi_uQOkE/);
    return { entries: [] };
  }));
});

test('Shorts pagination sends only its opaque token to the fixed reel sequence endpoint', async () => {
  const result = await loadAccountFeed({ feed: 'shorts', cursor: 'REEL_NEXT%3D' }, client((path, args) => {
    assert.equal(path, '/reel/reel_watch_sequence');
    assert.deepEqual(args, { sequenceParams: 'REEL_NEXT%3D', client: 'TV' });
    return { entries: [], continuation: 'x'.repeat(2049) };
  }));
  assert.equal(result.nextCursor, null);
});

test('invalid inputs and missing identity fail before an upstream call', async () => {
  const never = client(() => assert.fail('No request should be sent'));
  for (const body of [null, {}, [], { feed: ['home'] }, { feed: 'unknown' }, { feed: 'home', account: 'someone-else' },
    { feed: 'home', seed: '4z8Hi_uQOkE' }, { feed: 'shorts', seed: 'https://attacker.test' },
    ...['', null, {}, 'x'.repeat(2049), 'https://attacker.test/x'].map(cursor => ({ feed: 'home', cursor }))]) {
    await assert.rejects(loadAccountFeed(body, never), { status: 400, code: 'INVALID_ACCOUNT_FEED' });
  }
  await assert.rejects(loadAccountFeed({ feed: 'home' }, { ...never, session: { logged_in: false } } as unknown as Innertube), { status: 401, code: 'ACCOUNT_REQUIRED' });
});

test('browse pages are bounded to thirty distinct videos', async () => {
  const videos = Array.from({ length: 40 }, (_, i) => lockup(`id${String(i).padStart(9, '0')}`));
  const result = await loadAccountFeed({ feed: 'home' }, client(() => browse(videos)));
  assert.deepEqual(result.videos.map(video => video.id), videos.slice(0, 30).map((video: Node) => video.lockupViewModel.contentId));
});

test('account feed failures are sanitized typed errors, including timeout', async () => {
  await assert.rejects(loadAccountFeed({ feed: 'home' }, client(() => { throw new Error('Bearer SECRET refresh_token=PRIVATE'); })), (error: Node) => {
    assert.ok(error instanceof AccountFeedError);
    assert.equal(error.status, 502);
    assert.equal(error.code, 'ACCOUNT_FEED_UNAVAILABLE');
    assert.doesNotMatch(error.message, /SECRET|PRIVATE|Bearer/);
    return true;
  });
  await assert.rejects(loadAccountFeed({ feed: 'home' }, client(() => { throw new DOMException('private upstream URL', 'AbortError'); })), {
    status: 504, code: 'ACCOUNT_FEED_TIMEOUT',
  });
});
