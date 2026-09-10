import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveYouTube, youtubeId } from '../src/providers/youtube.ts';
import type { ClientFactory, ClientOptions } from '../src/providers/youtube.ts';
import type { Innertube } from 'youtubei.js/cf-worker';

test('YouTube accepts supported links and rejects lookalike domains', () => {
  for (const input of ['M7lc1UVf-VE', 'https://youtu.be/M7lc1UVf-VE?t=10',
    'youtu.be/M7lc1UVf-VE', 'www.youtube.com/watch?v=M7lc1UVf-VE',
    'https://www.youtube.com/watch?v=M7lc1UVf-VE&list=anything',
    'https://m.youtube.com/shorts/M7lc1UVf-VE', 'https://www.youtube.com/live/M7lc1UVf-VE']) {
    assert.equal(youtubeId(input), 'M7lc1UVf-VE');
  }
  for (const input of ['https://youtube.com.attacker.test/watch?v=M7lc1UVf-VE',
    'https://evil.test/M7lc1UVf-VE', 'https://name:pass@youtube.com/watch?v=M7lc1UVf-VE', '', null]) {
    assert.throws(() => youtubeId(input), { status: 400 });
  }
});

// InnerTube's basic-info response has no published schema; the fixture below is checked at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

function videoInfo(): Node {
  return {
    basic_info: { title: 'A real title', duration: 130, is_live: false },
    playability_status: { status: 'OK' },
    streaming_data: { hls_manifest_url: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/index.m3u8' },
  };
}

test('YouTube uses a real public session and returns complete segmented HLS for recordings', async () => {
  const result = await resolveYouTube('M7lc1UVf-VE', { log() {},
    createClient: (async (options: ClientOptions) => {
      assert.equal(options.generate_session_locally, false);
      assert.equal(options.retrieve_player, false);
      assert.equal(options.fail_fast, true);
      return { getBasicInfo: async (id: string, config: Node) => {
        assert.equal(id, 'M7lc1UVf-VE');
        assert.deepEqual(config, { client: 'VISIONOS' });
        return videoInfo();
      } };
    }) as unknown as ClientFactory,
  });
  assert.equal(result.title, 'A real title');
  assert.equal(result.type, 'hls');
  assert.equal(result.duration, 130);
  assert.equal(result.live, false);
  assert.equal(result.streamUrl, videoInfo().streaming_data.hls_manifest_url);
});

test('YouTube distinguishes sign-in, unavailable, unsupported, and upstream errors', async () => {
  for (const [status, expected] of [['LOGIN_REQUIRED', 503], ['UNPLAYABLE', 404]] as const) {
    await assert.rejects(resolveYouTube('M7lc1UVf-VE', { log() {}, createClient: (async () => ({
      getBasicInfo: async () => ({ playability_status: { status, reason: 'private upstream detail' } }),
    })) as unknown as ClientFactory }), (error: Node) => error.status === expected && !error.message.includes('private upstream detail'));
  }
  await assert.rejects(resolveYouTube('M7lc1UVf-VE', { log() {}, createClient: (async () => { throw new Error('secret upstream URL'); }) as unknown as ClientFactory }),
    (error: Node) => error.status === 502 && !error.message.includes('secret upstream URL'));
  const unsupported = videoInfo();
  unsupported.streaming_data = {};
  await assert.rejects(resolveYouTube('M7lc1UVf-VE', { log() {}, createClient: (async () => ({ getBasicInfo: async () => unsupported })) as unknown as ClientFactory }), { status: 422 });
});

test('YouTube live video uses its supplied HLS manifest', async () => {
  const info = videoInfo();
  info.basic_info.is_live = true;
  info.streaming_data.hls_manifest_url = 'https://manifest.googlevideo.com/live/playlist.m3u8';
  const result = await resolveYouTube('M7lc1UVf-VE', { log() {}, createClient: (async () => ({ getBasicInfo: async () => info })) as unknown as ClientFactory });
  assert.equal(result.type, 'hls');
  assert.equal(result.streamUrl, info.streaming_data.hls_manifest_url);
  assert.equal(result.live, true);
});

test('YouTube retries a bot-check refusal with a fresh session before giving up', async () => {
  const statuses = ['LOGIN_REQUIRED', 'OK'];
  let created = 0;
  const info = (status: string | undefined) => ({ playability_status: { status }, basic_info: { title: 'Retry', author: 'Channel', duration: 100 },
    streaming_data: { hls_manifest_url: 'https://manifest.googlevideo.com/api/manifest/hls_variant/master.m3u8' } });
  const result = await resolveYouTube('M7lc1UVf-VE', { log() {}, createClient: (async () => { created++; return { getBasicInfo: async () => info(statuses.shift()) }; }) as unknown as ClientFactory });
  assert.equal(result.type, 'hls');
  assert.equal(created, 2, 'A refusal must create a fresh session and try again');

  created = 0;
  await assert.rejects(resolveYouTube('M7lc1UVf-VE', { log() {}, createClient: (async () => { created++; return { getBasicInfo: async () => info('LOGIN_REQUIRED') }; }) as unknown as ClientFactory }),
    { status: 503, code: 'YOUTUBE_BOT_CHECK' });
  assert.equal(created, 2, 'Persistent refusals stop after two attempts');
});

test('YouTube uses the connected account first and falls back to anonymous sessions', async () => {
  const info = (status: string) => ({ playability_status: { status, reason: 'Sign in to confirm you are not a bot' }, basic_info: { title: 'Fallback', duration: 100 },
    streaming_data: { hls_manifest_url: 'https://manifest.googlevideo.com/api/manifest/hls_variant/master.m3u8' } });
  let anonymous = 0;
  const refused = (async () => { anonymous++; return { getBasicInfo: async () => info('LOGIN_REQUIRED') }; }) as unknown as ClientFactory;
  const events: Node[] = [];
  const result = await resolveYouTube('M7lc1UVf-VE', { createClient: refused, log: event => events.push(event), youtubeClient: async () => (
    { getBasicInfo: async (id: string, config: Node) => { assert.deepEqual(config, { client: 'VISIONOS' }); return info('OK'); } } as unknown as Innertube) });
  assert.equal(result.title, 'Fallback');
  assert.equal(anonymous, 0, 'A working account session needs no anonymous attempt');
  assert.deepEqual(events.map(event => [event.attempt, event.authenticated, event.status]), [[0, true, 'OK']]);

  events.length = 0;
  await assert.rejects(resolveYouTube('M7lc1UVf-VE', { createClient: refused, log: event => events.push(event), youtubeClient: async () => ({ getBasicInfo: async () => info('LOGIN_REQUIRED') }) as unknown as Innertube }),
    (error: Node) => error.code === 'YOUTUBE_BOT_CHECK' && error.message.includes('even with your connected account'));
  assert.deepEqual(events.map(event => [event.attempt, event.authenticated, event.status]), [[0, true, 'LOGIN_REQUIRED'], [1, false, 'LOGIN_REQUIRED'], [2, false, 'LOGIN_REQUIRED']],
    'A refused account session is followed by the anonymous attempts');

  await assert.rejects(resolveYouTube('M7lc1UVf-VE', { createClient: refused, log() {}, youtubeClient: async () => null }),
    (error: Node) => error.code === 'YOUTUBE_BOT_CHECK' && error.message.includes('connect your YouTube account'));
  await assert.rejects(resolveYouTube('M7lc1UVf-VE', { createClient: refused, log() {}, youtubeClient: async () => { throw new Error('token refresh failed'); } }),
    (error: Node) => error.status === 503 && !error.message.includes('token refresh failed'), 'An account failure falls back to anonymous attempts without leaking details');
});
