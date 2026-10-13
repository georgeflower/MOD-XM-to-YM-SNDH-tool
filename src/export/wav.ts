export function encodeWav(pcm: Float32Array, sr = 44100, normalise = true): Uint8Array {
  let pk = 0;
  for (let i = 0; i < pcm.length; i++) pk = Math.max(pk, Math.abs(pcm[i]));
  const g = normalise && pk > 0 ? 0.8 / pk : 1;
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(pcm[i] * g * 32767))), true);
  return new Uint8Array(buf);
}
