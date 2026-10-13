/**
 * Register dump (.sndh / .ym) -> editable pattern song.
 *
 * A dump says what the chip did every 50 Hz frame, not what the composer wrote, so the song is reconstructed:
 *
 *  1. Per voice and frame: audible?, volume, hardware-envelope flag, tone / noise on, tone period, noise period.
 *     While a digidrum owns voice C the voice keeps its previous state (the sample plays over it in the editor too).
 *  2. Note onsets (a voice starts sounding, the volume jumps up, the buzzer is restarted, the pitch steps to a new stable
 *     value) are collected from all voices and digidrum hits. The frames-per-row (the tune's speed) and the phase are the
 *     largest grid that nearly all onsets sit on; without a clear grid the song runs at one frame per row.
 *  3. A note lasts from its onset row to the next onset row of that voice. What the voice did in those frames becomes a
 *     step-table instrument (volume, pitch relative to the note, noise, tone, buzzer). Identical or prefix-identical sounds
 *     share an instrument; the tail of a held sound is turned into a loop.
 *  4. Digidrum triggers go to a drum channel (note = drum number), timer effects (SID / sinus-SID / sync-buzzer) to the
 *     Q / S / U effect column.
 *
 * Because every note records what the chip did, re-rendering the song reproduces the dump closely: the result is
 * "what was played", written as notes and instruments the way an editor wants them. It is not a recovery of the
 * original composer's source (arpeggio columns, slide effects, instrument names).
 */
import {
  type Song, type Instrument, type Cell, type Pattern, type StepSeq,
  NOTE_OFF, defaultInstrument, emptyCell, emptyPattern, newSong, parseEffectChar,
} from './types';
import type { MacroStep } from '../core/convert';
import type { AyTune } from '../import/tune';
import { drumFrames, trigVoice, trigDrum, TRIG_STOP } from '../core/drums';
import { fxKindOf, fxVoiceOf, fxHzOf, fxParamForHz, FX_LETTERS } from '../core/fx';
import { freqToYmPeriod } from './render';
import { noteToFreq } from './types';

export interface RegsConvertOptions {
  /** frames per row; 0 / undefined = detect */
  speed?: number;
  /** how far (as a fraction of the period) a step's pitch may be snapped to a clean semitone fraction; 0 = exact */
  pitchTol?: number;
  /** rows per pattern */
  patternRows?: number;
}

export interface RegsConvertResult {
  song: Song;
  report: string[];
  warnings: string[];
  /** frames per row that was used */
  speed: number;
  /** frames before the first full row (they form a short first row), 0 = none */
  lead: number;
  /** frame numbers of the detected note starts per voice (for tests and diagnostics) */
  onsets: number[][];
}

const MAX_STEPS = 2000;
const MAX_INSTRUMENTS = 255;
const SILENT: MacroStep = { vol: 0, semi: 0, noise: 0, tone: false };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const hex2 = (n: number) => (n & 255).toString(16).toUpperCase().padStart(2, '0');

/** note number (float) of a tone period; the editor's note n sounds noteToFreq(n) */
const noteOfPeriod = (per: number) => 12 * Math.log2(2_000_000 / (16 * per) / 440) + 58;
const noteOfFreq = (f: number) => 12 * Math.log2(f / 440) + 58;

interface VoiceFrames {
  aud: Uint8Array;
  vol: Uint8Array;           // 0..15
  env: Uint8Array;           // hardware envelope on
  tone: Uint8Array;
  noise: Uint8Array;         // noise period 1..31, 0 = off
  per: Uint16Array;
  sync: Uint8Array;          // bit 5 of the volume register (sync-square restart)
  pit: Float32Array;         // note number (float) while tone is on and audible, NaN otherwise
}

interface Seg {
  v: number;
  row: number;
  f0: number;
  f1: number;
  note: number;
  /** what the voice did in every frame of the segment (level-normalised when volCell is set) */
  raw: MacroStep[];
  /** the instrument's table for it, and how many frames of `raw` it has to reproduce (the rest is cut by a note-off or a new note) */
  steps: MacroStep[];
  loopFrom: number;
  cmpLen: number;
  /** row of the note-off that ends a looping sound, -1 = none */
  offRow: number;
  /** volume column value (0x10 + level) that scales the normalised steps back, 0 = full level */
  volCell: number;
  sig: string;
  envShape: number;
  envPeriod: number;
  envAuto: boolean;
  envDiv: number;
  sync: boolean;
  inst: number;
}

interface Built {
  sig: string;
  steps: MacroStep[];
  loopFrom: number;
  inst: Instrument;
}

function expand(b: { steps: MacroStep[]; loopFrom: number }, k: number): MacroStep {
  const n = b.steps.length;
  if (k < n) return b.steps[k];
  if (b.loopFrom < 0 || b.loopFrom >= n) return SILENT;
  return b.steps[b.loopFrom + ((k - b.loopFrom) % (n - b.loopFrom))];
}
const stepEq = (a: MacroStep, b: MacroStep, tv: number, ts: number) =>
  Math.abs(a.vol - b.vol) <= tv && a.noise === b.noise && a.tone === b.tone && !!a.plain === !!b.plain && Math.abs(a.semi - b.semi) <= ts + 1e-9;

/** a periodic tail (a held note, a vibrato) becomes a loop: [prefix | loop body] */
function loopTail(steps: MacroStep[]): { steps: MacroStep[]; loopFrom: number } {
  const len = steps.length;
  let best = { len, loopFrom: -1 };
  for (let q = 1; q <= 32 && 2 * q <= len; q++) {
    let i = len - q;
    while (i > 0 && stepEq(steps[i - 1], steps[i - 1 + q], 0, 0)) i--;
    if (len - i >= 2 * q && i + q < best.len) best = { len: i + q, loopFrom: i };
  }
  return best.loopFrom >= 0 ? { steps: steps.slice(0, best.len), loopFrom: best.loopFrom } : { steps, loopFrom: -1 };
}

/** how different two steps sound: level steps, with a semitone counting twice, plus a penalty for another waveform */
function stepCost(a: MacroStep, b: MacroStep): number {
  if (a.vol === 0 && b.vol === 0) return 0;
  let d = Math.abs(a.vol - b.vol);
  if (a.vol > 0 && b.vol > 0) {
    d += Math.min(4, 2 * Math.abs(a.semi - b.semi));
    if (a.tone !== b.tone) d += 4;
    if (a.noise !== b.noise) d += a.noise && b.noise ? 1 : 3;
    if (!!a.plain !== !!b.plain) d += 3;
  }
  return d;
}

/**
 * More sounds than instrument slots: repeatedly fold the instrument whose notes would change least into another one
 * (a different buzzer setting or a tone instead of a buzzer is the last resort).
 */
function mergeInstruments(built: Built[], segs: Seg[], target: number): { built: Built[]; cost: number } {
  const N = built.length;
  const groups: number[][] = built.map(() => []);
  segs.forEach((s, i) => groups[s.inst].push(i));
  const cost = new Float64Array(N * N);
  for (let a = 0; a < N; a++) {
    for (let b = 0; b < N; b++) {
      if (a === b) { cost[a * N + b] = Infinity; continue; }
      let c = built[a].sig === built[b].sig ? 0 : 1000 * groups[a].length;       // another buzzer setting: only as a last resort
      if (built[a].sig !== built[b].sig && groups[a].length === 0) c = 0;
      for (const si of groups[a]) {
        const sg = segs[si];
        for (let k = 0; k < sg.cmpLen; k++) c += stepCost(expand(built[b], k), sg.raw[k]);
      }
      cost[a * N + b] = c;
    }
  }
  const alive = new Uint8Array(N).fill(1);
  let count = N, total = 0;
  const bestJ = new Int32Array(N).fill(-1), bestC = new Float64Array(N).fill(Infinity);
  const rescan = (a: number) => {
    let bj = -1, bc = Infinity;
    for (let b = 0; b < N; b++) { const c = cost[a * N + b]; if (alive[b] && c < bc) { bc = c; bj = b; } }
    bestJ[a] = bj; bestC[a] = bc;
  };
  for (let a = 0; a < N; a++) rescan(a);
  while (count > target) {
    let ba = -1, bc = Infinity;
    for (let a = 0; a < N; a++) if (alive[a] && bestC[a] < bc) { bc = bestC[a]; ba = a; }
    if (ba < 0) break;                                              // nothing left that may be merged
    const bb = bestJ[ba];
    total += bc;
    for (const si of groups[ba]) segs[si].inst = bb;
    groups[bb].push(...groups[ba]); groups[ba] = [];
    alive[ba] = 0; count--; bestC[ba] = Infinity;
    for (let x = 0; x < N; x++) if (alive[x] && x !== bb) cost[bb * N + x] += cost[ba * N + x];   // bb now carries ba's notes too
    rescan(bb);
    for (let x = 0; x < N; x++) if (alive[x] && x !== bb && bestJ[x] === ba) rescan(x);
  }
  const remap = new Map<number, number>();
  const out: Built[] = [];
  for (let i = 0; i < N; i++) if (alive[i]) { remap.set(i, out.length); out.push(built[i]); }
  for (const sg of segs) sg.inst = remap.get(sg.inst)!;
  return { built: out, cost: total };
}

export function regsToSong(tune: AyTune, options: RegsConvertOptions = {}): RegsConvertResult {
  const report: string[] = [];
  const warnings: string[] = [];
  const pitchTol = options.pitchTol ?? 0.004;
  const patRows = clamp(Math.trunc(options.patternRows ?? 64), 8, 256);
  let n = tune.nframes;
  if (n > 60000) { warnings.push(`the tune is ${n} frames long; only the first 60000 (20 minutes) are imported`); n = 60000; }
  const regs = tune.regs;
  const R = (f: number, r: number) => regs[f * 14 + r];

  // ---------------------------------------------------------------- 1. per-frame voice state
  const owner: Uint8Array[] = [0, 1, 2].map(() => new Uint8Array(n));      // a digidrum owns this voice in this frame
  const drumHitFrames: number[] = [];
  const drums = tune.drums;
  if (drums) {
    let live: { voice: number; end: number } | null = null;
    for (let f = 0; f < n; f++) {
      const t = drums.trig[f] ?? 0;
      if (t) {
        const idx = trigDrum(t);
        if (idx === TRIG_STOP) live = null;
        else if (drums.drums[idx]) { live = { voice: trigVoice(t), end: f + drumFrames(drums.drums[idx]) }; drumHitFrames.push(f); }
      }
      if (live && f >= live.end) live = null;
      if (live && live.voice >= 0 && live.voice < 3) owner[live.voice][f] = 1;
    }
  }
  const vf: VoiceFrames[] = [0, 1, 2].map(() => ({
    aud: new Uint8Array(n), vol: new Uint8Array(n), env: new Uint8Array(n), tone: new Uint8Array(n), noise: new Uint8Array(n),
    per: new Uint16Array(n), sync: new Uint8Array(n), pit: new Float32Array(n).fill(NaN),
  }));
  const shapeAt = new Int16Array(n);            // envelope shape in force (last write)
  const shapeWrite = new Uint8Array(n);         // R13 written this frame
  const envPer = new Uint16Array(n);
  let shape = 0;
  for (let f = 0; f < n; f++) {
    if (R(f, 13) !== 0xff) { shape = R(f, 13) & 15; shapeWrite[f] = 1; }
    shapeAt[f] = shape;
    envPer[f] = R(f, 11) | (R(f, 12) << 8);
    const mixer = R(f, 7);
    for (let v = 0; v < 3; v++) {
      const o = vf[v];
      if (owner[v][f] && v === 2 && f > 0) {            // the sample owns voice C: keep what it did before
        for (const k of ['aud', 'vol', 'env', 'tone', 'noise', 'per', 'sync', 'pit'] as const) (o[k] as Uint8Array)[f] = (o[k] as Uint8Array)[f - 1];
        continue;
      }
      const rv = R(f, 8 + v);
      const env = (rv & 16) !== 0, vol = rv & 15;
      const tone = !(mixer & (1 << v)), noiseOn = !(mixer & (8 << v));
      o.env[f] = env ? 1 : 0; o.vol[f] = vol; o.tone[f] = tone ? 1 : 0;
      o.noise[f] = noiseOn ? Math.max(1, R(f, 6) & 31) : 0;
      o.per[f] = R(f, 2 * v) | ((R(f, 2 * v + 1) & 15) << 8);
      o.sync[f] = (rv & 32) !== 0 ? 1 : 0;
      const aud = env ? true : vol > 0 && (tone || noiseOn);
      o.aud[f] = aud ? 1 : 0;
      o.pit[f] = aud && tone && o.per[f] > 0 ? noteOfPeriod(o.per[f]) : NaN;
    }
  }
  // last known pitch before a frame (for comparing across silence)
  const lastPitch = (o: VoiceFrames, f: number) => { for (let k = f; k >= 0; k--) if (!Number.isNaN(o.pit[k])) return o.pit[k]; return NaN; };
  const pitChanged = (a: number, b: number) => (Number.isNaN(a) || Number.isNaN(b) ? Number.isNaN(a) !== Number.isNaN(b) : Math.abs(a - b) >= 0.6);
  /** the pitch steps to a new value at f after the old one had lasted two frames (a one-frame blip is an arpeggio, not a note) */
  const pitchStep = (o: VoiceFrames, f: number) =>
    f >= 2 && !Number.isNaN(o.pit[f]) && !Number.isNaN(o.pit[f - 1]) && !Number.isNaN(o.pit[f - 2])
    && Math.abs(o.pit[f] - o.pit[f - 1]) >= 0.6 && Math.abs(o.pit[f - 1] - o.pit[f - 2]) < 0.5;
  const stableFor = (o: VoiceFrames, f: number, len: number) => {
    const p0 = o.pit[f];
    if (Number.isNaN(p0)) return false;
    for (let k = 1; k < len && f + k < n; k++) if (Number.isNaN(o.pit[f + k]) || Math.abs(o.pit[f + k] - p0) >= 0.5) return false;
    return true;
  };

  // ---------------------------------------------------------------- 2. onsets -> speed and phase
  const cand: number[][] = [[], [], []];
  for (let v = 0; v < 3; v++) {
    const o = vf[v];
    let lastShape = -1;
    for (let f = 0; f < n; f++) {
      let on = false;
      if (o.aud[f]) {
        if (f === 0 || !o.aud[f - 1]) {
          let k = f - 1, gap = 0;
          while (k >= 0 && !o.aud[k]) { gap++; k--; }
          if (k < 0 || gap >= 2) on = true;
          else if (pitChanged(lastPitch(o, k), o.pit[f]) || o.vol[f] >= o.vol[k] + 4) on = true;
        } else {
          if (o.env[f] && !o.env[f - 1]) on = true;
          else if (!o.env[f] && o.vol[f] >= o.vol[f - 1] + 4) on = true;
          else if (o.env[f] && shapeWrite[f] && (!shapeWrite[f - 1] || shapeAt[f] !== lastShape)) on = true;
          else if (pitchStep(o, f) && stableFor(o, f, 3)) on = true;
        }
        if (o.sync[f] && (f === 0 || !o.sync[f - 1])) on = true;
        if (o.env[f] && shapeWrite[f]) lastShape = shapeAt[f];
      }
      if (on) cand[v].push(f);
    }
  }
  // a dump that is not music (samples played through the volume registers, noise) has a note start every few frames: stop at a size the editor can handle
  const MAX_NOTES = 12000;
  const starts = [...cand[0], ...cand[1], ...cand[2]].sort((a, b) => a - b);
  if (starts.length > MAX_NOTES) {
    n = starts[MAX_NOTES];
    for (let v = 0; v < 3; v++) cand[v] = cand[v].filter((f) => f < n);
    warnings.push(`the tune has more than ${MAX_NOTES} note starts: only the first ${(n / 50).toFixed(0)} seconds are imported`);
  }
  const allOn = [...cand[0], ...cand[1], ...cand[2], ...drumHitFrames.filter((f) => f < n)];
  let speed = 1, phase = 0;
  if (options.speed && options.speed > 0) speed = Math.trunc(options.speed);
  /** a note start within `tol` frames of a row boundary counts as sitting on it (attacks often begin a frame or two late) */
  const alignTol = (S: number) => (S >= 6 ? 2 : S >= 4 ? 1 : 0);
  const countAt = (S: number, p: number) => {
    const tol = alignTol(S);
    let c = 0;
    for (const f of allOn) { const d = (((f - p) % S) + S) % S; if (Math.min(d, S - d) <= tol) c++; }
    return c;
  };
  const bestPhase = (S: number) => {
    let bp = 0, bc = countAt(S, 0);
    for (let p = 1; p < S; p++) { const c = countAt(S, p); if (c > bc * 1.03) { bc = c; bp = p; } }
    return { p: bp, c: bc };
  };
  if (!options.speed && allOn.length >= 6) {
    search:
    for (const need of [0.97, 0.92, 0.85]) {
      for (let S = 16; S >= 2; S--) {
        const { p, c } = bestPhase(S);
        if (c >= 4 && c / allOn.length >= need) { speed = S; phase = p; break search; }
      }
    }
  } else if (options.speed && allOn.length) {
    phase = bestPhase(Math.max(1, speed)).p;
  }
  // frames before the first grid frame form a short first row (speed = phase for that row only)
  const lead = phase > 0 && phase < n;
  if (!lead) phase = 0;
  const rowOf = (f: number) => (lead ? (f < phase ? 0 : 1 + Math.round((f - phase) / speed)) : Math.round(f / speed));
  const frameOf = (r: number) => (lead ? (r === 0 ? 0 : phase + (r - 1) * speed) : r * speed);
  const rowLen = (r: number) => (lead && r === 0 ? phase : speed);
  const nRows = Math.max(1, lead ? 1 + Math.ceil((n - phase) / speed) : Math.ceil(n / speed));
  const alignedPct = allOn.length ? Math.round((100 * (speed > 1 ? countAt(speed, phase) : allOn.length)) / allOn.length) : 100;

  // onset rows per voice
  const onsetRows: Set<number>[] = [new Set(), new Set(), new Set()];
  for (let v = 0; v < 3; v++) {
    const o = vf[v];
    for (const f of cand[v]) onsetRows[v].add(clamp(rowOf(f), 0, nRows - 1));
    // a pitch step exactly on a row boundary is a new note
    for (let r = 1; r < nRows; r++) {
      const g = frameOf(r);
      if (g >= n) break;
      if (onsetRows[v].has(r)) continue;
      if (o.aud[g] && o.aud[g - 1] && pitchStep(o, g) && stableFor(o, g, Math.min(speed, 3))) onsetRows[v].add(r);
    }
  }

  // ---------------------------------------------------------------- 3. segments -> step-table instruments
  const segs: Seg[] = [];
  let envSweeps = 0;
  const bounds: { v: number; row: number; f0: number; f1: number }[] = [];
  for (let v = 0; v < 3; v++) {
    const rs = [...onsetRows[v]].sort((a, b) => a - b);
    for (let i = 0; i < rs.length; i++) {
      const f0 = frameOf(rs[i]);
      const f1 = i + 1 < rs.length ? frameOf(rs[i + 1]) : n;
      if (f0 < n && f1 > f0) bounds.push({ v, row: rs[i], f0, f1 });
    }
  }
  // global tuning: tunes made from samples are rarely exactly A = 440 Hz equal temperament; the median offset (in semitones)
  // is carried by every step, so all notes of the tune share one fine pitch and with it their instruments
  const resid: number[] = [];
  for (const b of bounds) {
    for (let f = b.f0; f < b.f1; f++) if (!Number.isNaN(vf[b.v].pit[f])) { resid.push(vf[b.v].pit[f] - Math.round(vf[b.v].pit[f])); break; }
  }
  resid.sort((a, b) => a - b);
  let tuning = resid.length ? Math.round(resid[resid.length >> 1] * 20) / 20 : 0;
  if (Math.abs(tuning) < 0.05) tuning = 0;
  for (const { v, row, f0, f1 } of bounds) {
    {
      const o = vf[v];
      // note: the first audible tone frame; a buzzer without tone takes its pitch from the envelope period
      let noteF = NaN, firstEnv = -1;
      for (let f = f0; f < f1; f++) {
        if (Number.isNaN(noteF) && !Number.isNaN(o.pit[f])) noteF = o.pit[f];
        if (firstEnv < 0 && o.env[f] && o.aud[f]) firstEnv = f;
      }
      let envShape = 0, envPeriod = 0, envAuto = false, envDiv = 1;
      let note: number;
      if (!Number.isNaN(noteF)) note = clamp(Math.round(noteF - tuning), 1, 96);
      else if (firstEnv >= 0 && envPer[firstEnv] > 0) note = clamp(Math.round(noteOfFreq(2_000_000 / (256 * envPer[firstEnv]))), 1, 96);
      else note = 49;
      const notePer = freqToYmPeriod(noteToFreq(note));
      if (firstEnv >= 0) {
        envShape = shapeAt[firstEnv]; envPeriod = Math.max(1, envPer[firstEnv]);
        const base = Math.round(2_000_000 / (256 * noteToFreq(note)));            // what the instrument computes at div = 1
        const d = envPeriod / base;
        const di = Math.round(d);
        if (di >= 1 && di <= 64 && Math.abs(d - di) <= 0.015 * di) { envAuto = true; envDiv = di; }
        for (let f = firstEnv; f < f1; f++) if (o.env[f] && o.aud[f] && Math.abs(envPer[f] - envPeriod) > Math.max(2, 0.015 * envPeriod)) { envSweeps++; break; }
      }
      const raw: MacroStep[] = [];
      for (let f = f0; f < f1; f++) {
        if (!o.aud[f]) { raw.push(SILENT); continue; }
        const isEnv = !!o.env[f];
        let semi = 0;
        if (o.tone[f] && o.per[f] > 0) {
          const target = o.per[f];
          const exact = 12 * Math.log2(notePer / target);
          const render = (s: number) => clamp(Math.round(notePer / Math.pow(2, s / 12)), 1, 4095);
          semi = NaN;
          for (const g of [1, 0.5, 0.25, 0.1, 0.01]) {
            const s = Math.round((tuning + Math.round((exact - tuning) / g) * g) * 100) / 100;
            if (Math.abs(render(s) - target) <= Math.max(0, pitchTol * target)) { semi = s; break; }
          }
          if (Number.isNaN(semi)) semi = Math.round(exact * 1e4) / 1e4;                    // an exact period was asked for (pitchTol 0)
          if (Object.is(semi, -0)) semi = 0;
        }
        const st: MacroStep = { vol: isEnv ? 15 : o.vol[f], semi, noise: o.noise[f], tone: !!o.tone[f] };
        if (firstEnv >= 0 && !isEnv) st.plain = true;
        raw.push(st);
      }
      // level: the instrument holds the shape (peak = 15), the volume column the level
      let volCell = 0;
      if (firstEnv < 0) {
        let peak = 0;
        for (const x of raw) if (x.vol > peak) peak = x.vol;
        if (peak > 0 && peak < 15) {
          const need = peak - 15;
          let bv = 64, be = Infinity;
          for (let q = 1; q <= 64; q++) { const e = Math.abs(2 * Math.log2(q / 64) - need); if (e < be) { be = e; bv = q; } }
          if (be < 0.4) {
            volCell = 0x10 + bv;
            for (let i = 0; i < raw.length; i++) if (raw[i].vol > 0) raw[i] = { ...raw[i], vol: raw[i].vol + 15 - peak };
          }
        }
      }
      // tail: a sound that is cut at a row boundary keeps its sustain as a loop and gets a note-off; otherwise the
      // table is written out until it falls silent
      let z = 0;
      while (z < raw.length && raw[raw.length - 1 - z].vol === 0) z++;
      const k = raw.length - z;
      if (k === 0) continue;
      let steps: MacroStep[], loopFrom = -1, cmpLen = raw.length, offRow = -1;
      const offRowAt = rowOf(f0 + k);
      const offAligned = z > 0 && offRowAt < nRows && frameOf(offRowAt) === f0 + k;
      const looped = loopTail(raw.slice(0, k));
      if (offAligned && looped.loopFrom >= 0) { steps = looped.steps; loopFrom = looped.loopFrom; cmpLen = k; offRow = offRowAt; }
      else if (z > 0) steps = raw.slice(0, Math.min(k, MAX_STEPS));
      else { steps = looped.steps; loopFrom = looped.loopFrom; if (steps.length > MAX_STEPS) steps = steps.slice(0, MAX_STEPS), loopFrom = -1; }
      const sync = o.sync[f0] === 1 || o.sync[Math.min(f1 - 1, f0 + 1)] === 1 || o.sync[Math.min(f1 - 1, f0 + 2)] === 1;
      const sig = [firstEnv >= 0 ? `E${envShape}:${envAuto ? 'a' + envDiv : 'p' + envPeriod}` : 'N', sync ? 'S' : ''].join('');
      segs.push({ v, row, f0, f1, note, raw, steps, loopFrom, cmpLen, offRow, volCell, sig, envShape, envPeriod, envAuto, envDiv, sync, inst: -1 });
    }
  }

  const buildInstruments = (tv: number, ts: number) => {
    const built: Built[] = [];
    const order = [...segs.keys()].sort((x, y) => segs[y].cmpLen - segs[x].cmpLen || x - y);
    for (const si of order) {
      const s = segs[si];
      let found = -1;
      for (let bi = 0; bi < built.length && found < 0; bi++) {
        const b = built[bi];
        if (b.sig !== s.sig) continue;
        let ok = true;
        for (let k = 0; k < s.cmpLen; k++) if (!stepEq(expand(b, k), s.raw[k], tv, ts)) { ok = false; break; }
        if (ok) found = bi;
      }
      if (found < 0) {
        const inst = defaultInstrument('');
        const seq: StepSeq = { steps: s.steps.map((x) => ({ ...x })), loopFrom: s.loopFrom, velocity: !s.sig.startsWith('E'), release: 0 };
        inst.seq = seq;
        if (s.sig.startsWith('E')) {
          inst.useHardEnv = true; inst.hardEnvShape = s.envShape;
          inst.hardEnvAutoPeriod = s.envAuto; inst.hardEnvDivisor = s.envAuto ? s.envDiv : 1;
          inst.hardEnvPeriod = s.envAuto ? 0 : s.envPeriod;
        }
        if (s.sync) inst.syncSquare = true;
        built.push({ sig: s.sig, steps: seq.steps, loopFrom: seq.loopFrom, inst });
        found = built.length - 1;
      }
      s.inst = found;
    }
    return built;
  };
  let built = buildInstruments(0, 0);
  if (built.length > 1500) built = buildInstruments(1, 0.5);       // keep the pairwise merge below affordable
  if (built.length > 1500) built = buildInstruments(2, 1);
  let merged = 0, mergeCost = 0;
  if (built.length > MAX_INSTRUMENTS) {
    const before = built.length;
    const r = mergeInstruments(built, segs, MAX_INSTRUMENTS);
    built = r.built; merged = before - built.length; mergeCost = r.cost;
    warnings.push(`${before} distinct sounds do not fit in ${MAX_INSTRUMENTS} instruments: ${merged} were merged into the most similar ones (about ${(mergeCost / Math.max(1, segs.length)).toFixed(1)} level steps of difference per note)`);
  }

  // number instruments in order of first use, name by character
  const rank = new Map<number, number>();
  const useOrder = [...segs].sort((a, b) => a.row - b.row || a.v - b.v);
  for (const s of useOrder) if (!rank.has(s.inst)) rank.set(s.inst, rank.size + 1);
  const instruments: Instrument[] = [defaultInstrument('--')];
  const nameCount: Record<string, number> = {};
  for (const [bi] of [...rank.entries()].sort((a, b) => a[1] - b[1])) {
    if (instruments.length > MAX_INSTRUMENTS) break;
    const b = built[bi];
    const audible = b.steps.filter((x) => x.vol > 0);
    const hasTone = audible.some((x) => x.tone), hasNoise = audible.some((x) => x.noise > 0);
    const label = b.inst.useHardEnv ? 'Buzzer' : hasNoise && !hasTone ? 'Noise' : hasNoise ? 'Tone+noise' : 'Tone';
    nameCount[label] = (nameCount[label] ?? 0) + 1;
    b.inst.name = `${label} ${hex2(instruments.length)}`;
    instruments.push(b.inst);
  }
  const instNo = (bi: number) => Math.min(instruments.length - 1, rank.get(bi) ?? 1);

  // ---------------------------------------------------------------- cells
  const hasDigi = !!drums && drumHitFrames.length > 0;
  const nCh = hasDigi ? 4 : 3;
  const flat: Cell[][] = Array.from({ length: nRows }, () => Array.from({ length: nCh }, emptyCell));
  for (const s of segs) {
    const c = flat[s.row][s.v];
    c.note = s.note; c.instrument = instNo(s.inst); c.volume = s.volCell;
    if (s.offRow > s.row && s.offRow < nRows && !flat[s.offRow][s.v].note) flat[s.offRow][s.v].note = NOTE_OFF;
  }

  // digidrums: one drum channel, note = drum number
  let drumLost = 0, drumMoved = 0;
  if (hasDigi && drums) {
    const bank = defaultInstrument('Digidrums');
    bank.digiDrums = drums.drums.slice(0, 63);
    let bankInst = 0;
    if (instruments.length > MAX_INSTRUMENTS) warnings.push('no free instrument slot for the digidrum bank');
    else { bankInst = instruments.length; instruments.push(bank); }
    if (bankInst) {
      const written = new Set<number>();
      for (let f = 0; f < n; f++) {
        const t = drums.trig[f] ?? 0;
        if (!t) continue;
        const idx = trigDrum(t);
        const r = clamp(rowOf(f), 0, nRows - 1);
        const c = flat[r][3];
        if (idx === TRIG_STOP) { if (!c.note) { c.note = NOTE_OFF; } continue; }
        if (idx >= bank.digiDrums!.length) continue;
        if (written.has(r)) { drumLost++; continue; }
        written.add(r);
        if (trigVoice(t) !== 2) drumMoved++;
        c.note = idx + 1; c.instrument = bankInst;
      }
    }
  }

  // timer effects: Q / S / U on the voice's cell, restated after every new note on that voice
  let fxCells = 0;
  if (tune.fx) {
    const cur: ({ kind: number; param: number } | null)[] = [null, null, null];
    for (let r = 0; r < nRows; r++) {
      const g = frameOf(r);
      if (g >= n) break;
      for (let v = 0; v < 3; v++) {
        // the first frame of the row in which a timer effect runs on this voice decides (an effect that has to wait for the
        // ST's one free timer may only begin part-way through the row)
        let st = 0;
        for (let f = g; f < Math.min(n, g + rowLen(r)); f++) { const x = tune.fx[f] ?? 0; if (x && fxVoiceOf(x) === v) { st = x; break; } }
        const kind = st ? fxKindOf(st) : 0;
        const param = kind ? fxParamForHz(fxHzOf(st)) : 0;
        const c = flat[r][v];
        const want = kind && param ? { kind, param } : null;
        const newNote = c.note > 0 && c.note !== NOTE_OFF;
        if (want) {
          if (!cur[v] || cur[v]!.kind !== want.kind || cur[v]!.param !== want.param || newNote) {
            c.effect = parseEffectChar(FX_LETTERS[want.kind]); c.param = want.param; fxCells++;
          }
          cur[v] = want;
        } else {
          if (cur[v] && !newNote) { c.effect = parseEffectChar('Q'); c.param = 0; }
          cur[v] = null;
        }
      }
    }
  }

  // the short first row: Fxx sets its speed, the next row sets the normal speed again
  if (lead) {
    const put = (row: number, sp: number) => {
      const c = flat[row].slice(0, 3).find((x) => !x.effect);
      if (c) { c.effect = parseEffectChar('F'); c.param = sp; return true; }
      return false;
    };
    if (!put(0, phase) || (nRows > 1 && !put(1, speed))) warnings.push('no free effect slot for the short first row: the first notes may be late');
  }

  // ---------------------------------------------------------------- patterns, order, loop
  let loopRow = 0;
  if (tune.loopFrame > 0) loopRow = clamp(rowOf(Math.min(tune.loopFrame, n - 1)), 0, nRows - 1);
  const pats: Pattern[] = [];
  const order: number[] = [];
  const seen = new Map<string, number>();
  let restartPos = 0, visits = 0;
  const addChunks = (from: number, to: number) => {
    for (let a = from; a < to; a += patRows) {
      const b = Math.min(to, a + patRows);
      const cells = flat.slice(a, b);
      const pat: Pattern = { rows: cells.length, cells };
      const sig = JSON.stringify(cells);
      let pi = seen.get(sig);
      if (pi === undefined) { pi = pats.length; pats.push(pat); seen.set(sig, pi); }
      if (a === loopRow) restartPos = order.length;
      order.push(pi); visits++;
    }
  };
  addChunks(0, loopRow);
  addChunks(loopRow, nRows);
  if (pats.length > 255) warnings.push(`${pats.length} patterns: more than the 255 a .ymt file can order`);

  const song = newSong(nCh);
  song.name = (tune.title || 'Imported tune').slice(0, 32);
  song.author = tune.author || '';
  song.bpm = 125;
  song.speed = speed;
  song.instruments = instruments;
  song.patterns = pats.length ? pats : [emptyPattern(16, nCh)];
  song.order = order.length ? order : [0];
  song.restartPos = restartPos;
  song.channelNames = ['A', 'B', 'C'];
  if (hasDigi) { song.channelNames.push('Drum'); song.drumChannel = 3; }

  const notes = segs.length;
  report.push(`${tune.source.toUpperCase()} import: ${n} frames -> ${nRows} rows at ${speed} frame${speed === 1 ? '' : 's'} per row${speed > 1 ? ` (${lead ? `first row ${phase} frame${phase === 1 ? '' : 's'}, ` : ''}${alignedPct}% of the note starts fall on a row)` : speed === 1 && !options.speed && allOn.length >= 6 ? ' (no regular tempo found)' : ''}`);
  report.push(`${notes} notes -> ${instruments.length - 1 - (hasDigi && drums && instruments[instruments.length - 1].digiDrums?.length ? 1 : 0)} step-table instruments, ${visits} pattern visits -> ${pats.length} patterns`);
  if (hasDigi && drums) report.push(`digidrums: ${drums.drums.length} sample(s), ${drumHitFrames.length} hit(s) on the drum channel${drumLost ? `, ${drumLost} lost (two hits in one row)` : ''}`);
  if (fxCells) report.push(`timer effects: ${fxCells} Q / S / U cell(s)`);
  if (drumMoved) warnings.push(`${drumMoved} digidrum hit(s) played on voice A or B are on the drum channel, which uses voice C`);
  if (envSweeps) warnings.push(`${envSweeps} buzzer note(s) sweep the envelope period while they sound; the instrument keeps the first period`);
  if (tune.fx && !fxCells) warnings.push('the timer effects could not be placed on a note');
  void NOTE_OFF;
  return { song, report, warnings, speed, lead: lead ? phase : 0, onsets: cand };
}
