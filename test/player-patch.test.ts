import test from 'node:test';
import assert from 'node:assert/strict';
import { probeId3Audio, patchPlayer } from '../scripts/patch-player.ts';

interface TaggedAudioOptions {
  version?: number;
  flags?: number;
  tagSize?: number;
  audio?: number[];
  footer?: boolean;
}

function taggedAudio({ version = 4, flags = 0, tagSize = 5, audio = [0xff, 0xf1], footer = false }: TaggedAudioOptions = {}): Uint8Array {
  const offset = 10 + tagSize + (footer ? 10 : 0);
  const bytes = new Uint8Array(offset + audio.length);
  bytes.set([0x49, 0x44, 0x33, version, 0, flags,
    tagSize >>> 21 & 127, tagSize >>> 14 & 127, tagSize >>> 7 & 127, tagSize & 127]);
  bytes.set(audio, offset);
  return bytes;
}

function reader(bytes: Uint8Array): { peekBuffer(length: number): Promise<Uint8Array> } {
  return { async peekBuffer(length: number) {
    if (length > bytes.length) throw new Error('Short read');
    return bytes.subarray(0, length);
  } };
}

test('ID3 followed by ADTS AAC selects the AAC demuxer', async () => {
  for (const audio of [[0xff, 0xf1], [0xff, 0xf9], [0xff, 0xf0], [0xff, 0xf8]]) {
    assert.equal(await probeId3Audio(reader(taggedAudio({ audio }))), 15);
  }
});

test('ID3 followed by MPEG audio retains the MP3 demuxer', async () => {
  for (const audio of [[0xff, 0xfb], [0xff, 0xfa], [0xff, 0xf3], [0, 0]]) {
    assert.equal(await probeId3Audio(reader(taggedAudio({ audio }))), 14);
  }
});

test('ID3v2.3 flag 16 is not interpreted as an ID3v2.4 footer', async () => {
  assert.equal(await probeId3Audio(reader(taggedAudio({ version: 3, flags: 16 }))), 15);
});

test('ID3v2.4 footer is skipped before inspecting AAC bytes', async () => {
  assert.equal(await probeId3Audio(reader(taggedAudio({ version: 4, flags: 16, footer: true }))), 15);
});

test('the ID3 probe bounds lookahead for oversized tags', async () => {
  const bytes = taggedAudio({ tagSize: 4090 });
  const reads: number[] = [];
  assert.equal(await probeId3Audio({ async peekBuffer(length: number) {
    reads.push(length);
    return bytes.subarray(0, length);
  } }), 14);
  assert.deepEqual(reads, [10]);
});

test('short headers, truncated tags and rejected reads retain safe MP3 detection', async () => {
  for (const bytes of [new Uint8Array(0), new Uint8Array(9), taggedAudio().subarray(0, 12)]) {
    assert.equal(await probeId3Audio(reader(bytes)), 14);
  }
  assert.equal(await probeId3Audio({ peekBuffer: async () => { throw new Error('Reader unavailable'); } }), 14);
  assert.equal(await probeId3Audio({ peekBuffer: async () => new Uint8Array(1) }), 14);
});

type Detect = (marker: string, reader: { peekBuffer(length: number): Promise<Uint8Array> }) => Promise<number>;
interface IPCInstance {
  port: { postMessage(message: unknown): void } | null;
  closed: boolean;
  reply(e: unknown, t: unknown, i: unknown): void;
}
type IPCConstructor = new () => IPCInstance;

test('player patch requires exactly one pinned match and executes the AAC probe', async () => {
  const source = 'async function detect(i,e){if(/^ID3/.test(i))return 14;return 0;}class IPC{reply(e,t,i){let r=arguments.length>3;this.port.postMessage({e,t,i,r});}}';
  const patched = patchPlayer(source);
  const detect = new Function(`${patched};return detect;`)() as Detect;
  assert.equal(await detect('ID3', reader(taggedAudio())), 15);
  assert.equal(await detect('ID3', reader(taggedAudio({ audio: [0xff, 0xfb] }))), 14);
  assert.equal(await detect('OTHER', reader(new Uint8Array())), 0);
  for (const changed of ['', source + source, patched]) {
    assert.throws(() => patchPlayer(changed), /pinned player ID3 probe changed/);
  }
  assert.throws(() => patchPlayer(source.replace('reply(e,t,i)', 'reply(e,t)')), /pinned player IPC reply changed/);
  const IPC = new Function(`${patched};return IPC;`)() as IPCConstructor;
  const ipc = new IPC();
  const messages: unknown[] = [];
  ipc.port = { postMessage: message => messages.push(message) };
  ipc.reply(1, 2, 3);
  assert.equal(messages.length, 1);
  ipc.closed = true;
  ipc.port = null;
  assert.doesNotThrow(() => ipc.reply(4, 5, 6));
  assert.equal(messages.length, 1);
});
