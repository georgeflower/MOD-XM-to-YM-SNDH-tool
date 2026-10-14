/**
 * MOD / XM -> editable AY pattern song.
 *
 * Where `core/convert` decides every 20 ms what the three voices do, this builds what a person would
 * have written: patterns with notes, instruments, volume and effect columns.
 *
 *  - the module is replayed to find what is *sounding* in every pattern row (pattern jumps, loops and
 *    tempo changes unrolled; identical patterns are merged again afterwards)
 *  - per row the 3 most important source notes get the 3 voices; a note keeps its voice until it ends
 *  - notes that would be dropped can be folded into an arpeggio (0xy) on the voice with the closest pitch
 *  - every sample becomes a step-table instrument (volume contour measured from the sample, pitch offset
 *    from the measured cycle length; drums become noise / falling-tone instruments)
 *  - row length = source row length in 50 Hz frames (Fxx speed changes where it varies), so the timing
 *    is exact and the song runs at 125 BPM = one tick per frame
 */
import type { Module, Sample } from '../core/types';
import { replay, FPS, channelSkipper, type ChanState, type RowLog } from '../core/replay';
import { analyseSample, fold, ended, type SampleInfo } from '../core/samples';
import { DigiExtractor } from '../core/digi';
import { drumFrames } from '../core/drums';
import { analyseWave, waveOfClass, BUZZ_SHAPE, buzzable, type WaveChoice } from '../core/waveform';
import { classifyDrum, drumMacro, pyRound, TONE_HZ, type DrumKind, type InstMap, type MacroStep } from '../core/convert';
import { amigaPeriodOf, xmAmigaPeriodOf, PT_NOTE_BASE } from '../core/pitch';
import {
  type Song, type Cell, type Instrument, type Pattern,
  newSong, defaultInstrument, emptyCell, emptyPattern, noteToFreq, NOTE_OFF, parseEffectChar, FX,
} from './types';
import { freqToYmPeriod } from './render';

export interface SongConvertOptions {
  prio?: Record<number, number>;
  /** play only this 0-based source channel */
  solo?: number | null;
  inst?: Record<number, InstMap>;
  drumBonus?: number;
  sticky?: number;
  gainDb?: number;
  refPercentile?: number;
  arpOrder?: 'xy' | 'yx';
  /** notes per voice an arpeggio may hold (0/1 = no folding) */
  arpFill?: number;
  arpMinVol?: number;
  /** merge identical patterns (default true) */
  dedupe?: boolean;
  /** custom names for source instruments (1-based instrument number -> name), used for the AY instruments made from them */
  names?: Record<number, string>;
  /** percussion-like instruments become digidrum samples on a fourth (drum) channel; default on: the drum channel appears when the module has percussion (false = synthetic drum macros) */
  digiDrums?: boolean;
  digiRate?: number;
  digiMaxMs?: number;
  /** bass and synthetic drums on the middle voice, melody on A and C (digidrums stay on C) */
  middleLayout?: boolean;
  /** notes below this frequency count as bass for the middle layout, Hz (default 200) */
  bassHz?: number;
  /** sawtooth / triangle / sine-like sustained samples become hardware-envelope buzzer instruments where the pitch allows (see core/waveform) */
  waveform?: boolean;
}

export interface SongConvertResult {
  song: Song;
  report: string[];
  warnings: string[];
  /** per source channel: rows that got a voice / were folded into an arpeggio / lost their note */
  played: number[]; folded: number[]; dropped: number[];
  /** AY instrument -> source instrument description (for the UI) */
  instMap: { ay: number; src: number; ksmp: number; kind: string }[];
}

interface ChInfo {
  active: boolean;
  lvl: number;                   // AY level 0..15 at the loudest frame of the row
  noise: boolean;                // needs the noise generator
  drum?: DrumKind;
  st0: ChanState | null;         // snapshot at the first frame of the row
  stLast: ChanState | null;
  trig: { off: number; st: ChanState } | null;
}

interface Plan {
  ay: number;                    // AY instrument slot
  kind: 'tone' | 'kick' | 'snare' | 'hat' | 'macro';
  kOct: number;                  // semitones added to the written note (whole octaves for tonal samples)
  fixedNote?: number;            // drums: the note that selects the pitch / is irrelevant for noise
  sustained: boolean;            // loops until key-off
  buzz?: boolean;                // hardware-envelope instrument: the note keeps its low octave
}

interface Voice {
  owner: number | null;
  note: number;                  // note the voice was last triggered with (origNote of the AY channel)
  ownerNote: number;             // pitch (AY note) of the owner right now
  plan: Plan | null;
  vol: number;                   // AY channel volume 0..64 as the YM Tracker would hold it
  arp: boolean;
  vibOn: boolean;
}

const log2 = Math.log2;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function percentile(values: number[], p: number): number {
  const a = Float64Array.from(values).sort();
  if (!a.length) return 1;
  const pos = ((a.length - 1) * p) / 100;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/** XM effect code -> letter used by the YM Tracker list, or '' */
function effLetter(code: number): string {
  if (code <= 0x0f) return code.toString(16).toUpperCase();
  if (code <= 35) return String.fromCharCode('G'.charCodeAt(0) + (code - 0x10));
  return '';
}

export function moduleToSong(m: Module, options: SongConvertOptions = {}): SongConvertResult {
  const o = { drumBonus: 3, sticky: 3, gainDb: 0, refPercentile: 97, arpFill: 0, arpMinVol: 3, dedupe: true, ...options };
  const prio = options.prio ?? {};
  const digiOn = options.digiDrums ?? true;
  const report: string[] = [];
  const warnings: string[] = [];
  const warnCount = new Map<string, number>();
  const warn = (k: string) => warnCount.set(k, (warnCount.get(k) ?? 0) + 1);
  const dt = 1 / FPS;

  report.push(`'${m.title}': ${m.kind.toUpperCase()}, ${m.nch} channels -> 3 voices`);

  // ---------- sample analysis (same classification as the frame converter)
  const info = new Map<string, SampleInfo>();
  const c4Hz = new Map<number, number>();
  m.instruments.forEach((ins, i) => {
    if (!ins) return;
    ins.samples.forEach((s, k) => info.set(`${i}:${k}`, analyseSample(s)));
    const a = info.get(`${i}:0`);
    if (a && a.cls === 'tonal' && a.cycle) {
      const s = ins.samples[0];
      const rate = m.amiga ? 3546894.6 / (428 * Math.pow(2, -(s.modFine ?? 0) / 96)) : 8363 * Math.pow(2, (s.rel * 128 + s.fine) / (12 * 128));
      c4Hz.set(i, rate / a.cycle);
    }
  });

  // ---------- replay
  const rep = replay(m, { arpOrder: options.arpOrder, skip: channelSkipper(options) });
  const frames = rep.frames;
  const rows = rep.rows.filter((r) => r.len > 0);
  if (!rows.length) throw new Error('module has no playable rows');
  report.push(`${rows.length} rows played, ${frames.length} frames = ${(frames.length / FPS).toFixed(1)} s`);

  const modeOf = (inst: number): InstMap | undefined => options.inst?.[inst];
  const isMuted = (inst: number) => modeOf(inst)?.mode === 'mute';
  /** this source sample is played as a digidrum (not as tone / drum macro) */
  const isDigi = (st: ChanState): boolean => {
    const mp = modeOf(st.inst);
    const mode = mp?.mode ?? 'auto';
    if (mode === 'digi') return true;
    if (!digiOn) return false;
    const inf = info.get(`${st.inst}:${st.ksmp}`);
    if (!inf || inf.cls === 'empty') return false;
    return !(mode === 'mute' || mode === 'macro' || mode === 'tone' || mode === 'kick' || mode === 'snare' || mode === 'hat') && inf.cls !== 'tonal';
  };

  // ---------- digidrum hits: which frame starts which sample, and how long voice C belongs to it
  const digi = new DigiExtractor(m, { rateHz: options.digiRate, maxMs: options.digiMaxMs });
  const rowOfFrame = new Int32Array(frames.length).fill(-1);
  rows.forEach((r, ri) => { for (let k = 0; k < r.len; k++) if (r.frame + k < frames.length) rowOfFrame[r.frame + k] = ri; });
  const hitAt = new Map<number, { idx: number; cls: number; ch: number }>();
  if (digiOn || Object.values(options.inst ?? {}).some((x) => x.mode === 'digi')) {
    for (let f = 0; f < frames.length; f++) {
      frames[f].forEach((st, c) => {
        if (!st || st.age !== 0 || (f > 0 && frames[f - 1].includes(st)) || st.vol <= 0 || isMuted(st.inst) || !isDigi(st)) return;
        const h = digi.hit(st);
        if (!h) return;
        const p = hitAt.get(f);
        if (!p || h.cls < p.cls) hitAt.set(f, { ...h, ch: c });
      });
    }
  }
  const hitFrames = [...hitAt.keys()].sort((a, b) => a - b);
  const busyFrame = new Uint8Array(frames.length);
  hitFrames.forEach((f, k) => {
    const end = Math.min(frames.length, hitFrames[k + 1] ?? frames.length, f + drumFrames(digi.list[hitAt.get(f)!.idx]));
    for (let g = f; g < end; g++) busyFrame[g] = 1;
  });
  // a row gives up voice C when the drum covers at least half of it
  const busyRow = new Uint8Array(rows.length);
  rows.forEach((r, ri) => { let n = 0; for (let k = 0; k < r.len; k++) n += busyFrame[r.frame + k] ?? 0; busyRow[ri] = n * 2 >= r.len && n > 0 ? 1 : 0; });
  const drumCells: Cell[] = rows.map(() => emptyCell());
  let drumHitsWritten = 0, drumHitsLost = 0;

  // ---------- loudness reference (97th percentile of tonal playback levels, like the frame converter)
  const rmsOf = (st: ChanState): number | null => {
    if (ended(st.smp, st.pos)) return null;
    const n = Math.max(4, Math.trunc(st.rate * dt));
    const w = fold(st.smp, st.pos, st.pos + n);
    if (!w.length) return null;
    let sum = 0;
    for (let i = 0; i < w.length; i++) sum += w[i] * w[i];
    return Math.sqrt(sum / w.length);
  };
  const tonalLike = (st: ChanState) => {
    const inf = info.get(`${st.inst}:${st.ksmp}`);
    if (!inf || inf.cls === 'empty') return false;
    const mp = modeOf(st.inst);
    if (mp?.mode === 'mute' || mp?.mode === 'macro') return false;
    if (mp?.mode === 'kick' || mp?.mode === 'snare' || mp?.mode === 'hat' || mp?.mode === 'digi') return false;
    return mp?.mode === 'tone' || (inf.cls === 'tonal' && !isDigi(st));
  };
  const tl: number[] = [];
  for (const fr of frames) for (const st of fr) {
    if (!st || st.vol <= 0 || !tonalLike(st)) continue;
    const r = rmsOf(st);
    if (r !== null) tl.push(r * st.vol);
  }
  const ref = tl.length ? percentile(tl, o.refPercentile) : 1;
  const aylvl = (x: number) => (x <= 0 ? 0 : clamp(pyRound(15 + 2 * log2(x / ref) + o.gainDb / 3.0103), 0, 15));

  // ---------- drum classification cache + note statistics per (inst:ksmp)
  const drumCache = new Map<string, { kind: DrumKind; rms: number }>();
  const drumOf = (st: ChanState, forced?: DrumKind) => {
    const key = `${st.inst}:${st.ksmp}:${forced ?? ''}`;
    let d = drumCache.get(key);
    if (!d) { d = classifyDrum(m, st.smp, info.get(`${st.inst}:${st.ksmp}`)!, forced ?? undefined); drumCache.set(key, d); }
    return d;
  };
  const noteStats = new Map<string, number[]>();
  for (let f = 0; f < frames.length; f++) for (const st of frames[f]) {
    if (!st || st.age !== 0 || (f > 0 && frames[f - 1].includes(st))) continue;
    const key = `${st.inst}:${st.ksmp}`;
    (noteStats.get(key) ?? noteStats.set(key, []).get(key)!).push(st.note);
  }
  const refNote = (key: string) => {
    const a = (noteStats.get(key) ?? [49]).slice().sort((x, y) => x - y);
    return a[a.length >> 1];
  };

  // ---------- AY instruments, built on demand
  const instruments: Instrument[] = [defaultInstrument('--')];
  const plans = new Map<string, Plan>();
  const instMapOut: SongConvertResult['instMap'] = [];
  const nameOf = (i: number, k: number) => `${i.toString(16).toUpperCase().padStart(2, '0')}${k ? '.' + k : ''} ${options.names?.[i] ?? m.instruments[i]?.name ?? ''}`.trim().slice(0, 30);

  function mkSeq(steps: MacroStep[], loopFrom: number, release: number): Instrument {
    const ins = defaultInstrument();
    ins.seq = { steps, loopFrom, velocity: true, release };
    // keep the classic fields roughly right so a plain YM Tracker still plays something sensible
    const lv = steps.map((s) => s.vol);
    ins.adsr = { useAdsr: false, attack: 0, decay: 0, sustain: 15, release: Math.max(1, release) };
    ins.volEnv = lv.slice(0, 64).map((v) => clamp(Math.round(v), 0, 15));
    ins.toneEnabled = steps.some((s) => s.tone);
    ins.noiseEnabled = steps.some((s) => s.noise > 0);
    ins.noisePeriod = steps.find((s) => s.noise > 0)?.noise ?? 16;
    return ins;
  }

  function planFor(st: ChanState): Plan | null {
    const key = `${st.inst}:${st.ksmp}`;
    const cached = plans.get(key);
    if (cached) return cached;
    const inf = info.get(key);
    if (!inf || inf.cls === 'empty') return null;
    if (isDigi(st)) return null;
    const mp = modeOf(st.inst);
    const mode = mp?.mode ?? 'auto';
    const trans = Math.round(mp?.transpose ?? 0);
    if (instruments.length > 255) { warn('more than 255 instruments needed — extra ones share slot 255'); return plans.get('overflow') ?? null; }
    let plan: Plan, ins: Instrument;
    const forcedDrum = mode === 'kick' || mode === 'snare' || mode === 'hat' ? mode : undefined;
    if (mode === 'macro' && mp?.macro) {
      const mac = mp.macro;
      ins = mkSeq(mac.steps.map((s) => ({ ...s })), mac.loopFrom, 2);
      ins.seq!.velocity = mac.velocity;
      plan = { ay: instruments.length, kind: 'macro', kOct: trans, sustained: mac.loopFrom >= 0 };
    } else if (mode === 'tone' || (inf.cls === 'tonal' && !forcedDrum)) {
      // volume contour: play the sample at the instrument's typical note and measure every frame
      const s = st.smp;
      const nref = refNote(key);
      const base = m.amiga ? 3546894.6 / (428 * Math.pow(2, -(s.modFine ?? 0) / 96)) : 8363 * Math.pow(2, (s.rel * 128 + s.fine) / (12 * 128));
      const rate = base * Math.pow(2, (nref - 49) / 12);
      const per = Math.max(4, rate * dt);
      const steps: MacroStep[] = [];
      let pos = 0;
      const looped = s.loop !== 0 && s.ll > 2;
      const maxSteps = looped ? 48 : 160;
      let semiOff = 0, kOct = trans;
      if (mode !== 'tone') {
        const h49 = c4Hz.get(st.inst) ?? noteToFreq(49);
        const off = 12 * log2(h49 / noteToFreq(49));
        kOct += Math.round(off); semiOff = off - Math.round(off);
      }
      for (let k = 0; k < maxSteps; k++) {
        if (!looped && pos >= s.data.length) break;
        const w = fold(s, pos, pos + per);
        let sum = 0;
        for (let i = 0; i < w.length; i++) sum += w[i] * w[i];
        const rms = w.length ? Math.sqrt(sum / w.length) : 0;
        steps.push({ vol: aylvl(rms), semi: Math.round(semiOff * 100) / 100, noise: 0, tone: true });
        pos += per;
        if (looped && pos > s.ls + s.ll * 2 && k >= 3) break;
      }
      // never end a sustained instrument on a trailing zero, never start silent
      while (steps.length > 1 && steps[steps.length - 1].vol === 0 && looped) steps.pop();
      ins = mkSeq(steps, looped ? steps.length - 1 : -1, 3);
      plan = { ay: instruments.length, kind: 'tone', kOct, sustained: looped };
      // waveform -> buzzer: a saw / triangle / sine-like sample becomes the hardware envelope at the note's pitch.
      // The buzzer has no volume, so it is used for sustained samples (or when asked for) whose typical note is in range.
      const choice: WaveChoice | undefined = mp?.wave ?? (options.waveform && looped ? waveOfClass(analyseWave(s, inf.cycle).cls) : undefined);
      if (choice && choice !== 'tone') {
        const shape = BUZZ_SHAPE[choice];
        const nTyp = clamp(nref + kOct, 1, 96);
        if (buzzable(noteToFreq(nTyp), shape)) {
          ins.seq!.steps.forEach((x) => { x.tone = false; });
          ins.seq!.release = 0;
          ins.toneEnabled = false;
          ins.useHardEnv = true; ins.hardEnvShape = shape; ins.hardEnvAutoPeriod = true; ins.hardEnvDivisor = 1; ins.syncBuzz = false;
          if (shape === 10) plan.kOct += 12;                         // a triangle envelope cycle is two ramps: the written note is an octave up
          plan.buzz = true;
        } else report.push(`  ${nameOf(st.inst, st.ksmp)}: ${choice} waveform is out of the buzzer's range (typical note too high), played as a square wave`);
      }
    } else {
      const d = drumOf(st, forcedDrum);
      const lv = d.kind === 'kick' ? [1.0, 0.8, 0.55, 0.3] : d.kind === 'hat' ? [0.9, 0.5] : [1.0, 0.85, 0.6, 0.3];
      const steps: MacroStep[] = [];
      let f0 = 0;
      for (let age = 0; age < lv.length; age++) {
        const mac = drumMacro(d.kind, age, d.rms * lv[age]);
        if (!mac) break;
        const vol = clamp(pyRound(15 + 2 * log2(Math.max(1e-9, d.rms * lv[age]) / ref) + o.gainDb / 3.0103), 0, 15);
        if (mac.kind === 'tone') {
          const f = TONE_HZ / mac.per!;
          if (age === 0) f0 = f;
          steps.push({ vol, semi: Math.round(12 * log2(f / f0) * 100) / 100, noise: 0, tone: true });
        } else steps.push({ vol, semi: 0, noise: mac.np ?? 8, tone: false });
      }
      let fixedNote = 49;
      if (d.kind === 'kick') {
        const n = Math.round(12 * log2(f0 / noteToFreq(49))) + 49;
        fixedNote = clamp(n, 1, 96);
        const resid = Math.round(12 * log2(f0 / noteToFreq(fixedNote)) * 100) / 100;
        for (const s of steps) s.semi += resid;
      }
      ins = mkSeq(steps, -1, 0);
      plan = { ay: instruments.length, kind: d.kind, kOct: 0, fixedNote, sustained: false };
    }
    ins.name = nameOf(st.inst, st.ksmp);
    instruments.push(ins);
    plans.set(key, plan);
    instMapOut.push({ ay: plan.ay, src: st.inst, ksmp: st.ksmp, kind: plan.kind });
    return plan;
  }

  // ---------- per-row analysis of every source channel
  const nch = m.nch;
  function chInfo(rl: RowLog, c: number): ChInfo {
    const out: ChInfo = { active: false, lvl: 0, noise: false, st0: frames[rl.frame][c], stLast: null, trig: null };
    for (let k = 0; k < rl.len; k++) {
      const f = rl.frame + k;
      const st = frames[f][c];
      if (!st) continue;
      if (st.age === 0 && !(f > 0 && frames[f - 1].includes(st)) && !out.trig) out.trig = { off: k, st };
      if (st.vol <= 0 || isMuted(st.inst) || isDigi(st)) continue;
      const inf = info.get(`${st.inst}:${st.ksmp}`);
      if (!inf || inf.cls === 'empty') continue;
      const mp = modeOf(st.inst);
      const mode = mp?.mode ?? 'auto';
      let lvl = 0, noise = false, drum: DrumKind | undefined;
      if (mode === 'macro' && mp?.macro) {
        const mac = mp.macro, n = mac.steps.length;
        let idx = st.age;
        if (idx >= n) { if (mac.loopFrom < 0 || mac.loopFrom >= n) continue; idx = mac.loopFrom + ((idx - mac.loopFrom) % (n - mac.loopFrom)); }
        const sp = mac.steps[idx];
        lvl = clamp(pyRound(sp.vol + (mac.velocity ? 2 * log2(Math.max(st.vol, 1e-6)) : 0) + o.gainDb / 3.0103), 0, 15);
        noise = sp.noise > 0;
      } else if (mode === 'tone' || (inf.cls === 'tonal' && !(mode === 'kick' || mode === 'snare' || mode === 'hat'))) {
        const r = rmsOf(st);
        if (r === null) continue;
        lvl = aylvl(r * st.vol);
      } else {
        const forced = mode === 'kick' || mode === 'snare' || mode === 'hat' ? mode : undefined;
        const d = drumOf(st, forced);
        const lv = d.kind === 'kick' ? [1.0, 0.8, 0.55, 0.3] : d.kind === 'hat' ? [0.9, 0.5] : [1.0, 0.85, 0.6, 0.3];
        if (st.age >= lv.length) continue;
        lvl = aylvl(d.rms * st.vol * lv[st.age]);
        noise = d.kind !== 'kick'; drum = d.kind;
      }
      if (lvl <= 0) continue;
      out.active = true; out.stLast = st;
      if (lvl > out.lvl) { out.lvl = lvl; out.noise = noise; out.drum = drum; }
    }
    return out;
  }

  // ---------- target patterns: one big row list first, chunked later
  const nRows = rows.length;
  const flat: Cell[][] = Array.from({ length: nRows }, () => [emptyCell(), emptyCell(), emptyCell()]);
  const speedAt: number[] = rows.map((r) => clamp(r.len, 1, 31));

  const voices: Voice[] = Array.from({ length: 3 }, () => ({ owner: null, note: 0, ownerNote: 0, plan: null, vol: 64, arp: false, vibOn: false }));
  const played = new Array(nch).fill(0), foldedRows = new Array(nch).fill(0), droppedRows = new Array(nch).fill(0);
  const lastParam = new Map<string, number>();         // effect memory per source channel (1xx/2xx/3xx/4xy)
  let prevActive = new Array(nch).fill(false);

  const ayNote = (srcNote: number, plan: Plan): number => {
    let n = plan.fixedNote ?? srcNote + plan.kOct;
    n = clamp(n, 1, 96);
    // keep the YM period in range (30 Hz .. ) by moving whole octaves
    while (!plan.buzz && n < 85 && 2_000_000 / (16 * noteToFreq(n)) > 4095) n += 12;
    return clamp(n, 1, 96);
  };

  const periodOf = (note: number) => 2_000_000 / (16 * noteToFreq(note));

  /** translate the source cell's effect for AY voice cell; returns false when the effect cannot be expressed */
  function translateEffect(rl: RowLog, c: number, note: number, cell: Cell, st: ChanState | null): void {
    const src = m.patterns[rl.pat][rl.row][c];
    const eff = src.eff, par = src.par;
    const key = (k: string) => `${c}:${k}`;
    const P = periodOf(note);
    const tickScale = rl.bpm / 125;
    const slideRatio = (units: number, up: boolean): number => {
      if (m.amiga) {
        const p = Math.max(113, amigaPeriodOf((st?.note ?? 49) - PT_NOTE_BASE, st?.smp.modFine ?? 0));
        const ratio = up ? p / Math.max(1, p - units) : (p + units) / p;
        return ratio;
      }
      if (m.xmAmiga) {
        const p = Math.max(1, xmAmigaPeriodOf((st?.note ?? 49) - 1 + (st?.smp.rel ?? 0), st?.smp.fine ?? 0));
        return up ? p / Math.max(1, p - units) : (p + units) / p;
      }
      const r = Math.pow(2, (units * 4) / 768);
      return r;
    };
    const set = (e: string, p: number) => { if (!cell.effect) { cell.effect = parseEffectChar(e); cell.param = clamp(Math.round(p), 0, 255); } };
    switch (eff) {
      case 0x0:
        if (par) {
          let x = par >> 4, y = par & 15;
          if (options.arpOrder === 'yx') [x, y] = [y, x];
          set('0', (x << 4) | y);
        }
        break;
      case 0x1: case 0x2: {
        let p = par;
        if (!m.amiga) { if (p) lastParam.set(key('s'), p); else p = lastParam.get(key('s')) ?? 0; }
        if (!p) break;
        const up = eff === 0x1;
        const r = slideRatio(p, up);
        const units = up ? P * (1 - 1 / r) : P * (r - 1);
        set(up ? '1' : '2', clamp(Math.round(units * tickScale), 1, 255));
        break;
      }
      case 0x3: case 0x5: {
        let p = par;
        if (eff === 0x3) { if (p) lastParam.set(key('t'), p); else p = lastParam.get(key('t')) ?? 0; } else p = lastParam.get(key('t')) ?? 0;
        if (eff === 0x3 && p) {
          const r = slideRatio(p * (m.amiga ? 1 : 1), false);
          set('3', clamp(Math.round(P * (r - 1) * tickScale), 1, 255));
        } else if (eff === 0x5) {
          const r = slideRatio(p, false);
          set('3', clamp(Math.round(P * (r - 1) * tickScale), 1, 255));
        }
        break;
      }
      case 0x4: case 0x6: {
        let x = par >> 4, y = par & 15;
        if (eff === 0x6) { x = 0; y = 0; }
        if (x) lastParam.set(key('vx'), x);
        if (y) lastParam.set(key('vy'), y);
        const vx = x || lastParam.get(key('vx')) || 0, vy = y || lastParam.get(key('vy')) || 0;
        if (vx && vy) {
          let depth: number;
          if (m.amiga) {
            const p = Math.max(113, amigaPeriodOf((st?.note ?? 49) - PT_NOTE_BASE, st?.smp.modFine ?? 0));
            depth = 2 * P * (2 * vy / p);
          } else if (m.xmAmiga) {
            const p = Math.max(1, xmAmigaPeriodOf((st?.note ?? 49) - 1 + (st?.smp.rel ?? 0), st?.smp.fine ?? 0));
            depth = 2 * P * (vy / p);
          } else depth = 2 * P * (Math.pow(2, vy / 192) - 1);
          set('4', (clamp(vx, 1, 15) << 4) | clamp(Math.round(depth), 1, 15));
        }
        break;
      }
      case 0x7: case 0x8: case 0x9: case 0xa: case 0xb: case 0xc: case 0xd: case 0xf: case 0x10: case 0x11:
        break;   // volume handled by sampling, flow / tempo by unrolling, panning / global ignored
      case 0xe: {
        const sub = par >> 4;
        if (sub === 0x1 || sub === 0x2) warn('E1x/E2x fine slide');
        break;
      }
      default:
        if (eff) warn(`effect ${effLetter(eff) || eff.toString(16)}`);
    }
    if (src.vol >= 0xf0 && !cell.effect) { /* vol-column tone porta: covered by sampling */ }
  }

  const wantArp = Math.trunc(o.arpFill) > 1;
  const arpMax = Math.max(2, Math.trunc(o.arpFill));
  let arpRows = 0, noteOffs = 0, steals = 0;

  // middle layout: a source channel whose pitched notes sit below bassHz (median) is the bass
  const bassCh = new Set<number>();
  if (o.middleLayout) {
    const lim = o.bassHz ?? 200;
    for (let c = 0; c < nch; c++) {
      const hz: number[] = [];
      for (let ri = 0; ri < nRows; ri++) {
        const ci = chInfo(rows[ri], c);
        const st = ci.trig?.st ?? ci.stLast;
        if (ci.active && !ci.drum && !ci.noise && st) hz.push((c4Hz.get(st.inst) ?? 261.6255653) * Math.pow(2, (st.note - 49) / 12));
      }
      hz.sort((a, b) => a - b);
      if (hz.length && hz[hz.length >> 1] < lim) bassCh.add(c);
    }
  }

  for (let ri = 0; ri < nRows; ri++) {
    const rl = rows[ri];
    const cells = flat[ri];
    const infos: ChInfo[] = [];
    for (let c = 0; c < nch; c++) infos.push(chInfo(rl, c));

    // ----- choose the 3 most important sounding notes
    const cand: { c: number; score: number; v: number }[] = [];
    for (let c = 0; c < nch; c++) {
      const ci = infos[c];
      if (!ci.active) continue;
      let score = ci.lvl + (prio[c] ?? 0);
      if (ci.drum) score += o.drumBonus;
      if (voices.some((v) => v.owner === c)) score += o.sticky;
      if (ci.trig) score += 0.5;
      cand.push({ c, score, v: ci.lvl });
    }
    cand.sort((a, b) => b.score - a.score);
    const chosen: number[] = [];
    let noiseTaken = false;
    const overflow: number[] = [];
    const allowed = busyRow[ri] ? [0, 1] : [0, 1, 2];          // voice C is the digidrum's while it plays
    for (const { c } of cand) {
      if (chosen.length === allowed.length) { overflow.push(c); continue; }
      if (infos[c].noise) { if (noiseTaken) { overflow.push(c); continue; } noiseTaken = true; }
      chosen.push(c);
    }

    // ----- voices: keep owners, hand out free ones
    const ownerVoice = new Map<number, number>();
    voices.forEach((v, i) => { if (v.owner !== null && chosen.includes(v.owner) && allowed.includes(i)) ownerVoice.set(v.owner, i); });
    const used = new Set<number>(ownerVoice.values());
    const needVoice = chosen.filter((c) => !ownerVoice.has(c));
    // middle layout: 0 = drum / noise, 1 = bass channel, 2 = melody; the first two prefer voice B, melody voices A and C
    const roleOf = (c: number) => (infos[c].drum || infos[c].noise ? 0 : bassCh.has(c) ? 1 : 2);
    if (o.middleLayout && chosen.length < allowed.length && needVoice.some((c) => roleOf(c) <= 1)) {
      // a melody note sitting on B makes room for a bass / drum that needs it, when an outer voice is free
      for (const [oc, vi] of ownerVoice) if (vi === 1 && roleOf(oc) === 2) { ownerVoice.delete(oc); used.delete(1); needVoice.push(oc); break; }
    }
    if (o.middleLayout) needVoice.sort((a, b) => roleOf(a) - roleOf(b) || (prio[b] ?? 0) - (prio[a] ?? 0));
    else needVoice.sort((a, b) => Number(!!infos[a].drum) - Number(!!infos[b].drum) || (prio[b] ?? 0) - (prio[a] ?? 0));
    for (const c of needVoice) {
      const order = (o.middleLayout ? [[1, 0, 2], [1, 0, 2], [0, 2, 1]][roleOf(c)] : infos[c].drum || infos[c].noise ? [2, 1, 0] : [0, 1, 2]).filter((i) => allowed.includes(i));
      const pick = (o.middleLayout ? undefined : order.find((i) => !used.has(i) && voices[i].owner === null)) ?? order.find((i) => !used.has(i));
      if (pick === undefined) continue;                      // cannot happen (<= 3 chosen)
      if (voices[pick].owner !== null && prevActive[voices[pick].owner!]) steals++;
      ownerVoice.set(c, pick); used.add(pick);
    }

    // ----- voices that lost their owner: sustained instruments need an explicit key-off
    for (let i = 0; i < 3; i++) {
      const v = voices[i];
      if (v.owner === null || ownerVoice.get(v.owner) === i) continue;
      if (!used.has(i) && v.plan?.sustained && !cells[i].note) { cells[i].note = NOTE_OFF; noteOffs++; }
      v.owner = null; v.arp = false;
    }

    // ----- write the cells of the chosen notes
    for (const c of chosen) {
      const vi = ownerVoice.get(c)!;
      const v = voices[vi];
      const ci = infos[c];
      const cell = cells[vi];
      const st = ci.trig?.st ?? ci.st0 ?? ci.stLast!;
      const plan = planFor(ci.trig?.st ?? ci.stLast ?? st);
      if (!plan) continue;
      const wasOwner = v.owner === c;
      v.owner = c; v.plan = plan;
      const srcNote = (ci.trig?.st ?? ci.stLast ?? st).note;
      const note = ayNote(srcNote, plan);
      const trigger = !!ci.trig || !wasOwner;
      const vol64 = Math.round(clamp((ci.trig?.st ?? ci.st0 ?? st).vol, 0, 1) * 64);
      if (trigger) {
        const off = ci.trig ? ci.trig.off : 0;
        cell.note = note; cell.instrument = plan.ay;
        if (off > 0 && off < 16 && !cell.effect) { cell.effect = parseEffectChar('E'); cell.param = 0xd0 | off; }
        v.note = note; v.ownerNote = note; v.vol = 64; v.arp = false; v.vibOn = false;
        if (vol64 !== 64) { cell.volume = 0x10 + clamp(vol64, 0, 64); v.vol = vol64; }
        played[c]++;
      } else {
        v.ownerNote = ayNote(ci.stLast!.note, plan);
        // pitch changes without a new note (tone portamento) keep the voice; volume follows the source
        const vNow = Math.round(clamp(ci.st0!.vol, 0, 1) * 64);
        const stepsDiff = v.vol > 0 && vNow > 0 ? Math.abs(2 * log2(vNow / v.vol)) : (vNow !== v.vol ? 99 : 0);
        if (stepsDiff >= 1) { cell.volume = 0x10 + vNow; v.vol = vNow; }
        const src = m.patterns[rl.pat][rl.row][c];
        if (src.note > 0 && src.note < 97 && (src.eff === 3 || src.eff === 5 || src.vol >= 0xf0)) {
          cell.note = ayNote(src.note, plan); cell.instrument = plan.ay;     // tone-portamento target
          if (!cell.effect) { cell.effect = parseEffectChar('3'); cell.param = 8; }
        }
        played[c]++;
      }
      // vibrato state: the YM Tracker cannot switch vibrato off without a new note, so park it at depth 1
      translateEffect(rl, c, v.note, cell, ci.st0);
      if (cell.effect === parseEffectChar('4')) v.vibOn = true;
      else if (v.vibOn && !trigger && !cell.effect) { cell.effect = parseEffectChar('4'); cell.param = ((lastParam.get(`${c}:vx`) ?? 1) << 4) | 1; v.vibOn = false; }
    }

    // ----- arpeggio fill: overflow tones ride on the voice with the closest pitch
    const groups = new Map<number, number[]>();               // voice -> notes (host first)
    const lost: number[] = [];
    if (wantArp) {
      const ov = overflow.filter((c) => !infos[c].noise && infos[c].lvl >= o.arpMinVol).sort((a, b) => infos[b].lvl - infos[a].lvl);
      for (const c of overflow) if (!ov.includes(c)) lost.push(c);
      for (const c of ov) {
        const plan = planFor(infos[c].stLast!);
        if (!plan) { lost.push(c); continue; }
        const n = ayNote(infos[c].stLast!.note, plan);
        let best = -1, bd = Infinity;
        for (const hc of chosen) {
          const vi = ownerVoice.get(hc)!;
          const host = voices[vi];
          if (infos[hc].noise || infos[hc].drum) continue;
          const g = groups.get(vi) ?? [host.ownerNote];
          if (g.length >= arpMax) continue;
          const lo = Math.min(...g, n), hi = Math.max(...g, n);
          if (hi - lo > 15 || g.includes(n)) continue;
          const d = Math.abs(host.ownerNote - n);
          if (d < bd) { bd = d; best = vi; }
        }
        if (best < 0) { lost.push(c); continue; }
        const g = groups.get(best) ?? [voices[best].ownerNote];
        g.push(n); groups.set(best, g);
        foldedRows[c]++;
        arpRows++;
      }
    } else for (const c of overflow) lost.push(c);
    for (const c of lost) droppedRows[c]++;

    for (let i = 0; i < 3; i++) {
      const v = voices[i];
      const g = groups.get(i);
      const cell = cells[i];
      if (g && g.length > 1) {
        const base = Math.min(...g);
        const offs = [...new Set(g)].filter((n) => n !== base).map((n) => n - base).sort((a, b) => a - b);
        if (v.note !== base) { cell.note = base; cell.instrument = v.plan!.ay; v.note = base; if (cell.volume === 0 && v.vol !== 64) cell.volume = 0x10 + v.vol; }
        cell.effect = parseEffectChar('0');
        cell.param = (offs[0] << 4) | (offs[1] ?? 0);
        v.arp = true;
      } else if (v.arp) {
        // arpeggio over: the voice must be back on its owner's own pitch
        v.arp = false;
        if (v.owner !== null && v.note !== v.ownerNote && !cell.note) {
          cell.note = v.ownerNote; cell.instrument = v.plan!.ay; v.note = v.ownerNote;
          if (v.vol !== 64) cell.volume = 0x10 + v.vol;
        }
      }
    }

    // ----- digidrum hits of this row go to the drum column (first one wins, the others cannot share the cell)
    let wrote = false;
    for (let k = 0; k < rl.len; k++) {
      const h = hitAt.get(rl.frame + k);
      if (!h) continue;
      if (wrote) { drumHitsLost++; continue; }
      const dc = drumCells[ri];
      dc.note = h.idx + 1;
      if (k > 0 && k < 16) { dc.effect = parseEffectChar('E'); dc.param = 0xd0 | k; }
      wrote = true; drumHitsWritten++;
    }

    prevActive = infos.map((x) => x.active);
  }

  // ---------- timing: Fxx wherever the row length changes
  const first = speedAt[0];
  let curSpeed = first;
  let pendingSpeed: number | null = null;
  let timingSlips = 0;
  for (let ri = 0; ri < nRows; ri++) {
    if (speedAt[ri] !== curSpeed) pendingSpeed = speedAt[ri];
    if (pendingSpeed === null) continue;
    let slot = flat[ri].findIndex((c) => !c.effect);
    if (slot < 0) {
      // all three effect columns busy: give up the least valuable one (never an arpeggio)
      slot = flat[ri].findIndex((c) => c.effect !== parseEffectChar('0'));
      if (slot >= 0) timingSlips++;
    }
    if (slot < 0) continue;
    flat[ri][slot].effect = parseEffectChar('F');
    flat[ri][slot].param = pendingSpeed;
    curSpeed = pendingSpeed; pendingSpeed = null;
  }

  // ---------- digidrum column + the instrument that holds the sample bank
  const hasDigi = drumHitsWritten > 0;
  let bankInst = 0;
  if (hasDigi) {
    if (instruments.length > 255) { warnings.push('no free instrument slot for the digidrum bank'); }
    else {
      const bank = defaultInstrument('Digidrums');
      bank.digiDrums = digi.list;
      bankInst = instruments.length;
      instruments.push(bank);
      for (let ri = 0; ri < nRows; ri++) { if (drumCells[ri].note) drumCells[ri].instrument = bankInst; flat[ri] = [...flat[ri], drumCells[ri]]; }
    }
  }

  // ---------- chunk into patterns along the played flow, loop target gets its own pattern start
  let loopRow = rows.findIndex((r) => r.frame <= rep.loopFrame && rep.loopFrame < r.frame + r.len);
  if (loopRow < 0) loopRow = 0;
  const chunks: { start: number; end: number }[] = [];
  let st0 = 0;
  for (let ri = 1; ri <= nRows; ri++) {
    const brk = ri === nRows || rows[ri].pat !== rows[ri - 1].pat || rows[ri].row !== rows[ri - 1].row + 1 || ri === loopRow || ri - st0 >= 128;
    if (brk) { chunks.push({ start: st0, end: ri }); st0 = ri; }
  }
  const pats: Pattern[] = [];
  const order: number[] = [];
  const seen = new Map<string, number>();
  let restartPos = 0;
  chunks.forEach((ch, idx) => {
    const cells: Cell[][] = [];
    for (let ri = ch.start; ri < ch.end; ri++) cells.push(flat[ri]);
    const pat: Pattern = { rows: cells.length, cells };
    const sig = o.dedupe ? JSON.stringify(cells) : String(idx);
    let pi = seen.get(sig);
    if (pi === undefined) { pi = pats.length; pats.push(pat); seen.set(sig, pi); }
    if (ch.start <= loopRow && loopRow < ch.end) restartPos = order.length;
    order.push(pi);
  });
  if (pats.length > 255) warnings.push(`${pats.length} patterns: more than the 255 a .ymt file can order`);
  if (instruments.length > 256) warnings.push(`${instruments.length - 1} instruments: only the first 255 fit a pattern cell`);

  const song = newSong(hasDigi && bankInst ? 4 : 3);
  song.name = (m.title || 'Converted module').slice(0, 32);
  song.patterns = pats.length ? pats : [emptyPattern(16, song.channelCount ?? 3)];
  song.order = order.length ? order : [0];
  song.restartPos = restartPos;
  song.speed = first;
  song.bpm = 125;
  song.instruments = instruments;
  song.channelNames = ['A', 'B', 'C'];
  if (hasDigi && bankInst) { song.channelNames.push('Drum'); song.drumChannel = 3; }

  report.push(`${chunks.length} pattern visits -> ${pats.length} patterns after merging, ${order.length} order entries, ${instruments.length - 1} instruments`);
  const sum = (a: number[]) => a.reduce((p, c) => p + c, 0);
  report.push(`voice rows: ${sum(played)} played, ${sum(foldedRows)} in arpeggios, ${sum(droppedRows)} dropped, ${steals} voice steals, ${noteOffs} key-offs`);
  if (hasDigi) {
    const bytes = digi.list.reduce((n, d) => n + d.pcm.length, 0);
    report.push(`digidrums: ${digi.list.length} sample(s), ${bytes.toLocaleString()} bytes at ~${digi.rateHz} Hz, ${drumHitsWritten} hit(s) on the drum channel${drumHitsLost ? `, ${drumHitsLost} lost (two hits in one row)` : ''}${digi.skipped ? `, ${digi.skipped} skipped (more than 63 variants)` : ''}`);
    if (digi.skipped) warnings.push(`${digi.skipped} digidrum hit(s) skipped: more than 63 sample variants`);
  } else if (digiOn) report.push('digidrums: no percussion hits found');
  if (timingSlips) report.push(`${timingSlips} tempo changes had to replace an effect`);
  for (const [k, n] of warnCount) warnings.push(`${k} x${n} not translated`);
  void FX;
  return { song, report, warnings, played, folded: foldedRows, dropped: droppedRows, instMap: instMapOut };
}
