export const MAX_IMAGE = 8 * 1024 * 1024;
export const MAX_RECORD_SECONDS = 15;

export function picture(bytes) {
  if (bytes.length < 12 || bytes.length > MAX_IMAGE) throw new Error('图片需小于 8 MB');
  let mime;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'image/jpeg';
  else if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) mime = 'image/gif';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  else throw new Error('请选择 PNG、JPEG、GIF 或 WebP 图片');
  return { bytes, mime };
}

export function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return { mime: 'audio/wav', bytes: Buffer.concat([header, pcm]) };
}

export function audioInput(pcm) {
  if (pcm.length < 8000 || pcm.length > 32000 * MAX_RECORD_SECONDS || pcm.length % 2)
    throw new Error('录音需要 0.25 至 15 秒，请重新录制');
  return pcm;
}
