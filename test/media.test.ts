import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaUrl, handleMedia } from '../src/media.ts';
import type { Env } from '../src/env.ts';
import type { Provider } from '../src/types.ts';

// JSON responses from the media proxy are loosely inspected across many assertions below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const origin = 'https://player.example';
const secret = 'test-media-signing-secret-with-32-or-more-characters';
const env = { MEDIA_SIGNING_SECRET: secret } as unknown as Env;

function mediaUrl(url = 'https://video.googlevideo.com/videoplayback?id=example', options: Record<string, unknown> = {}) {
  return createMediaUrl(url, { provider: 'youtube', origin, secret, expiresAt: Date.now() + 60_000, ...options } as unknown as
    { provider: Provider; origin: string; secret: string | undefined; expiresAt: number });
}

test('signed media URL roundtrips through the proxy without buffering binary media', async () => {
  const url = await mediaUrl();
  assert.equal(new URL(url).origin, origin);
  assert.equal(new URL(url).pathname, '/api/media');
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
  const response = await handleMedia(new Request(url, { headers: {
    Range: 'bytes=100-102', 'If-Range': '"version-1"', Cookie: 'session=private', Authorization: 'Bearer private',
  } }), env, { fetch: async (upstream, init) => {
    assert.equal(upstream, 'https://video.googlevideo.com/videoplayback?id=example');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual([...(init?.headers as Headers).entries()], [['if-range', '"version-1"'], ['range', 'bytes=100-102']]);
    return new Response(stream, { status: 206, headers: {
      'Content-Type': 'video/mp4', 'Content-Length': '3', 'Content-Range': 'bytes 100-102/1000',
      'Accept-Ranges': 'bytes', ETag: '"version-1"', 'Last-Modified': 'Wed, 09 Sep 2026 00:00:00 GMT',
      'Set-Cookie': 'upstream=private', 'Access-Control-Allow-Origin': '*',
    } });
  } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Type'), 'video/mp4');
  assert.equal(response.headers.get('Content-Length'), '3');
  assert.equal(response.headers.get('Content-Range'), 'bytes 100-102/1000');
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(response.headers.get('ETag'), '"version-1"');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const reader = response.body!.getReader();
  streamController.enqueue(new Uint8Array([1, 2, 3]));
  assert.deepEqual(await reader.read(), { value: new Uint8Array([1, 2, 3]), done: false });
  streamController.close();
  assert.equal((await reader.read()).done, true);
});

test('only configured secrets can sign or serve media', async () => {
  await assert.rejects(mediaUrl(undefined, { secret: 'too-short' }), { code: 'MEDIA_NOT_CONFIGURED', status: 503 });
  const response = await handleMedia(new Request(await mediaUrl()), {} as unknown as Env, { fetch: () => assert.fail('No upstream request') });
  assert.equal(response.status, 503);
  assert.equal((await response.json() as Node).code, 'MEDIA_NOT_CONFIGURED');
});

test('rejects tampered payloads and signatures before any upstream request', async () => {
  const url = new URL(await mediaUrl());
  const original = url.searchParams.get('token')!;
  for (const token of [original.replace(/^./, original[0] === 'a' ? 'b' : 'a'), original.slice(0, -3) + 'xyz', original + '.', 'invalid', 'x'.repeat(8193)]) {
    url.searchParams.set('token', token);
    const response = await handleMedia(new Request(url), env, { fetch: () => assert.fail('No upstream request') });
    assert.ok([400, 403].includes(response.status));
    assert.equal((await response.json() as Node).code, 'MEDIA_INVALID_TOKEN');
  }
});

test('expired media links require loading the video again', async (context) => {
  const expiresAt = Date.now() + 60_000;
  const url = await mediaUrl(undefined, { expiresAt });
  context.mock.method(Date, 'now', () => expiresAt + 1);
  const response = await handleMedia(new Request(url), env, { fetch: () => assert.fail('Expired link must not fetch') });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as Node).code, 'MEDIA_EXPIRED');
});

test('signing rejects SSRF targets, provider mismatches, credentials, fragments, and ports', async () => {
  for (const url of [
    'http://video.googlevideo.com/file', 'https://googlevideo.com.evil.test/file', 'https://evilgooglevideo.com/file',
    'https://127.0.0.1/file', 'https://[::1]/file', 'https://localhost/file', 'https://metadata.internal/file',
    'https://video.googlevideo.com:8443/file', 'https://user:password@video.googlevideo.com/file',
    'https://video.googlevideo.com/file#fragment', 'https://usher.ttvnw.net/file', 'file:///etc/passwd',
  ]) {
    await assert.rejects(mediaUrl(url), { status: 403, code: 'MEDIA_FORBIDDEN_URL' });
  }
  await assert.rejects(mediaUrl('not a url'), { status: 400 });
  await assert.rejects(mediaUrl(undefined, { provider: 'unknown' }), { status: 403 });
  await assert.rejects(mediaUrl('https://video.googlevideo.com/' + 'x'.repeat(8192)), { status: 400 });
});

test('redirects are followed only within the signed provider', async () => {
  const requests: string[] = [];
  const response = await handleMedia(new Request(await mediaUrl()), env, { fetch: async (url, init) => {
    assert.equal(init?.redirect, 'manual');
    requests.push(url as string);
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { Location: 'https://other.googlevideo.com/final' } })
      : new Response('video', { headers: { 'Content-Type': 'video/mp4' } });
  } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'video');
  assert.deepEqual(requests, ['https://video.googlevideo.com/videoplayback?id=example', 'https://other.googlevideo.com/final']);
  for (const target of ['https://evil.test/file', 'https://video.googlevideo.com.evil.test/file', 'https://usher.ttvnw.net/file', 'http://video.googlevideo.com/file']) {
    let count = 0;
    const blocked = await handleMedia(new Request(await mediaUrl()), env, { fetch: async () => {
      assert.equal(++count, 1);
      return new Response(null, { status: 307, headers: { Location: target } });
    } });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json() as Node).code, 'MEDIA_FORBIDDEN_URL');
  }
});

test('redirect loops stop after three redirects', async () => {
  let count = 0;
  const response = await handleMedia(new Request(await mediaUrl()), env, { fetch: async () => {
    count++;
    return new Response(null, { status: 302, headers: { Location: '/again' } });
  } });
  assert.equal(response.status, 502);
  assert.equal(count, 4);
});

test('HLS variants, keys, maps, media and iframe attributes use signed URLs and final redirect base', async (context) => {
  const expiresAt = Date.now() + 60_000;
  const parent = await mediaUrl('https://usher.ttvnw.net/start.m3u8', { provider: 'twitch', expiresAt });
  const manifest = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/main.key",IV=0x1234',
    '#EXT-X-MAP:URI="../init.mp4",BYTERANGE="100@0"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",URI="audio.m3u8"',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,URI="https://other.ttvnw.net/iframe.m3u8"',
    '#EXT-X-RENDITION-REPORT:URI="other.m3u8",LAST-MSN=1',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000',
    'variant.m3u8?quality=source',
    '',
  ].join('\r\n');
  const response = await handleMedia(new Request(parent), env, { fetch: async (url) => {
    if (url === 'https://usher.ttvnw.net/start.m3u8') {
      return new Response(null, { status: 302, headers: { Location: 'https://edge.ttvnw.net/live/master.m3u8' } });
    }
    assert.equal(url, 'https://edge.ttvnw.net/live/master.m3u8');
    return new Response(manifest, { headers: {
      'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': String(manifest.length), ETag: '"stale"', 'Accept-Ranges': 'bytes',
    } });
  } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Length'), null);
  assert.equal(response.headers.get('ETag'), null);
  assert.equal(response.headers.get('Accept-Ranges'), null);
  const rewritten = await response.text();
  assert.match(rewritten, /IV=0x1234/);
  assert.match(rewritten, /BYTERANGE="100@0"/);
  assert.doesNotMatch(rewritten, /https:\/\/(?:edge|other)\.ttvnw.net/);
  const signedChildren = [
    ...[...rewritten.matchAll(/URI="([^"]+)"/g)].map(match => match[1]),
    ...rewritten.split('\n').filter(line => line && !line.startsWith('#')),
  ];
  const upstreamChildren: string[] = [];
  for (const child of signedChildren) {
    assert.equal(new URL(child).origin, origin);
    const childResponse = await handleMedia(new Request(child), env, { fetch: async url => {
      upstreamChildren.push(url as string);
      return new Response('#EXTM3U\n#EXTINF:6,\npart.ts\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    } });
    assert.equal(childResponse.status, 200);
    const childText = await childResponse.text();
    const nested = childText.split('\n').find(line => line.startsWith('https://'))!;
    assert.equal(new URL(nested).origin, origin);
  }
  assert.deepEqual(upstreamChildren, [
    'https://edge.ttvnw.net/live/keys/main.key', 'https://edge.ttvnw.net/init.mp4',
    'https://edge.ttvnw.net/live/audio.m3u8', 'https://other.ttvnw.net/iframe.m3u8',
    'https://edge.ttvnw.net/live/other.m3u8', 'https://edge.ttvnw.net/live/variant.m3u8?quality=source',
  ]);
  context.mock.method(Date, 'now', () => expiresAt + 1);
  const expiredChild = await handleMedia(new Request(signedChildren[0]), env, { fetch: () => assert.fail('Expiry must be inherited') });
  assert.equal((await expiredChild.json() as Node).code, 'MEDIA_EXPIRED');
});

test('YouTube playlists are recognized by content type when the path has no extension', async () => {
  const response = await handleMedia(new Request(await mediaUrl('https://manifest.googlevideo.com/api/manifest/hls')), env, {
    fetch: async () => new Response('#EXTM3U\n#EXTINF:5,\nhttps://video.googlevideo.com/segment\n', {
      headers: { 'Content-Type': 'application/x-mpegURL' },
    }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /https:\/\/player.example\/api\/media\?token=/);
});

test('YouTube masters expose H.264/AAC-LC up to 480p with matching audio and no subtitle requests', async () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="233",NAME="Low bitrate",URI="he-aac.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="Original, English",DEFAULT=YES,URI="aac-original.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="Spanish",LANGUAGE="es",URI="aac-spanish.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="https://www.youtube.com/timedtext.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="unused",NAME="Unused",URI="unused.m3u8"',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,URI="iframe.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=300000,CODECS="avc1.4D401E,mp4a.40.2",RESOLUTION=640x360,AUDIO="234",SUBTITLES="subs"',
    '360.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="mp4a.40.2,avc1.4D401F",RESOLUTION=854x480,AUDIO="234",CLOSED-CAPTIONS=NONE',
    '480.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=1280x720,AUDIO="234"',
    '720.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=200000,CODECS="avc1.4D400C,mp4a.40.5",RESOLUTION=320x240,AUDIO="233"',
    'he-aac-video.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="vp09.00.30.08,mp4a.40.2",RESOLUTION=854x480,AUDIO="234"',
    'vp9.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="av01.0.04M.08,mp4a.40.2",RESOLUTION=854x480,AUDIO="234"',
    'av1.m3u8',
    '',
  ].join('\r\n');
  const response = await handleMedia(new Request(await mediaUrl('https://manifest.googlevideo.com/hls/master.m3u8')), env, {
    fetch: async () => new Response(manifest),
  });
  assert.equal(response.status, 200);
  const rewritten = await response.text();
  assert.match(rewritten, /NAME="Original, English",DEFAULT=YES/);
  assert.match(rewritten, /NAME="Spanish",LANGUAGE="es"/);
  assert.match(rewritten, /RESOLUTION=640x360,AUDIO="234"\n/);
  assert.match(rewritten, /RESOLUTION=854x480,AUDIO="234",CLOSED-CAPTIONS=NONE/);
  assert.doesNotMatch(rewritten, /SUBTITLES|I-FRAME|Low bitrate|Unused|1280x720|mp4a\.40\.5|vp09|av01/);
  const children = [
    ...[...rewritten.matchAll(/URI="([^"]+)"/g)].map(match => match[1]),
    ...rewritten.split('\n').filter(line => line && !line.startsWith('#')),
  ];
  const upstreamChildren: string[] = [];
  for (const child of children) {
    const fetched = await handleMedia(new Request(child), env, { fetch: async url => {
      upstreamChildren.push(url as string);
      return new Response('#EXTM3U\n#EXTINF:5,\npart.ts\n#EXT-X-ENDLIST\n');
    } });
    assert.equal(fetched.status, 200);
    assert.match(await fetched.text(), /#EXT-X-ENDLIST/);
  }
  assert.deepEqual(upstreamChildren, [
    'https://manifest.googlevideo.com/hls/aac-original.m3u8',
    'https://manifest.googlevideo.com/hls/aac-spanish.m3u8',
    'https://manifest.googlevideo.com/hls/360.m3u8',
    'https://manifest.googlevideo.com/hls/480.m3u8',
  ]);
});

test('removing YouTube subtitle attributes preserves variant syntax in every attribute position', async () => {
  const fields = ['BANDWIDTH=100000', 'CODECS="avc1.4D400C,mp4a.40.2"', 'RESOLUTION=320x240'];
  for (const position of [0, 1, fields.length]) {
    const attributes = [...fields];
    attributes.splice(position, 0, 'SUBTITLES="captions"');
    const response = await handleMedia(new Request(await mediaUrl('https://manifest.googlevideo.com/master.m3u8')), env, {
      fetch: async () => new Response(`#EXTM3U\n#EXT-X-STREAM-INF:${attributes.join(',')}\nvideo.m3u8\n`),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.text()).split('\n')[1], `#EXT-X-STREAM-INF:${fields.join(',')}`);
  }
});

test('YouTube original audio starts first and is default while every compatible language remains selectable', async () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-MEDIA:URI="spanish.m3u8",TYPE=AUDIO,GROUP-ID="234",LANGUAGE="es-419",NAME="Español latinoamericano - dubbed",DEFAULT=NO,AUTOSELECT=YES',
    '#EXT-X-MEDIA:URI="hindi.m3u8",TYPE=AUDIO,GROUP-ID="234",LANGUAGE="hi",NAME="हिन्दी - dubbed",DEFAULT=NO,AUTOSELECT=YES',
    '#EXT-X-MEDIA:URI="portuguese.m3u8",TYPE=AUDIO,GROUP-ID="234",LANGUAGE="pt-BR",NAME="Português (Brasil) - dubbed",DEFAULT=NO,AUTOSELECT=YES',
    '#EXT-X-MEDIA:URI="english.m3u8",TYPE=AUDIO,GROUP-ID="234",LANGUAGE="en",NAME="English - original",YT-EXT-XTAGS="ChEKBWFjb250EghvcmlnaW5hbAoKCgRsYW5nEgJlbg",DEFAULT=NO,AUTOSELECT=NO',
    '#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="avc1.4D401E,mp4a.40.2",RESOLUTION=640x360,AUDIO="234"',
    'video.m3u8',
  ].join('\n');
  const response = await handleMedia(new Request(await mediaUrl('https://manifest.googlevideo.com/master.m3u8')), env, {
    fetch: async () => new Response(manifest),
  });
  assert.equal(response.status, 200);
  const tracks = (await response.text()).split('\n').filter(line => line.startsWith('#EXT-X-MEDIA:'));
  assert.deepEqual(tracks.map(line => line.match(/LANGUAGE="([^"]+)"/)![1]), ['en', 'es-419', 'hi', 'pt-BR']);
  assert.match(tracks[0], /NAME="English - original"/);
  assert.match(tracks[0], /DEFAULT=YES,AUTOSELECT=YES/);
  assert.equal(tracks.filter(line => line.includes('DEFAULT=YES')).length, 1);
  const upstreamTracks: string[] = [];
  for (const track of tracks) {
    const url = track.match(/URI="([^"]+)"/)![1];
    const media = await handleMedia(new Request(url), env, { fetch: async upstream => {
      upstreamTracks.push(new URL(upstream as string | URL).pathname);
      return new Response('#EXTM3U\n#EXTINF:5,\nsegment.aac\n#EXT-X-ENDLIST\n');
    } });
    assert.equal(media.status, 200);
  }
  assert.deepEqual(upstreamTracks, ['/english.m3u8', '/spanish.m3u8', '/hindi.m3u8', '/portuguese.m3u8']);
});

test('original audio preference is per group and does not assume English is original', async () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English - dubbed",LANGUAGE="en",DEFAULT=YES,URI="en.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Français - original",LANGUAGE="fr",URI="fr.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="b",NAME="Japanese - dubbed",LANGUAGE="ja",URI="ja.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="b",NAME="Deutsch - original",LANGUAGE="de",DEFAULT=NO,URI="de.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1.4D401E,mp4a.40.2",RESOLUTION=640x360,AUDIO="a"',
    'a.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.4D401E,mp4a.40.2",RESOLUTION=854x480,AUDIO="b"',
    'b.m3u8',
  ].join('\n');
  const response = await handleMedia(new Request(await mediaUrl('https://manifest.googlevideo.com/master.m3u8')), env, { fetch: async () => new Response(manifest) });
  const tracks = (await response.text()).split('\n').filter(line => line.startsWith('#EXT-X-MEDIA:'));
  assert.deepEqual(tracks.map(line => line.match(/LANGUAGE="([^"]+)"/)![1]), ['fr', 'en', 'de', 'ja']);
  assert.deepEqual(tracks.map(line => line.match(/DEFAULT=(YES|NO)/)![1]), ['YES', 'NO', 'YES', 'NO']);
  assert.ok(tracks[0].includes('AUTOSELECT=YES') && tracks[2].includes('AUTOSELECT=YES'));
});

test('without an original marker YouTube keeps its declared default and otherwise preserves order', async () => {
  for (const declaredDefault of [true, false]) {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Deutsch",LANGUAGE="de",DEFAULT=NO,URI="de.m3u8"',
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=${declaredDefault ? 'YES' : 'NO'},URI="en.m3u8"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1.4D401E,mp4a.40.2",RESOLUTION=640x360,AUDIO="a"',
      'video.m3u8',
    ].join('\n');
    const response = await handleMedia(new Request(await mediaUrl('https://manifest.googlevideo.com/master.m3u8')), env, { fetch: async () => new Response(manifest) });
    const tracks = (await response.text()).split('\n').filter(line => line.startsWith('#EXT-X-MEDIA:'));
    assert.deepEqual(tracks.map(line => line.match(/LANGUAGE="([^"]+)"/)![1]), declaredDefault ? ['en', 'de'] : ['de', 'en']);
    assert.equal(tracks.filter(line => line.includes('DEFAULT=YES')).length, declaredDefault ? 1 : 0);
  }
});

test('YouTube masters with no compatible variant return a useful error instead of an unplayable playlist', async () => {
  for (const attributes of [
    'CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=1280x720',
    'CODECS="vp09.00.30.08,mp4a.40.2",RESOLUTION=854x480',
    'CODECS="avc1.4D401F,opus",RESOLUTION=854x480',
    'CODECS="avc1.4D401F,mp4a.40.5",RESOLUTION=854x480',
    'CODECS="avc1.4D401F,mp4a.40.2"',
    'CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=854x0',
    'CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=854x480,AUDIO="missing"',
    'CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=854x480,VIDEO="unbounded"',
  ]) {
    const response = await handleMedia(new Request(await mediaUrl('https://manifest.googlevideo.com/master.m3u8')), env, {
      fetch: async () => new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,${attributes}\nvariant.m3u8\n`),
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json() as Node, {
      error: 'This YouTube video has no compatible stream at 480p or lower. Try another video.',
      code: 'YOUTUBE_FORMAT_UNAVAILABLE',
    });
  }
});

test('muxed YouTube variants do not require audio groups and media playlists retain their timing and range tags', async () => {
  const manifest = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="avc1.4D400C,mp4a.40.2",RESOLUTION=320x240\nmuxed.m3u8\n';
  const response = await handleMedia(new Request(await mediaUrl('https://manifest.googlevideo.com/master.m3u8')), env, {
    fetch: async () => new Response(manifest),
  });
  assert.equal(response.status, 200);
  const child = (await response.text()).split('\n').find(line => line.startsWith('https://'))!;
  const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:52\n#EXT-X-DISCONTINUITY\n#EXTINF:5.125,\n#EXT-X-BYTERANGE:100@32\npart.ts\n#EXT-X-ENDLIST\n';
  const fetched = await handleMedia(new Request(child), env, { fetch: async () => new Response(playlist) });
  assert.equal(fetched.status, 200);
  const rewritten = await fetched.text();
  assert.equal(rewritten.replace(/https:\/\/[^\n]+/, 'part.ts'), playlist);
});

test('malformed YouTube master attributes and missing variant URLs fail explicitly', async () => {
  for (const manifest of [
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS="avc1.4D400C,mp4a.40.2",RESOLUTION=320x240\n',
    '#EXTM3U\n#EXT-X-STREAM-INF:CODECS="avc1.4D400C,mp4a.40.2",CODECS="avc1.4D400C,mp4a.40.2",RESOLUTION=320x240\nvariant.m3u8\n',
  ]) {
    const response = await handleMedia(new Request(await mediaUrl('https://manifest.googlevideo.com/master.m3u8')), env, {
      fetch: async () => new Response(manifest),
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json() as Node).code, 'MEDIA_INVALID_MANIFEST');
  }
});

test('invalid, oversized, and forbidden manifest references fail safely', async () => {
  for (const manifest of [
    '<html>private upstream error</html>', '#EXTM3U\n' + 'x'.repeat(2_097_152),
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=unquoted.key\n',
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://localhost/private"\n',
    '#EXTM3U\nhttps://googlevideo.com.evil.test/private\n',
    '#EXTM3U\n#EXT-X-MAP:URI=""\n',
  ]) {
    const response = await handleMedia(new Request(await mediaUrl('https://video.googlevideo.com/master.m3u8')), env, {
      fetch: async () => new Response(manifest),
    });
    assert.ok([400, 403, 502].includes(response.status));
    const error = await response.text();
    assert.doesNotMatch(error, /private upstream|localhost|evil.test|token=/);
  }
});

test('HEAD preserves media metadata and 416 preserves range information without upstream error bodies', async () => {
  const url = await mediaUrl();
  const response = await handleMedia(new Request(url, { method: 'HEAD' }), env, { fetch: async (upstream, init) => {
    assert.equal(init?.method, 'HEAD');
    return new Response(null, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '1000' } });
  } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('Content-Length'), '1000');
  const unavailable = await handleMedia(new Request(url, { headers: { Range: 'bytes=1000-' } }), env, {
    fetch: async () => new Response('private upstream details', { status: 416, headers: { 'Content-Range': 'bytes */1000', 'Content-Length': '24' } }),
  });
  assert.equal(unavailable.status, 416);
  assert.equal(unavailable.headers.get('Content-Range'), 'bytes */1000');
  assert.equal(unavailable.headers.get('Content-Length'), null);
  assert.equal(await unavailable.text(), '');
});

test('invalid requests and unsupported methods never fetch upstream', async () => {
  const fetch = () => assert.fail('No upstream request');
  for (const url of [`${origin}/api/media`, `${origin}/api/media?token=a&token=b`]) {
    assert.equal((await handleMedia(new Request(url), env, { fetch })).status, 400);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await handleMedia(new Request(await mediaUrl(), { method }), env, { fetch });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  }
});

test('upstream failures and timeouts have sanitized errors', async () => {
  const url = await mediaUrl();
  for (const failure of [new Error('secret upstream URL'), new DOMException('secret timeout', 'AbortError')]) {
    const response = await handleMedia(new Request(url), env, { fetch: async () => { throw failure; } });
    assert.equal(response.status, failure.name === 'AbortError' ? 504 : 502);
    assert.doesNotMatch(await response.text(), /secret/);
  }
  const response = await handleMedia(new Request(url), env, {
    fetch: async () => new Response('secret upstream details', { status: 403 }),
  });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret/);
});

test('stalled upstream headers time out without imposing a deadline on binary playback', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let fetchStarted!: () => void;
  const started = new Promise<void>(resolve => { fetchStarted = resolve; });
  const url = await mediaUrl();
  const pending = handleMedia(new Request(url), env, { fetch: async (upstream, init) => {
    fetchStarted();
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  } });
  await started;
  context.mock.timers.tick(15_001);
  const timedOut = await pending;
  assert.equal(timedOut.status, 504);
  assert.equal((await timedOut.json() as Node).code, 'MEDIA_TIMEOUT');

  let signal: AbortSignal | undefined;
  const playing = await handleMedia(new Request(url), env, { fetch: async (upstream, init) => {
    signal = init?.signal ?? undefined;
    return new Response('still playing', { headers: { 'Content-Type': 'video/mp4' } });
  } });
  context.mock.timers.tick(30_000);
  assert.equal(signal!.aborted, false);
  assert.equal(await playing.text(), 'still playing');
});
