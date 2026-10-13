/**
 * Module -> YM2149 register stream. Replays the module, turns every sounding channel into an
 * AY event (tone period + level, or a drum macro), then picks the best 3 events per frame.
 */
import type { Module, Sample } from './types';
import { replay, FPS, type ChanState } from './replay';
import { analyseSample, fold, ended, type SampleInfo } from './samples';
import { powerSpectrum } from './fft';
import { DigiExtractor } from './digi';
import { analyseWave, waveOfClass, BUZZ_SHAPE, BUZZ_MIN_LEVEL, buzzPeriod, buzzable, type WaveChoice, type WaveClass, type WaveInfo } from './waveform';
import { type DrumTrack, MAX_DRUMS, drumFrames, prepareDrum, silenceDrumVoices, trigCode } from './drums';

export const YM_CLOCK = 2_000_000;
export const TONE_HZ = YM_CLOCK / 16.0; // period 1 -> 125 kHz
export const NREGS = 14;

export type DrumKind = 'kick' | 'hat' | 'snare';

/** one 20 ms step of a hand-made AY instrument */
export interface MacroStep {
  /** AY volume 0..15 */
  vol: number;
  /** pitch offset in semitones (fractional allowed) added to the played note */
  semi: number;
  /** noise period 1..31, 0 = no noise */
  noise: number;
  /** tone on/off (off + noise = pure noise) */
  tone: boolean;
  /** in an envelope (buzzer) instrument: this step plays as a plain tone / noise voice, not through the hardware envelope */
  plain?: boolean;
}
export interface Macro {
  steps: MacroStep[];
  /** step to jump back to after the last one; -1 = one-shot (silent afterwards) */
  loopFrom: number;
  /** scale by the source note volume / envelope (3 dB per AY step) */
  velocity: boolean;
}
/**
 * How a source instrument is turned into AY sound.
 *  auto   - detect (tonal sample -> tone at the measured pitch, otherwise drum macro)
 *  mute   - leave the instrument out
 *  tone   - force a tone at the written note's pitch, volume follows the sample's own envelope
 *  kick/snare/hat - the built-in drum macros
 *  digi   - play the sample itself as a 4-bit digidrum (MFP timer interrupt), see ConvertOptions.digiDrums
 *  macro  - the per-tick sequence in `macro`
 */
export type InstMode = 'auto' | 'mute' | 'tone' | DrumKind | 'macro' | 'digi';
export interface InstMap {
  mode: InstMode; macro?: Macro; /** semitones */ transpose?: number;
  /** waveform of a tonal instrument: 'tone' = square wave, saw / sawup / smooth = hardware-envelope buzzer; unset = detect (when ConvertOptions.waveform is on) */
  wave?: WaveChoice;
}

export interface ConvertOptions {
  /** extra allocation priority per 0-based source channel */
  prio?: Record<number, number>;
  /** force a drum macro for an instrument number */
  drumClass?: Record<number, DrumKind>;
  /** manual instrument mapping (wins over drumClass) */
  inst?: Record<number, InstMap>;
  /** fold notes that lost a voice into a fast arpeggio on another voice: max notes per voice (0/1 = off) */
  arpFill?: number;
  /** minimum AY volume for a dropped note to be folded */
  arpMinVol?: number;
  /** override the detected cycle length (samples) of an instrument's first sample */
  cycle?: Record<number, number>;
  /** play every percussion-like instrument (not tonal, not forced to a drum macro) as a digidrum sample */
  digiDrums?: boolean;
  /** digidrum play rate, Hz (nearest MFP rate is used), default 8000 */
  digiRate?: number;
  /** longest digidrum, ms, default 500 */
  digiMaxMs?: number;
  drumBonus?: number;
  drumGain?: number;
  gainDb?: number;
  sticky?: number;
  refPercentile?: number;
  arpOrder?: 'xy' | 'yx';
  loopOrder?: number;
  /**
   * AY-composer voice layout: bass and the synthetic drums on the middle voice (B), melody and arpeggios on the outer
   * voices (A, C), so the three voices sit in different frequency ranges. Digidrums stay on voice C.
   */
  middleLayout?: boolean;
  /** notes below this frequency count as bass for the middle layout, Hz (default 200) */
  bassHz?: number;
  /**
   * map the sample's waveform to the closest AY sound: sawtooth / triangle / sine-like tonal instruments become the
   * hardware-envelope buzzer where it can hit the pitch (see core/waveform). Off: every tonal sample is a square wave.
   * An instrument's own `wave` setting always applies.
   */
  waveform?: boolean;
  /** AY level a note needs to be played as a buzzer instead of a square wave (the buzzer has no volume), default 12 */
  buzzMinLevel?: number;
}

const DEFAULTS = { drumBonus: 3.0, drumGain: 1.0, gainDb: 0.0, sticky: 1.5, refPercentile: 97.0 };

/** Python-style round-half-to-even, so results match the reference implementation */
export function pyRound(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function percentile(values: number[], p: number): number {
  const a = Float64Array.from(values).sort();
  if (!a.length) return 1;
  const pos = ((a.length - 1) * p) / 100;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

interface Cand {
  ch: number;
  kind: 'tone' | 'noise';
  per: number | null;
  np: number | null;
  lvl: number;
  inst: number;
  drum?: DrumKind;
  /** macro notes: AY volume decided already (before gain) */
  fixedVol?: number;
  /** hardware-envelope shape this tonal note would like to be played with (buzzer), 0 = square tone */
  buzz?: number;
  /** frames since the note started */
  age?: number;
}
const A4_TO_C4 = 261.6255653;
const noteHz = (note: number) => A4_TO_C4 * Math.pow(2, (note - 49) / 12);

export function drumMacro(kind: DrumKind, age: number, base: number): Omit<Cand, 'ch' | 'inst' | 'drum'> | null {
  if (kind === 'kick') {
    const lv = [1.0, 0.8, 0.55, 0.3];
    if (age >= lv.length) return null;
    const f = 150.0 * Math.pow(0.45, age / (lv.length - 1)); // falling thump 150 -> 68 Hz
    return { kind: 'tone', per: TONE_HZ / f, np: null, lvl: base * lv[age] };
  }
  if (kind === 'hat') {
    const lv = [0.9, 0.5];
    if (age >= lv.length) return null;
    return { kind: 'noise', per: null, np: 3, lvl: base * lv[age] };
  }
  const lv = [1.0, 0.85, 0.6, 0.3];
  const npv = [12, 10, 8, 8];
  if (age >= lv.length) return null;
  return { kind: 'noise', per: null, np: npv[age], lvl: base * lv[age] };
}

/** kick / snare / hat decision (and RMS) for a non-tonal sample */
export function classifyDrum(m: Module, s: Sample, inf: SampleInfo, forced?: DrumKind): { kind: DrumKind; rms: number } {
  const d = s.data;
  const rateC5 = (m.amiga ? 3546894.6 / 428 * 2 : 8363 * Math.pow(2, (s.rel * 128 + s.fine) / (12 * 128)) * 2);
  const win = new Float64Array(d.length);
  for (let i = 0; i < d.length; i++) win[i] = d[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, d.length - 1)));
  const { power, size } = powerSpectrum(win);
  let num = 0, den = 0;
  for (let k = 0; k < power.length; k++) { num += power[k] * ((k * rateC5) / size); den += power[k]; }
  const cen = num / Math.max(den, 1e-12);
  const durTicks = d.length / rateC5 / (1 / FPS);
  const kind: DrumKind = forced ?? (inf.cls === 'kick' || cen < 400 ? 'kick' : durTicks <= 2.0 ? 'hat' : 'snare');
  let sq = 0;
  for (let i = 0; i < d.length; i++) sq += d[i] * d[i];
  return { kind, rms: Math.sqrt(sq / d.length) };
}

export interface InstrumentReport {
  inst: number;
  name: string;
  cls: SampleInfo['cls'];
  /** pitch of C-4 (XM) / PT C-2 for this instrument in Hz, tonal only */
  c4Hz?: number;
  drum?: DrumKind;
  /** played as a digidrum sample */
  digi?: boolean;
  mode?: InstMode;
  /** detected waveform of a tonal sample */
  wave?: WaveClass;
  /** played (at least partly) as a hardware-envelope buzzer */
  buzz?: boolean;
}

export interface ConvertResult {
  /** nframes * 14 bytes, frame-major R0..R13 */
  regs: Uint8Array;
  nframes: number;
  loopFrame: number;
  report: string[];
  instruments: InstrumentReport[];
  /** per source channel: frames that got a voice / frames dropped for lack of voices */
  played: number[];
  dropped: number[];
  /** per source channel: frames whose note was folded into an arpeggio */
  folded: number[];
  /** per frame: notes that got no voice at all / notes riding in an arpeggio */
  dropPerFrame: Uint8Array;
  arpPerFrame: Uint8Array;
  warnings: string[];
  /** digidrum samples + one trigger per frame (voice C), when any instrument was converted to digidrums */
  drums?: DrumTrack;
}

export function convert(m: Module, options: ConvertOptions = {}): ConvertResult {
  const o = { ...DEFAULTS, ...options };
  const prio = options.prio ?? {};
  const report: string[] = [];
  const log = (s: string) => report.push(s);

  log(`'${m.title}': ${m.kind.toUpperCase()}, ${m.nch} channels, ${m.patterns.length} patterns, order length ${m.order.length}, speed ${m.speed}, BPM ${m.bpm}`);

  // ---- instrument analysis
  const info = new Map<string, SampleInfo>();
  const waves = new Map<string, WaveInfo>();
  const instReports: InstrumentReport[] = [];
  m.instruments.forEach((ins, i) => {
    if (!ins) return;
    ins.samples.forEach((s, k) => {
      const a = analyseSample(s, k === 0 ? options.cycle?.[i] : undefined);
      info.set(`${i}:${k}`, a);
      if (a.cls === 'tonal') waves.set(`${i}:${k}`, analyseWave(s, a.cycle));
    });
    const a = info.get(`${i}:0`);
    if (a && a.cls !== 'empty') {
      const r: InstrumentReport = { inst: i, name: ins.name, cls: a.cls };
      const wv = waves.get(`${i}:0`);
      if (wv) r.wave = wv.cls;
      if (a.cls === 'tonal' && a.cycle) {
        const s = ins.samples[0];
        const rate = m.amiga ? 3546894.6 / (428 * Math.pow(2, -(s.modFine ?? 0) / 96)) : 8363 * Math.pow(2, (s.rel * 128 + s.fine) / (12 * 128));
        r.c4Hz = rate / a.cycle;
      }
      instReports.push(r);
    }
  });

  // ---- replay
  const rep = replay(m, { arpOrder: options.arpOrder });
  const nf = rep.frames.length;
  let loopFrame = rep.loopFrame;
  if (options.loopOrder !== undefined) loopFrame = rep.orderFrame.get(options.loopOrder) ?? 0;
  log(`replayed ${nf} frames = ${(nf / FPS).toFixed(2)} s, loop to frame ${loopFrame}`);
  const warnings = [...rep.warnings].map(([k, v]) => `unsupported effect ${k} x${v}`);
  warnings.forEach((w) => log('  note: ' + w));

  // ---- candidates
  const dt = 1 / FPS;
  const drumCache = new Map<string, { kind: DrumKind; rms: number }>();
  const cand: Cand[][] = [];
  // digidrums: sample table, cache by (sample, start, pitch, volume class) and the hits found
  const digiOn = !!options.digiDrums || Object.values(options.inst ?? {}).some((x) => x.mode === 'digi');
  const digiRate = options.digiRate ?? 8000, digiMaxMs = options.digiMaxMs ?? 500;
  const digi = new DigiExtractor(m, { rateHz: digiRate, maxMs: digiMaxMs });
  const digiList = digi.list;
  const digiHits: { f: number; ch: number; idx: number; cls: number }[] = [];
  const digiHit = (f: number, ci: number, st: ChanState) => {
    const h = digi.hit(st);
    if (h) digiHits.push({ f, ch: ci, ...h });
  };
  for (const snap of rep.frames) {
    const fIdx = cand.length;
    const lst: Cand[] = [];
    snap.forEach((st: ChanState | null, ci) => {
      if (!st || st.vol <= 0) return;
      const inf = info.get(`${st.inst}:${st.ksmp}`);
      if (!inf || inf.cls === 'empty') return;
      const s = st.smp;
      const mp = options.inst?.[st.inst];
      const mode: InstMode = mp?.mode ?? 'auto';
      if (mode === 'mute') return;
      const bend = st.rate / st.noteRate;
      const trans = Math.pow(2, (mp?.transpose ?? 0) / 12);
      if (mode === 'macro' && mp?.macro && mp.macro.steps.length) {
        const mac = mp.macro, n = mac.steps.length;
        let idx = st.age;
        if (idx >= n) {
          if (mac.loopFrom < 0 || mac.loopFrom >= n) return;
          idx = mac.loopFrom + ((idx - mac.loopFrom) % (n - mac.loopFrom));
        }
        const stp = mac.steps[idx];
        const hz = noteHz(st.note) * bend * trans * Math.pow(2, stp.semi / 12);
        const fixedVol = stp.vol + (mac.velocity ? 2 * Math.log2(Math.max(st.vol, 1e-6)) : 0);
        if (stp.noise && !stp.tone) lst.push({ ch: ci, kind: 'noise', per: null, np: stp.noise, lvl: 1, inst: st.inst, fixedVol });
        else lst.push({ ch: ci, kind: 'tone', per: TONE_HZ / hz, np: stp.noise || null, lvl: 1, inst: st.inst, fixedVol });
        return;
      }
      const forcedDrum: DrumKind | undefined = mode === 'kick' || mode === 'snare' || mode === 'hat' ? mode : undefined;
      if (digiOn && (mode === 'digi' || (options.digiDrums && !forcedDrum && mode !== 'tone' && inf.cls !== 'tonal'))) {
        const ir = instReports.find((r) => r.inst === st.inst);
        if (ir) ir.digi = true;
        if (st.age === 0 && !(fIdx > 0 && rep.frames[fIdx - 1].includes(st))) digiHit(fIdx, ci, st);
        return;
      }
      if (mode === 'tone' || (inf.cls === 'tonal' && !forcedDrum)) {
        if (ended(s, st.pos)) return;
        const n = Math.max(4, Math.trunc(st.rate * dt));
        const w = fold(s, st.pos, st.pos + n);
        if (!w.length) return;
        let sum = 0;
        for (let i = 0; i < w.length; i++) sum += w[i] * w[i];
        const rms = Math.sqrt(sum / w.length);
        const hz = mode === 'tone' ? noteHz(st.note) * bend * trans : (st.rate / inf.cycle!) * trans;
        const choice: WaveChoice | undefined = mp?.wave ?? (options.waveform ? waveOfClass(waves.get(`${st.inst}:${st.ksmp}`)?.cls ?? 'complex') : undefined);
        lst.push({ ch: ci, kind: 'tone', per: TONE_HZ / hz, np: null, lvl: rms * st.vol, inst: st.inst, buzz: choice ? BUZZ_SHAPE[choice] : 0, age: st.age });
      } else {
        const key = `${st.inst}:${st.ksmp}`;
        let bc = drumCache.get(key);
        if (!bc) {
          const over = forcedDrum ?? options.drumClass?.[st.inst];
          bc = classifyDrum(m, s, inf, over);
          drumCache.set(key, bc);
          const ir = instReports.find((r) => r.inst === st.inst);
          if (ir) ir.drum = bc.kind;
        }
        const mac = drumMacro(bc.kind, st.age, bc.rms * st.vol * o.drumGain);
        if (mac) lst.push({ ...mac, ch: ci, inst: st.inst, drum: bc.kind });
      }
    });
    cand.push(lst);
  }

  // ---- digidrum schedule: voice C belongs to the sample while it plays, a new drum cuts the old one
  const trig = new Uint8Array(nf);
  const busy = new Uint8Array(nf);
  let digiTrack: DrumTrack | undefined;
  if (digiHits.length) {
    const byFrame = new Map<number, { cls: number; idx: number }>();
    for (const h of digiHits) { const p = byFrame.get(h.f); if (!p || h.cls < p.cls) byFrame.set(h.f, { cls: h.cls, idx: h.idx }); }
    const frames = [...byFrame.keys()].sort((a, b) => a - b);
    frames.forEach((f, k) => {
      const hit = byFrame.get(f)!;
      trig[f] = trigCode(2, hit.idx);
      const end = Math.min(nf, frames[k + 1] ?? nf, f + drumFrames(digiList[hit.idx]));
      for (let g = f; g < end; g++) busy[g] = 1;
    });
    digiTrack = { drums: digiList, trig };
  }

  // ---- allocation
  const arpMax = Math.max(1, Math.trunc(options.arpFill ?? 0));
  const arpMinVol = options.arpMinVol ?? 3;
  const tl: number[] = [];
  for (const fr of cand) for (const c of fr) if (c.kind === 'tone' && !c.drum && c.fixedVol === undefined) tl.push(c.lvl);
  const ref = tl.length ? percentile(tl, o.refPercentile) : 1;
  const ayVol = (c: Cand) => {
    if (c.fixedVol !== undefined) return Math.max(0, Math.min(15, pyRound(c.fixedVol + o.gainDb / 3.0103)));
    if (c.lvl <= 0) return 0;
    const v = 15 + 2.0 * Math.log2(c.lvl / ref) + o.gainDb / 3.0103;
    return Math.max(0, Math.min(15, pyRound(v)));
  };
  const usesNoise = (c: Cand) => c.kind === 'noise' || c.np != null;
  const NV = 3;
  type Item = { v: number; c: Cand; arp?: { v: number; c: Cand }[] };
  const imp = new Map<number, number>();
  for (const fr of cand) for (const c of fr) imp.set(c.ch, (imp.get(c.ch) ?? 0) + (c.drum ? 0 : ayVol(c)));
  const rank = new Map<number, number>();
  for (const [ch, v] of imp) rank.set(ch, -v - 1000.0 * (prio[ch] ?? 0));
  // voice layout: 0 = drum / noise, 1 = bass, 2 = melody; each prefers its own voices
  const middle = !!options.middleLayout;
  const bassPer = 125000 / Math.max(20, options.bassHz ?? 200);
  // a channel is a bass channel when its pitched notes sit below bassHz on median (stable over the song)
  const perOf = new Map<number, number[]>();
  for (const fr of cand) for (const c of fr) if (c.kind === 'tone' && !c.drum && c.np == null && c.per != null) { const l = perOf.get(c.ch) ?? []; l.push(c.per); perOf.set(c.ch, l); }
  const bassCh = new Set<number>();
  for (const [ch, l] of perOf) { l.sort((a, b) => a - b); if (l[l.length >> 1] > bassPer) bassCh.add(ch); }
  const role = (c: Cand) => (c.drum || c.kind === 'noise' || c.np != null ? 0 : bassCh.has(c.ch) ? 1 : 2);
  const ROLE_ORDER: number[][] = [[1, 0, 2], [1, 0, 2], [0, 2, 1]];
  let slots: (number | null)[] = [null, null, null];
  const alloc: (Item | null)[][] = [];
  const played = new Array(m.nch).fill(0), dropped = new Array(m.nch).fill(0), folded = new Array(m.nch).fill(0);
  const dropPerFrame = new Uint8Array(cand.length), arpPerFrame = new Uint8Array(cand.length);
  cand.forEach((fr, f) => {
    const scored: { score: number; v: number; c: Cand }[] = [];
    for (const c of fr) {
      const v = ayVol(c);
      if (v <= 0) continue;
      let score = v + (prio[c.ch] ?? 0);
      if (c.drum) score += o.drumBonus;
      if (slots.includes(c.ch)) score += o.sticky;
      scored.push({ score, v, c });
    }
    scored.sort((a, b) => b.score - a.score);
    const chosen: Item[] = [];
    const overflow: { v: number; c: Cand }[] = [];
    let noiseTaken = false;
    for (const { v, c } of scored) {
      if (chosen.length === NV - busy[f]) { overflow.push({ v, c }); continue; }
      if (usesNoise(c)) {
        if (noiseTaken) { overflow.push({ v, c }); continue; }
        noiseTaken = true;
      }
      chosen.push({ v, c });
      played[c.ch]++;
    }
    for (const ov of overflow) {
      let host: Item | null = null;
      if (arpMax > 1 && ov.c.kind === 'tone' && !ov.c.drum && ov.c.np == null && ov.v >= arpMinVol) {
        let bd = Infinity;
        for (const h of chosen) {
          if (h.c.kind !== 'tone' || h.c.drum || h.c.np != null || h.c.ch === ov.c.ch) continue;
          if (1 + (h.arp?.length ?? 0) >= arpMax) continue;
          const d = Math.abs(Math.log2(h.c.per! / ov.c.per!));
          if (d < bd) { bd = d; host = h; }
        }
      }
      if (host) { (host.arp ??= []).push(ov); folded[ov.c.ch]++; arpPerFrame[f]++; }
      else { dropped[ov.c.ch]++; dropPerFrame[f]++; }
    }
    const nw: (Item | null)[] = [null, null, null];
    const rest: Item[] = [];
    const freeSlots = busy[f] ? [0, 1] : [0, 1, 2];
    // middle layout: a melody note sitting on B makes room for a bass / drum that needs it, when an outer voice is free
    const needMid = middle && chosen.length < freeSlots.length && chosen.some((it) => role(it.c) <= 1 && !slots.includes(it.c.ch));
    for (const it of chosen) {
      const si = slots.indexOf(it.c.ch);
      if (si >= 0 && freeSlots.includes(si) && nw[si] === null && !(needMid && si === 1 && role(it.c) === 2)) nw[si] = it; else rest.push(it);
    }
    rest.sort((a, b) => middle
      ? (role(a.c) - role(b.c)) || ((rank.get(a.c.ch) ?? 0) - (rank.get(b.c.ch) ?? 0))
      : (Number(!!a.c.drum) - Number(!!b.c.drum)) || ((rank.get(a.c.ch) ?? 0) - (rank.get(b.c.ch) ?? 0)));
    for (const it of rest) {
      const order = (middle ? ROLE_ORDER[role(it.c)] : it.c.drum ? [2, 1, 0] : [0, 1, 2]).filter((i) => freeSlots.includes(i));
      for (const i of order) if (nw[i] === null) { nw[i] = it; break; }
    }
    slots = nw.map((it) => (it ? it.c.ch : null));
    alloc.push(nw);
  });

  // ---- registers
  const regs = new Uint8Array(nf * NREGS);
  const prevPer = [1000, 1000, 1000];
  let prevNp = 8;
  let prevMix = [0, 0, 0];
  let octShift = 0;
  // buzzer (hardware envelope as a sawtooth / triangle voice): one voice at a time, loud notes in range only
  const buzzMin = options.buzzMinLevel ?? BUZZ_MIN_LEVEL;
  let prevBuzz: { voice: number; ch: number; shape: number } | null = null;
  let buzzFrames = 0;
  const buzzInst = new Set<number>();
  for (let f = 0; f < nf; f++) {
    const vols = [0, 0, 0];
    // pick the buzzer voice of this frame
    let bz: { voice: number; shape: number; period: number; retrig: boolean } | null = null;
    {
      let best = -1, bestV = -1;
      alloc[f].forEach((it0, i) => {
        if (!it0 || it0.arp) return;
        const { v, c } = it0;
        if (!c.buzz || c.kind !== 'tone' || c.np != null || v < buzzMin || !buzzable(TONE_HZ / c.per!, c.buzz)) return;
        const own = prevBuzz && prevBuzz.voice === i && prevBuzz.ch === c.ch ? 100 : 0;
        if (v + own > bestV) { bestV = v + own; best = i; }
      });
      if (best >= 0) {
        const c = alloc[f][best]!.c;
        const period = Math.max(1, Math.min(65535, pyRound(buzzPeriod(TONE_HZ / c.per!, c.buzz!))));
        const pb = prevBuzz as { voice: number; ch: number; shape: number } | null;
        const same: boolean = !!pb && pb.voice === best && pb.ch === c.ch && pb.shape === c.buzz;
        bz = { voice: best, shape: c.buzz!, period, retrig: !same || c.age === 0 || f === 0 || f === loopFrame };
        buzzInst.add(c.inst);
        buzzFrames++;
      }
      prevBuzz = bz ? { voice: bz.voice, ch: alloc[f][bz.voice]!.c.ch, shape: bz.shape } : null;
    }
    const mixbits = [...prevMix];
    let npv = prevNp;
    alloc[f].forEach((it0, i) => {
      if (!it0) return;
      const it = it0.arp ? [it0, ...it0.arp][f % (1 + it0.arp.length)] : it0;
      const { v, c } = it;
      vols[i] = v;
      if (bz && bz.voice === i) { vols[i] = 0x10; mixbits[i] = 0; return; }
      if (c.kind === 'tone') {
        let per = c.per!;
        while (per > 4095) { per /= 2.0; octShift++; }
        while (per < 1.0) per *= 2.0;
        per = Math.max(1, Math.min(4095, pyRound(per)));
        prevPer[i] = per;
        mixbits[i] = 1;
        if (c.np != null) { npv = c.np; mixbits[i] = 3; }
      } else {
        npv = c.np!;
        mixbits[i] = 2;
      }
    });
    prevNp = npv;
    prevMix = mixbits;
    let mix = 0xc0;
    for (let i = 0; i < 3; i++) {
      if (!(mixbits[i] & 1)) mix |= 1 << i;
      if (!(mixbits[i] & 2)) mix |= 8 << i;
    }
    const b = f * NREGS;
    for (let i = 0; i < 3; i++) { regs[b + 2 * i] = prevPer[i] & 0xff; regs[b + 2 * i + 1] = prevPer[i] >> 8; }
    regs[b + 6] = prevNp; regs[b + 7] = mix;
    regs[b + 8] = vols[0]; regs[b + 9] = vols[1]; regs[b + 10] = vols[2];
    if (bz) { regs[b + 11] = bz.period & 255; regs[b + 12] = bz.period >> 8; }
    else if (f > 0) { regs[b + 11] = regs[b - NREGS + 11]; regs[b + 12] = regs[b - NREGS + 12]; }
    regs[b + 13] = bz && bz.retrig ? bz.shape : 0xff;       // 0xff = envelope shape not written (a write restarts the envelope)
  }
  if (!buzzFrames) for (let f = 0; f < nf; f++) regs[f * NREGS + 13] = 0;

  if (buzzFrames) {
    log(`buzzer: ${buzzFrames} frame(s) played as a hardware-envelope sawtooth / triangle voice`);
    for (const r of instReports) if (buzzInst.has(r.inst)) r.buzz = true;
  }
  log(`loudness reference (tonal p${o.refPercentile}) = ${ref.toFixed(3)} -> AY volume 15`);
  log(arpMax > 1 ? 'channel   voice-frames   in-arpeggio   dropped' : 'channel   voice-frames   dropped');
  for (let c = 0; c < m.nch; c++) {
    if (played[c] + dropped[c] + folded[c] === 0) continue;
    const tot = played[c] + dropped[c] + folded[c];
    log(`  ch${String(c + 1).padStart(2, '0')}  ${String(played[c]).padStart(10)}  ${arpMax > 1 ? String(folded[c]).padStart(11) + '  ' : ''}${String(dropped[c]).padStart(8)}  ${((100 * dropped[c]) / Math.max(1, tot)).toFixed(1)}%`);
  }
  if (octShift) log(`${octShift} events needed an octave shift (period > 4095)`);
  if (digiTrack) {
    silenceDrumVoices(regs, nf, digiTrack);
    const bytes = digiList.reduce((n, d) => n + d.pcm.length, 0);
    log(`digidrums: ${digiList.length} sample(s), ${bytes.toLocaleString()} bytes at ~${digiRate} Hz, ${digiHits.length} hit(s)${digi.skipped ? `, ${digi.skipped} hit(s) skipped (more than ${MAX_DRUMS} variants)` : ''}; voice C is busy ${busy.reduce((n, x) => n + x, 0)} of ${nf} frames`);
    if (digi.skipped) warnings.push(`${digi.skipped} digidrum hit(s) skipped: more than ${MAX_DRUMS} sample variants`);
  } else if (digiOn) log('digidrums: no percussion hits found');

  return { regs, nframes: nf, loopFrame, report, instruments: instReports, played, dropped, folded, dropPerFrame, arpPerFrame, warnings, drums: digiTrack };
}
