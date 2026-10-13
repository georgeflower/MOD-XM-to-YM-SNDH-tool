// .ym loader: YM2!/YM3!/YM3b/YM5!/YM6! (LHA-packed or raw) -> 14 registers per 50 Hz frame.
import { isLha, lhaExtract } from './lha';
import type { AyTune } from './tune';

const ST_CLOCK = 2_000_000;
const u32 = (d: Uint8Array, p: number) => ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
const u16 = (d: Uint8Array, p: number) => (d[p] << 8) | d[p + 1];
const tag = (d: Uint8Array, p: number, n = 4) => String.fromCharCode(...d.subarray(p, p + n));

export function isYm(d: Uint8Array): boolean {
  if (isLha(d)) return true;
  return /^(YM[2-6]!|YM3b|MIX1)/.test(tag(d, 0));
}

function cstr(d: Uint8Array, p: number): [string, number] {
  let e = p;
  while (e < d.length && d[e] !== 0) e++;
  return [tag(d, p, e - p), e + 1];
}

export function parseYm(file: Uint8Array): AyTune {
  const d = isLha(file) ? lhaExtract(file).data : file;
  const warnings: string[] = [];
  const magic = tag(d, 0);
  let regsIn: Uint8Array;            // nframes * 16, frame-major
  let nframes = 0, loopFrame = 0, fps = 50, clock = ST_CLOCK;
  let title = '', author = '', comment = '';

  const deinterleave = (p: number, nreg: number, n: number) => {
    const out = new Uint8Array(n * 16);
    for (let r = 0; r < nreg; r++) for (let f = 0; f < n; f++) out[f * 16 + r] = d[p + r * n + f] ?? 0;
    return out;
  };

  if (magic === 'YM2!' || magic === 'YM3!' || magic === 'YM3b') {
    const tail = magic === 'YM3b' ? 4 : 0;
    nframes = Math.floor((d.length - 4 - tail) / 14);
    regsIn = deinterleave(4, 14, nframes);
    if (magic === 'YM3b') loopFrame = u32(d, d.length - 4);
    if (magic === 'YM2!') warnings.push('YM2 "Mad Max" digidrum/effects on R10-R13 are not imported');
  } else if (magic === 'YM5!' || magic === 'YM6!') {
    if (tag(d, 4, 8) !== 'LeOnArD!') throw new Error('YM: bad signature');
    nframes = u32(d, 12);
    const attr = u32(d, 16);
    const ndrums = u16(d, 20);
    clock = u32(d, 22);
    fps = u16(d, 26);
    loopFrame = u32(d, 28);
    let p = 34 + u16(d, 32);
    for (let i = 0; i < ndrums; i++) p += 4 + u32(d, p);
    if (ndrums) warnings.push(`${ndrums} digidrum sample(s) in the file are not imported`);
    [title, p] = cstr(d, p); [author, p] = cstr(d, p); [comment, p] = cstr(d, p);
    const il = (attr & 1) !== 0;
    if (il) regsIn = deinterleave(p, 16, nframes);
    else { regsIn = new Uint8Array(nframes * 16); regsIn.set(d.subarray(p, p + nframes * 16)); }
    if (magic === 'YM6!') {
      let fx = false;
      for (let f = 0; f < nframes && !fx; f++) fx = ((regsIn[f * 16 + 1] | regsIn[f * 16 + 3]) & 0xf0) !== 0;
      if (fx) warnings.push('YM6 timer effects (SID / sinus-SID / sync-buzzer / digidrum) are not reproduced');
    }
  } else if (magic === 'YM4!' || magic === 'YM1!' || magic === 'MIX1') {
    throw new Error(`YM format ${magic} is not supported (use YM2/3/5/6)`);
  } else throw new Error('Not a YM file');

  if (nframes <= 0 || nframes > 2_000_000) throw new Error('YM: bad frame count');

  // ---- bring to the ST: 2 MHz chip clock, 50 Hz frames
  const k = ST_CLOCK / clock;
  const outN = fps === 50 ? nframes : Math.max(1, Math.round((nframes * 50) / fps));
  const regs = new Uint8Array(outN * 14);
  if (clock !== ST_CLOCK) warnings.push(`chip clock ${clock} Hz retuned to the ST's 2 MHz`);
  if (fps !== 50) warnings.push(`${fps} Hz frame rate resampled to 50 Hz`);
  for (let f = 0; f < outN; f++) {
    const sf = Math.min(nframes - 1, fps === 50 ? f : Math.floor((f * fps) / 50));
    const r = regsIn.subarray(sf * 16, sf * 16 + 16);
    const o = regs.subarray(f * 14, f * 14 + 14);
    o.set(r.subarray(0, 14));
    if (clock !== ST_CLOCK) {
      for (let v = 0; v < 3; v++) {
        const per = Math.max(1, Math.min(4095, Math.round((r[2 * v] | ((r[2 * v + 1] & 15) << 8)) * k)));
        o[2 * v] = per & 255; o[2 * v + 1] = per >> 8;
      }
      o[6] = Math.max(1, Math.min(31, Math.round((r[6] & 31) * k)));
      const ep = Math.min(65535, Math.round((r[11] | (r[12] << 8)) * k));
      o[11] = ep & 255; o[12] = ep >> 8;
    }
    o[1] &= 15; o[3] &= 15; o[5] &= 15; o[6] &= 31; o[7] |= 0xc0; o[8] &= 31; o[9] &= 31; o[10] &= 31;
    o[13] = regsIn[sf * 16 + 13];            // 0xFF = "no envelope write this frame" (YM convention, kept)
  }
  return {
    title, author, comment, regs, nframes: outN, source: 'ym', warnings,
    loopFrame: Math.min(outN - 1, fps === 50 ? loopFrame : Math.round((loopFrame * 50) / fps)),
  };
}
