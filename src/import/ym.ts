// .ym loader: YM2!/YM3!/YM3b/YM5!/YM6! (LHA-packed or raw) -> 14 registers per 50 Hz frame.
import { isLha, lhaExtract } from './lha';
import type { AyTune } from './tune';
import { type FxTrack, type FxKind, FX_SID, FX_SINUS, FX_SYNC, fxSettingHz, packFx, MAX_FX_HZ } from '../core/fx';
import { type DrumSample, type DrumTrack, MFP_PREDIV, nearestDac, trigCode, silenceDrumVoices, MAX_DRUMS } from '../core/drums';

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
  const rawDrums: Uint8Array[] = [];
  let drumSigned = false, drum4 = false;

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
    drumSigned = (attr & 2) !== 0; drum4 = (attr & 4) !== 0;
    for (let i = 0; i < ndrums; i++) { const n = u32(d, p); rawDrums.push(d.slice(p + 4, p + 4 + n)); p += 4 + n; }
    [title, p] = cstr(d, p); [author, p] = cstr(d, p); [comment, p] = cstr(d, p);
    const il = (attr & 1) !== 0;
    if (il) regsIn = deinterleave(p, 16, nframes);
    else { regsIn = new Uint8Array(nframes * 16); regsIn.set(d.subarray(p, p + nframes * 16)); }
    if (magic === 'YM6!') {
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
  let drums: DrumTrack | undefined;
  if (rawDrums.length) {
    const samples: DrumSample[] = rawDrums.slice(0, MAX_DRUMS).map((raw, i) => ({
      name: `Drum ${i + 1}`, rateHz: 8000,
      pcm: Uint8Array.from(raw, (b) => (drum4 ? b & 15 : nearestDac((drumSigned ? (b ^ 0x80) : b) / 255))),
    }));
    const trig = new Uint8Array(outN);
    let used = 0;
    for (let f = 0; f < outN; f++) {
      const sf = Math.min(nframes - 1, fps === 50 ? f : Math.floor((f * fps) / 50));
      const r = regsIn.subarray(sf * 16, sf * 16 + 16);
      const slots = magic === 'YM6!'
        ? [{ code: r[1] & 0xf0, pre: (r[6] >> 5) & 7, cnt: r[14] }, { code: r[3] & 0xf0, pre: (r[8] >> 5) & 7, cnt: r[15] }]
        : [{ code: ((r[3] >> 4) & 3) ? 0x40 | (r[3] & 0x30) : 0, pre: (r[8] >> 5) & 7, cnt: r[15] }];     // YM5: digidrum = effect 2
      for (const sl of slots) {
        if (!(sl.code & 0x30) || (sl.code & 0xc0) !== 0x40) continue;
        const v = ((sl.code & 0x30) >> 4) - 1, n = r[8 + v] & 31;
        const hz = MFP_PREDIV[sl.pre] * sl.cnt ? 2_457_600 / (MFP_PREDIV[sl.pre] * sl.cnt) : 0;
        if (n < samples.length && hz > 0) { samples[n].rateHz = hz; trig[f] = trigCode(v, n); used++; break; }
      }
    }
    if (used) {
      drums = { drums: samples, trig };
      for (let f = 0; f < outN; f++) {                       // the drum number sits in the volume register of that frame
        const t = trig[f];
        if (t) regs[f * 14 + 8 + ((t >> 6) - 1)] = 0;
      }
      silenceDrumVoices(regs, outN, drums);
      warnings.push(`${used} digidrum trigger(s) imported (${samples.length} sample(s))`);
    }
  }
  // ---- YM6 timer effects: SID voice / sinus-SID / sync-buzzer, re-specified in every frame they run
  let fx: FxTrack | undefined;
  if (magic === 'YM6!') {
    const track = new Uint32Array(outN);
    let used = 0, many = 0, clamped = 0;
    for (let f = 0; f < outN; f++) {
      const sf = Math.min(nframes - 1, fps === 50 ? f : Math.floor((f * fps) / 50));
      const r = regsIn.subarray(sf * 16, sf * 16 + 16);
      const slots = [{ code: r[1] & 0xf0, pre: (r[6] >> 5) & 7, cnt: r[14] }, { code: r[3] & 0xf0, pre: (r[8] >> 5) & 7, cnt: r[15] }];
      let found = false;
      for (const sl of slots) {
        const v = ((sl.code & 0x30) >> 4) - 1, type = sl.code & 0xc0;
        if (v < 0 || v > 2 || type === 0x40) continue;
        const kind: FxKind = type === 0 ? FX_SID : type === 0x80 ? FX_SINUS : FX_SYNC;
        const div = MFP_PREDIV[sl.pre] * sl.cnt;
        if (!div) continue;
        if (found) { many++; continue; }
        const hz = 2_457_600 / div;
        const set = fxSettingHz(kind, v, hz);
        if (!set) continue;
        if (hz > MAX_FX_HZ / (kind === FX_SINUS ? 32 : 1) || set.clamped) clamped++;
        track[f] = packFx(set); found = true; used++;
      }
    }
    if (used) {
      fx = track;
      let shape = -1;                                          // a sync-buzzer repeats the shape every frame: only a change matters
      for (let f = 0; f < outN; f++) {
        const sh = regs[f * 14 + 13];
        if (sh === 0xff) continue;
        if (f > 0 && track[f] === track[f - 1] && (track[f] >>> 16 & 3) === FX_SYNC && sh === shape) regs[f * 14 + 13] = 0xff;
        shape = sh;
      }
      warnings.push(`${used} timer-effect frame(s) imported (SID / sinus-SID / sync-buzzer)`);
      if (many) warnings.push(`${many} frame(s) start a second effect; the ST has one timer to spare, only the first one is kept`);
      if (clamped) warnings.push(`${clamped} timer-effect frame(s) are outside what the MFP can do and were clamped`);
    }
  }
  return {
    title, author, comment, regs, nframes: outN, source: 'ym', warnings, drums, fx,
    loopFrame: Math.min(outN - 1, fps === 50 ? loopFrame : Math.round((loopFrame * 50) / fps)),
  };
}
