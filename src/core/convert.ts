/**
 * Module -> YM2149 register stream. Replays the module, turns every sounding channel into an
 * AY event (tone period + level, or a drum macro), then picks the best 3 events per frame.
 */
import type { Module } from './types';
import { replay, FPS, type ChanState } from './replay';
import { analyseSample, fold, ended, type SampleInfo } from './samples';
import { powerSpectrum } from './fft';

export const YM_CLOCK = 2_000_000;
export const TONE_HZ = YM_CLOCK / 16.0; // period 1 -> 125 kHz
export const NREGS = 14;

export type DrumKind = 'kick' | 'hat' | 'snare';

export interface ConvertOptions {
  /** extra allocation priority per 0-based source channel */
  prio?: Record<number, number>;
  /** force a drum macro for an instrument number */
  drumClass?: Record<number, DrumKind>;
  /** override the detected cycle length (samples) of an instrument's first sample */
  cycle?: Record<number, number>;
  drumBonus?: number;
  drumGain?: number;
  gainDb?: number;
  sticky?: number;
  refPercentile?: number;
  arpOrder?: 'xy' | 'yx';
  loopOrder?: number;
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
}

function drumMacro(kind: DrumKind, age: number, base: number): Omit<Cand, 'ch' | 'inst' | 'drum'> | null {
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

export interface InstrumentReport {
  inst: number;
  name: string;
  cls: SampleInfo['cls'];
  /** pitch of C-4 (XM) / PT C-2 for this instrument in Hz, tonal only */
  c4Hz?: number;
  drum?: DrumKind;
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
  warnings: string[];
}

export function convert(m: Module, options: ConvertOptions = {}): ConvertResult {
  const o = { ...DEFAULTS, ...options };
  const prio = options.prio ?? {};
  const report: string[] = [];
  const log = (s: string) => report.push(s);

  log(`'${m.title}': ${m.kind.toUpperCase()}, ${m.nch} channels, ${m.patterns.length} patterns, order length ${m.order.length}, speed ${m.speed}, BPM ${m.bpm}`);

  // ---- instrument analysis
  const info = new Map<string, SampleInfo>();
  const instReports: InstrumentReport[] = [];
  m.instruments.forEach((ins, i) => {
    if (!ins) return;
    ins.samples.forEach((s, k) => info.set(`${i}:${k}`, analyseSample(s, k === 0 ? options.cycle?.[i] : undefined)));
    const a = info.get(`${i}:0`);
    if (a && a.cls !== 'empty') {
      const r: InstrumentReport = { inst: i, name: ins.name, cls: a.cls };
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
  for (const snap of rep.frames) {
    const lst: Cand[] = [];
    snap.forEach((st: ChanState | null, ci) => {
      if (!st || st.vol <= 0) return;
      const inf = info.get(`${st.inst}:${st.ksmp}`);
      if (!inf || inf.cls === 'empty') return;
      const s = st.smp;
      if (inf.cls === 'tonal') {
        if (ended(s, st.pos)) return;
        const n = Math.max(4, Math.trunc(st.rate * dt));
        const w = fold(s, st.pos, st.pos + n);
        if (!w.length) return;
        let sum = 0;
        for (let i = 0; i < w.length; i++) sum += w[i] * w[i];
        const rms = Math.sqrt(sum / w.length);
        const hz = st.rate / inf.cycle!;
        lst.push({ ch: ci, kind: 'tone', per: TONE_HZ / hz, np: null, lvl: rms * st.vol, inst: st.inst });
      } else {
        const key = `${st.inst}:${st.ksmp}`;
        let bc = drumCache.get(key);
        if (!bc) {
          const d = s.data;
          const rateC5 = (m.amiga ? 3546894.6 / 428 * 2 : 8363 * Math.pow(2, (s.rel * 128 + s.fine) / (12 * 128)) * 2);
          const win = new Float64Array(d.length);
          for (let i = 0; i < d.length; i++) win[i] = d[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, d.length - 1)));
          const { power, size } = powerSpectrum(win);
          let num = 0, den = 0;
          for (let k = 0; k < power.length; k++) { num += power[k] * ((k * rateC5) / size); den += power[k]; }
          const cen = num / Math.max(den, 1e-12);
          const durTicks = d.length / rateC5 / dt;
          const over = options.drumClass?.[st.inst];
          const kind: DrumKind = over ?? (inf.cls === 'kick' || cen < 400 ? 'kick' : durTicks <= 2.0 ? 'hat' : 'snare');
          let sq = 0;
          for (let i = 0; i < d.length; i++) sq += d[i] * d[i];
          bc = { kind, rms: Math.sqrt(sq / d.length) };
          drumCache.set(key, bc);
          const ir = instReports.find((r) => r.inst === st.inst);
          if (ir) ir.drum = kind;
        }
        const mac = drumMacro(bc.kind, st.age, bc.rms * st.vol * o.drumGain);
        if (mac) lst.push({ ...mac, ch: ci, inst: st.inst, drum: bc.kind });
      }
    });
    cand.push(lst);
  }

  // ---- allocation
  const tl: number[] = [];
  for (const fr of cand) for (const c of fr) if (c.kind === 'tone' && !c.drum) tl.push(c.lvl);
  const ref = tl.length ? percentile(tl, o.refPercentile) : 1;
  const ayVol = (lvl: number) => {
    if (lvl <= 0) return 0;
    const v = 15 + 2.0 * Math.log2(lvl / ref) + o.gainDb / 3.0103;
    return Math.max(0, Math.min(15, pyRound(v)));
  };
  const NV = 3;
  const imp = new Map<number, number>();
  for (const fr of cand) for (const c of fr) imp.set(c.ch, (imp.get(c.ch) ?? 0) + (c.drum ? 0 : ayVol(c.lvl)));
  const rank = new Map<number, number>();
  for (const [ch, v] of imp) rank.set(ch, -v - 1000.0 * (prio[ch] ?? 0));
  let slots: (number | null)[] = [null, null, null];
  const alloc: ({ v: number; c: Cand } | null)[][] = [];
  const played = new Array(m.nch).fill(0), dropped = new Array(m.nch).fill(0);
  for (const fr of cand) {
    const scored: { score: number; v: number; c: Cand }[] = [];
    for (const c of fr) {
      const v = ayVol(c.lvl);
      if (v <= 0) continue;
      let score = v + (prio[c.ch] ?? 0);
      if (c.drum) score += o.drumBonus;
      if (slots.includes(c.ch)) score += o.sticky;
      scored.push({ score, v, c });
    }
    scored.sort((a, b) => b.score - a.score);
    const chosen: { v: number; c: Cand }[] = [];
    let noiseTaken = false;
    for (const { v, c } of scored) {
      if (chosen.length === NV) { dropped[c.ch]++; continue; }
      if (c.kind === 'noise') {
        if (noiseTaken) { dropped[c.ch]++; continue; }
        noiseTaken = true;
      }
      chosen.push({ v, c });
      played[c.ch]++;
    }
    const nw: ({ v: number; c: Cand } | null)[] = [null, null, null];
    const rest: { v: number; c: Cand }[] = [];
    for (const it of chosen) {
      const si = slots.indexOf(it.c.ch);
      if (si >= 0 && nw[si] === null) nw[si] = it; else rest.push(it);
    }
    rest.sort((a, b) => (Number(!!a.c.drum) - Number(!!b.c.drum)) || ((rank.get(a.c.ch) ?? 0) - (rank.get(b.c.ch) ?? 0)));
    for (const it of rest) {
      const order = it.c.drum ? [2, 1, 0] : [0, 1, 2];
      for (const i of order) if (nw[i] === null) { nw[i] = it; break; }
    }
    slots = nw.map((it) => (it ? it.c.ch : null));
    alloc.push(nw);
  }

  // ---- registers
  const regs = new Uint8Array(nf * NREGS);
  const prevPer = [1000, 1000, 1000];
  let prevNp = 8;
  let prevMix = [0, 0, 0];
  let octShift = 0;
  for (let f = 0; f < nf; f++) {
    const vols = [0, 0, 0];
    const mixbits = [...prevMix];
    let npv = prevNp;
    alloc[f].forEach((it, i) => {
      if (!it) return;
      const { v, c } = it;
      vols[i] = v;
      if (c.kind === 'tone') {
        let per = c.per!;
        while (per > 4095) { per /= 2.0; octShift++; }
        while (per < 1.0) per *= 2.0;
        per = Math.max(1, Math.min(4095, pyRound(per)));
        prevPer[i] = per;
        mixbits[i] = 1;
      } else {
        npv = c.np!;
        mixbits[i] = 2;
      }
    });
    prevNp = npv;
    prevMix = mixbits;
    let mix = 0xc0;
    for (let i = 0; i < 3; i++) {
      if (mixbits[i] !== 1) mix |= 1 << i;
      if (mixbits[i] !== 2) mix |= 8 << i;
    }
    const b = f * NREGS;
    for (let i = 0; i < 3; i++) { regs[b + 2 * i] = prevPer[i] & 0xff; regs[b + 2 * i + 1] = prevPer[i] >> 8; }
    regs[b + 6] = prevNp; regs[b + 7] = mix;
    regs[b + 8] = vols[0]; regs[b + 9] = vols[1]; regs[b + 10] = vols[2];
  }

  log(`loudness reference (tonal p${o.refPercentile}) = ${ref.toFixed(3)} -> AY volume 15`);
  log('channel   voice-frames   dropped');
  for (let c = 0; c < m.nch; c++) {
    if (played[c] + dropped[c] === 0) continue;
    log(`  ch${String(c + 1).padStart(2, '0')}  ${String(played[c]).padStart(10)}  ${String(dropped[c]).padStart(8)}  ${((100 * dropped[c]) / Math.max(1, played[c] + dropped[c])).toFixed(1)}%`);
  }
  if (octShift) log(`${octShift} events needed an octave shift (period > 4095)`);

  return { regs, nframes: nf, loopFrame, report, instruments: instReports, played, dropped, warnings };
}
