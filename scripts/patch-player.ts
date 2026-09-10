// libmedia 1.3.1 mistakes ID3-prefixed HLS AAC for MP3. Its AAC demuxer already
// handles the tag and Apple's transport timestamp; select it when ADTS follows.
// This function's source text is injected into the player bundle, so it must stay self-contained.
export async function probeId3Audio(reader: { peekBuffer(length: number): Promise<Uint8Array> }): Promise<number> {
  try {
    const header = await reader.peekBuffer(10);
    const tagSize = ((header[6] & 127) << 21) | ((header[7] & 127) << 14)
      | ((header[8] & 127) << 7) | (header[9] & 127);
    const footer = header[3] === 4 && (header[5] & 16) ? 10 : 0;
    const offset = 10 + tagSize + footer;
    if (offset <= 4096) {
      const bytes = await reader.peekBuffer(offset + 2);
      if (bytes[offset] === 255 && (bytes[offset + 1] & 246) === 240) return 15;
    }
  } catch { /* Preserve MP3 detection for short or unreadable tags. */ }
  return 14;
}

export function patchPlayer(source: string): string {
  const original = 'if(/^ID3/.test(i))return 14;';
  if (source.split(original).length !== 2) {
    throw new Error('The pinned player ID3 probe changed; review the AAC compatibility patch.');
  }
  const reply = 'reply(e,t,i){let r=arguments.length>3';
  if (source.split(reply).length !== 2) {
    throw new Error('The pinned player IPC reply changed; review the cancellation compatibility patch.');
  }
  // Node strips the type annotations before the function is stringified, leaving plain JavaScript.
  return source.replace(original, `if(/^ID3/.test(i))return await (${probeId3Audio.toString()})(e);`)
    // Stop closes the port and rejects pending requests. Late I/O completion has no recipient.
    .replace(reply, 'reply(e,t,i){if(this.closed)return;let r=arguments.length>3');
}
