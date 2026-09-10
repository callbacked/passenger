import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTwitch, statusTwitch, TwitchError } from '../src/providers/twitch.ts';
import type { FetchLike } from '../src/types.ts';

// Twitch's GraphQL responses have no published schema; the fixtures below are checked at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

function metadata(stream: Node = { id: 'stream-1', viewersCount: 203 }): Node {
  return { data: { user: { displayName: 'Sample', broadcastSettings: { title: 'A live title' }, stream } } };
}

interface TwitchServerOptions {
  channel?: Node;
  token?: Node;
  manifest?: Response;
  onRequest?: (url: URL, init: RequestInit) => void;
}

function twitchServer({ channel = metadata(), token, manifest, onRequest = () => {} }: TwitchServerOptions = {}): FetchLike {
  return async (input, init = {}) => {
    const url = new URL(input as string);
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    onRequest(url, init);
    if (url.href === 'https://gql.twitch.tv/gql') {
      assert.equal(init.method, 'POST');
      const headers = init.headers as Record<string, string>;
      assert.equal(headers['Content-Type'], 'application/json');
      assert.equal(headers['Client-ID'], 'ue6666qo983tsx6so1t0vnawi233wa');
      assert.equal(headers.Authorization, undefined);
      const body = JSON.parse(init.body as string);
      assert.deepEqual(body.variables, { channel: 'sample' });
      if (body.query.includes('streamPlaybackAccessToken')) {
        return token instanceof Response ? token : Response.json(token ?? {
          data: { streamPlaybackAccessToken: { value: '{"token":"signed + / ="}', signature: 'signature+&' } },
        });
      }
      assert.match(body.query, /user\(login: \$channel\)/);
      return channel instanceof Response ? channel : Response.json(channel);
    }
    assert.equal(url.origin, 'https://usher.ttvnw.net');
    assert.equal(url.pathname, '/api/channel/hls/sample.m3u8');
    assert.equal(url.searchParams.get('sig'), 'signature+&');
    assert.equal(url.searchParams.get('token'), '{"token":"signed + / ="}');
    assert.equal(url.searchParams.get('supported_codecs'), 'h264');
    return manifest ?? new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.4d401f,mp4a.40.2"\nhttps://video-weaver.example.ttvnw.net/live/sample.m3u8\n');
  };
}

test('resolves public live Twitch HLS after checking its real playlist', async () => {
  const requestedHosts: string[] = [];
  const result = await resolveTwitch('https://www.twitch.tv/SaMpLe/', {
    fetch: twitchServer({ onRequest: (url) => requestedHosts.push(url.hostname) }),
  });
  const { streamUrl, ...details } = result;
  assert.deepEqual(details, {
    provider: 'twitch', id: 'sample', channel: 'sample', title: 'A live title', live: true, viewers: 203, type: 'hls',
  });
  assert.equal(new URL(streamUrl).pathname, '/api/channel/hls/sample.m3u8');
  assert.deepEqual(requestedHosts, ['gql.twitch.tv', 'gql.twitch.tv', 'usher.ttvnw.net']);
});

test('status reports offline without requesting playback access', async () => {
  const requests: Node[] = [];
  const result = await statusTwitch('sample', {
    fetch: twitchServer({ channel: metadata(null), onRequest: (url, init) => requests.push(JSON.parse(init.body as string)) }),
  });
  assert.deepEqual(result, {
    provider: 'twitch', id: 'sample', channel: 'sample', title: 'A live title', live: false, viewers: 0,
  });
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0].query, /streamPlaybackAccessToken/);
});

test('offline playback is an explicit error instead of a fabricated stream URL', async () => {
  await assert.rejects(resolveTwitch('sample', { fetch: twitchServer({ channel: metadata(null) }) }), {
    name: 'TwitchError', status: 409, code: 'TWITCH_OFFLINE',
  });
});

test('rejects URL and query injection and invalid channels before contacting Twitch', async () => {
  for (const channel of [
    '', null, {}, 'sample?token=x', 'a'.repeat(26), 'sample/name', ' sam ple', 'sample\n',
    'https://twitch.tv.evil.test/sample', 'https://eviltwitch.tv/sample', 'http://twitch.tv/sample',
    'https://user@twitch.tv/sample', 'https://twitch.tv:443/sample', 'https://twitch.tv/sample/videos',
    'https://twitch.tv/sample?token=x', 'https://twitch.tv/sample#fragment', 'https://twitch.tv/%73ample',
  ]) {
    for (const resolve of [resolveTwitch, statusTwitch]) {
      await assert.rejects(resolve(channel, { fetch: () => assert.fail('Invalid input must not make a request') }), {
        status: 400, code: 'INVALID_CHANNEL',
      });
    }
  }
});

test('normalizes channel names and exact Twitch HTTPS links', async () => {
  for (const channel of ['SaMpLe', 'https://twitch.tv/Sample', 'https://www.twitch.tv/Sample/', 'https://TWITCH.TV/sample']) {
    const result = await statusTwitch(channel, { fetch: twitchServer() });
    assert.equal(result.id, 'sample');
    assert.equal(result.channel, 'sample');
    assert.equal(result.title, 'A live title');
    assert.equal(result.live, true);
  }
});

test('reports a missing channel separately from offline', async () => {
  await assert.rejects(statusTwitch('sample', { fetch: twitchServer({ channel: { data: { user: null } } }) }), {
    status: 404, code: 'TWITCH_NOT_FOUND',
  });
});

test('incomplete status and GraphQL errors cannot be mistaken for offline', async () => {
  for (const channel of [{ data: {} }, { data: { user: {} } }, { ...metadata(null), errors: [{ message: 'internal details' }] }]) {
    await assert.rejects(statusTwitch('sample', { fetch: twitchServer({ channel }) }), (error: Node) => {
      assert.ok(error instanceof TwitchError);
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /offline|internal details/);
      return true;
    });
  }
});

test('rate limits and playback restrictions are retryable failures', async () => {
  for (const status of [401, 403, 429]) {
    await assert.rejects(resolveTwitch('sample', {
      fetch: twitchServer({ manifest: new Response('private upstream error body', { status }) }),
    }), (error: Node) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'TWITCH_UNAVAILABLE');
      assert.doesNotMatch(error.message, /offline|private upstream/);
      return true;
    });
  }
});

test('missing public playback tokens fail without constructing a playlist URL', async () => {
  for (const token of [null, {}, { value: 'value' }, { value: '', signature: 'sig' }]) {
    await assert.rejects(resolveTwitch('sample', {
      fetch: twitchServer({ token: { data: { streamPlaybackAccessToken: token } } }),
    }), { status: 503, code: 'TWITCH_PLAYBACK_UNAVAILABLE' });
  }
});

test('rejects a non-playlist or empty playlist even when Twitch returns HTTP 200', async () => {
  for (const text of ['<html>Access blocked</html>', '#EXTM3U\n', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n']) {
    await assert.rejects(resolveTwitch('sample', {
      fetch: twitchServer({ manifest: new Response(text) }),
    }), { status: 502, code: 'TWITCH_PLAYBACK_UNAVAILABLE' });
  }
});

test('redirects, malformed JSON, and upstream failures do not leak upstream content', async () => {
  for (const response of [
    new Response('sensitive error details', { status: 500 }),
    new Response(null, { status: 302, headers: { Location: 'https://example.com/untrusted' } }),
    new Response('sensitive malformed JSON'),
  ]) {
    await assert.rejects(statusTwitch('sample', { fetch: twitchServer({ channel: response }) }), (error: Node) => {
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /sensitive|example.com/);
      return true;
    });
  }
});

test('network errors are sanitized and timeouts are identified', async () => {
  await assert.rejects(statusTwitch('sample', { fetch: async () => { throw new Error('secret diagnostic'); } }), {
    status: 502, code: 'TWITCH_UPSTREAM_ERROR', message: 'Could not reach Twitch. Try again.',
  });
  await assert.rejects(statusTwitch('sample', {
    fetch: async () => { throw new DOMException('aborted', 'AbortError'); },
  }), { status: 504, code: 'TWITCH_TIMEOUT' });
});

test('bounds upstream response bodies', async () => {
  await assert.rejects(statusTwitch('sample', {
    fetch: twitchServer({ channel: new Response('x'.repeat(1_048_577)) }),
  }), { status: 502, code: 'TWITCH_INVALID_RESPONSE' });
});
