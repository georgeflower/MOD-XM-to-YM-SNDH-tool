// The digidrum table read by the 68000 drum engine (src/player68k/drumeng.s).
import { type DrumSample, mfpRate } from '../core/drums';

/** big-endian: .w count, count x (.l pcm offset, .w length, .b prescaler code, .b data), then the PCM bytes */
export function packDrumTable(drums: DrumSample[]): Uint8Array {
  const head = 2 + drums.length * 8;
  const total = drums.reduce((n, d) => n + d.pcm.length, 0);
  const out = new Uint8Array(head + total + ((head + total) & 1));
  const dv = new DataView(out.buffer);
  dv.setUint16(0, drums.length);
  let off = head;
  drums.forEach((d, i) => {
    const r = mfpRate(d.rateHz);
    dv.setUint32(2 + i * 8, off);
    dv.setUint16(2 + i * 8 + 4, d.pcm.length);
    out[2 + i * 8 + 6] = r.code;
    out[2 + i * 8 + 7] = r.count & 255;          // 256 is written as 0 by the MFP, but mfpRate keeps count <= 255
    for (let k = 0; k < d.pcm.length; k++) out[off + k] = d.pcm[k] & 15;
    off += d.pcm.length;
  });
  return out;
}
