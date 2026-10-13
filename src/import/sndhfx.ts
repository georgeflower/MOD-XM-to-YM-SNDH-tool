// Turns the log of YM writes made by MFP timer interrupt handlers (see sndh.ts) into what this tool can edit and export:
//   volume register written at a steady rate with many different values   -> digidrum sample
//   volume register toggled between two values                            -> SID voice            (Q)
//   volume register stepping through a repeating wave with silent gaps    -> sinus-SID            (S)
//   R13 rewritten at a steady rate                                        -> sync-buzzer          (U)
// Everything else the handlers write is applied to the frame image as "last value in the frame".
// The log is driver-agnostic: it does not care how the tune's own code produces the writes.
import { type DrumSample, type DrumTrack, MAX_DRUMS, MAX_DRUM_BYTES, MAX_DRUM_HZ, trigCode, silenceDrumVoices } from '../core/drums';
import { type FxTrack, type FxKind, FX_SID, FX_SINUS, FX_SYNC, fxSettingHz, packFx } from '../core/fx';
import { MFP_CLOCK, MFP_FRAME } from './mfp';

export interface IsrLog { t: number[]; reg: number[]; val: number[] }

interface Run {
  reg: number;
  i0: number; i1: number;         // log indices (inclusive), in this register's own list
  t0: number; t1: number;
  hz: number;                     // write rate
  vals: number[]; times: number[];
}

export interface Extracted { drums?: DrumTrack; fx?: FxTrack; warnings: string[] }

const MIN_RUN = 8;
const median = (a: number[]) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };

/** consecutive writes of one register -> runs of steady-rate writes */
function runsOf(reg: number, times: number[], vals: number[]): Run[] {
  const out: Run[] = [];
  let s = 0;
  const close = (e: number) => {
    if (e - s + 1 >= 2) {
      const gaps: number[] = [];
      for (let k = s + 1; k <= e; k++) gaps.push(times[k] - times[k - 1]);
      const g = median(gaps);
      out.push({ reg, i0: s, i1: e, t0: times[s], t1: times[e], hz: g > 0 ? MFP_CLOCK / g : 0, vals: vals.slice(s, e + 1), times: times.slice(s, e + 1) });
    }
  };
  let ref = 0;
  for (let k = 1; k < times.length; k++) {
    const gap = times[k] - times[k - 1];
    if (ref === 0) ref = gap;
    if (gap > 2.5 * ref + 16) { close(k - 1); s = k; ref = 0; } else ref = ref * 0.875 + gap * 0.125;
  }
  close(times.length - 1);
  return out;
}

/** values per frame of a run: [frame, values[]] */
function perFrame(r: Run): { f: number; vals: number[] }[] {
  const out: { f: number; vals: number[] }[] = [];
  for (let k = 0; k < r.vals.length; k++) {
    const f = Math.floor(r.times[k] / MFP_FRAME);
    if (!out.length || out[out.length - 1].f !== f) out.push({ f, vals: [] });
    out[out.length - 1].vals.push(r.vals[k]);
  }
  return out;
}

function isToggling(r: Run): boolean {
  let good = 0, total = 0;
  for (const ch of perFrame(r)) {
    if (ch.vals.length < 2) continue;
    const set = new Set(ch.vals);
    let trans = 0;
    for (let k = 1; k < ch.vals.length; k++) if (ch.vals[k] !== ch.vals[k - 1]) trans++;
    total += ch.vals.length;
    if (set.size <= 2 && trans >= 0.8 * (ch.vals.length - 1)) good += ch.vals.length;
  }
  return total > 0 && good >= 0.8 * total;
}

/** smallest period 4..128 after which the sequence repeats (a few per cent mismatches allowed for level changes) */
function periodOf(v: number[]): number {
  for (let p = 4; p <= 128 && v.length >= 2.5 * p; p++) {
    let bad = 0;
    for (let k = p; k < v.length; k++) if (v[k] !== v[k - p]) bad++;
    if (bad <= 0.05 * (v.length - p)) return p;
  }
  return 0;
}

export function extractTimerEffects(regs: Uint8Array, n: number, log: IsrLog): Extracted {
  const warnings: string[] = [];
  const times: number[][] = Array.from({ length: 16 }, () => []);
  const vals: number[][] = Array.from({ length: 16 }, () => []);
  for (let k = 0; k < log.t.length; k++) { times[log.reg[k]].push(log.t[k]); vals[log.reg[k]].push(log.val[k]); }

  const trig = new Uint8Array(n);
  const fx = new Uint32Array(n);
  const drums: DrumSample[] = [];
  const claimed: Map<number, number[]> = new Map();          // reg -> frames handled by a classified run
  const claim = (reg: number, f0: number, f1: number) => {
    let a = claimed.get(reg); if (!a) { a = []; claimed.set(reg, a); }
    for (let f = f0; f <= f1; f++) a[f] = 1;
  };
  let dropped = 0, nDrumHits = 0, nSid = 0, nSinus = 0, nSync = 0, fxConflict = 0, tooFast = 0, longDrum = 0, tooManyDrums = 0;
  const drumRuns: Run[] = [];
  type FxRun = { run: Run; kind: FxKind; hz: number };
  const fxRuns: FxRun[] = [];

  for (const reg of [8, 9, 10]) {
    if (vals[reg].length < MIN_RUN) continue;
    // a handler that writes twice in one interrupt (sample, then a final "restore") counts once: the first write
    const T: number[] = [], V: number[] = [];
    for (let k = 0; k < times[reg].length; k++) if (k === 0 || times[reg][k] !== times[reg][k - 1]) { T.push(times[reg][k]); V.push(vals[reg][k]); }
    for (const run of runsOf(reg, T, V)) {
      const cnt = run.vals.length;
      if (cnt < MIN_RUN || run.hz < 40) continue;
      if (isToggling(run)) { fxRuns.push({ run, kind: FX_SID, hz: run.hz }); continue; }
      const p = periodOf(run.vals);
      const zeros = run.vals.filter((x) => x === 0).length / cnt;
      if (p && new Set(run.vals).size >= 3 && zeros >= 0.2 && zeros <= 0.8) { fxRuns.push({ run, kind: FX_SINUS, hz: (2 * run.hz) / p }); continue; }   // a full on+off period is two timer ticks, as for the SID voice
      drumRuns.push(run);
    }
  }
  if (vals[13].length >= 4) {
    for (const run of runsOf(13, times[13], vals[13])) {
      if (run.vals.length >= 4 && run.hz >= 40 && run.t1 - run.t0 >= MFP_FRAME * 0.25) fxRuns.push({ run, kind: FX_SYNC, hz: run.hz });
    }
  }

  // ---- timer effects (one at a time: the earliest wins)
  fxRuns.sort((a, b) => a.run.t0 - b.run.t0);
  for (const { run, kind, hz } of fxRuns) {
    const f0 = Math.floor(run.t0 / MFP_FRAME), f1 = Math.min(n - 1, Math.floor(run.t1 / MFP_FRAME));
    if (f0 >= n) continue;
    const voice = run.reg === 13 ? syncVoice(regs, f0) : run.reg - 8;
    const set = fxSettingHz(kind, voice, hz);
    if (!set) continue;
    if (set.clamped) tooFast++;
    let any = false;
    for (let f = f0; f <= f1; f++) {
      if (fx[f]) { fxConflict++; continue; }
      fx[f] = packFx(set); any = true;
    }
    if (!any) continue;
    claim(run.reg, f0, f1);
    const chunks = perFrame(run);
    let lastShape = -1;
    for (const ch of chunks) {
      if (ch.f >= n) break;
      if (kind === FX_SYNC) {
        const sh = ch.vals[0];
        regs[ch.f * 14 + 13] = ch.f === f0 || sh !== lastShape ? sh : 0xff;
        lastShape = sh;
      } else {
        regs[ch.f * 14 + run.reg] = Math.max(...ch.vals);        // the level the handler modulates
      }
    }
    if (kind === FX_SID) nSid++; else if (kind === FX_SINUS) nSinus++; else nSync++;
  }

  // ---- digidrums
  drumRuns.sort((a, b) => a.t0 - b.t0);
  let busyUntil = -1;
  for (const run of drumRuns) {
    const f0 = Math.floor(run.t0 / MFP_FRAME);
    if (f0 >= n) continue;
    const f1 = Math.min(n - 1, Math.floor(run.t1 / MFP_FRAME));
    if (run.t0 < busyUntil || trig[f0]) { dropped++; claim(run.reg, f0, f1); continue; }
    let pcm = Uint8Array.from(run.vals, (x) => x & 15);
    let rate = run.hz;
    if (rate > MAX_DRUM_HZ) { rate = MAX_DRUM_HZ; }
    if (pcm.length > MAX_DRUM_BYTES) { pcm = pcm.slice(0, MAX_DRUM_BYTES); longDrum++; }
    let idx = drums.findIndex((d) => d.pcm.length === pcm.length && Math.abs(d.rateHz / rate - 1) < 0.03 && d.pcm.every((x, k) => x === pcm[k]));
    if (idx < 0) {
      if (drums.length >= MAX_DRUMS) { tooManyDrums++; claim(run.reg, f0, f1); continue; }
      drums.push({ name: `Drum ${drums.length + 1}`, rateHz: rate, pcm });
      idx = drums.length - 1;
    }
    trig[f0] = trigCode(run.reg - 8, idx);
    busyUntil = run.t1;
    claim(run.reg, f0, f1);
    nDrumHits++;
  }

  // ---- everything else the handlers wrote: the last value per frame goes into the frame image
  let other = 0;
  for (let reg = 0; reg < 14; reg++) {
    const cl = claimed.get(reg);
    const T = times[reg], V = vals[reg];
    for (let k = 0; k < T.length; k++) {
      const f = Math.floor(T[k] / MFP_FRAME);
      if (f >= n) break;
      if (cl && cl[f]) continue;
      if (k + 1 < T.length && Math.floor(T[k + 1] / MFP_FRAME) === f) continue;      // only the last write of the frame
      regs[f * 14 + reg] = V[k];
      other++;
    }
  }

  const out: Extracted = { warnings };
  if (drums.length) {
    const track: DrumTrack = { drums, trig };
    silenceDrumVoices(regs, n, track);
    out.drums = track;
    warnings.push(`${nDrumHits} digidrum hit(s) extracted over the rendered length (${drums.length} sample(s), ${drums.map((d) => Math.round(d.rateHz)).filter((v, i, a) => a.indexOf(v) === i).join('/')} Hz)`);
  }
  if (fx.some((x) => x)) {
    out.fx = fx;
    warnings.push(`timer effects extracted: ${[nSid && `${nSid}× SID voice`, nSinus && `${nSinus}× sinus-SID`, nSync && `${nSync}× sync-buzzer`].filter(Boolean).join(', ')}`);
  }
  if (dropped) warnings.push(`${dropped} overlapping digidrum(s) dropped (one drum plays at a time)`);
  if (tooManyDrums) warnings.push(`${tooManyDrums} digidrum hit(s) left out: at most ${MAX_DRUMS} different samples`);
  if (longDrum) warnings.push(`${longDrum} digidrum(s) cut to ${MAX_DRUM_BYTES} samples`);
  if (fxConflict) warnings.push(`${fxConflict} frame(s) with a second timer effect: only one runs at a time, the first was kept`);
  if (tooFast) warnings.push(`${tooFast} timer effect(s) outside the rates the ST engine can do were clamped`);
  if (!out.drums && !out.fx && other === 0 && log.t.length) warnings.push('timer interrupts ran but their YM writes were not recognised as drums or effects');
  return out;
}

/** the voice a sync-buzzer belongs to: the one running on the hardware envelope */
function syncVoice(regs: Uint8Array, f: number): number {
  for (let v = 0; v < 3; v++) if (regs[f * 14 + 8 + v] & 16) return v;
  return 0;
}
