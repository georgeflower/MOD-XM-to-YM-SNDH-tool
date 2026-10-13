/**
 * Pattern song -> maxYMiser (.MYS song + .MYV voice bank, or a single .MYI instrument).
 *
 * maxYMiser plays 3 YM tracks from 64-row patterns at 1 row = `speed` replay calls, replay rate 50..200 Hz.
 * That is the same timing model as this editor (one tick = 2.5/BPM s), so ticks map 1:1: TC = BPM x 0.4 Hz.
 *
 * An instrument becomes a bundle of per-tick sequences (volume, arpeggio, vibrato, mixer, noise, fixed pitch)
 * that maxYMiser steps once per replay call; ADSR / volume envelopes, arpeggio and pitch macros, built-in vibrato,
 * hardware-envelope (buzzer) and noise/tone choices and step-table instruments all have a direct counterpart.
 * Notes always carry their instrument column so the sequences restart on every note, as they do in this editor.
 *
 * Not exported (reported as warnings): ADSR release (a maxYMiser note-off cuts), volume slides, tremolo, global volume,
 * retrigger / note cut / delay, hardware-envelope period effects, timer effects Q/S/U, digidrums, tempo changes.
 */
import { type Song, type Instrument, type Cell, NOTE_OFF, EFFECT_LETTERS, channelsOf, drumChannelOf, VOICES, noteToFreq } from '../tracker/types';
import { renderSong, LINEAR_TO_YM_VOL, VIB_TABLE, freqToYmPeriod } from '../tracker/render';
import {
  INST, MYM_ROWS, MYM_MAX_PATTERNS, MYM_MAX_ORDERS, MYM_MAX_SEQUENCES, MYM_SEQ_WORDS, MYM_INSTRUMENTS,
  type MymCell, type MymSeq, type MymBank, type MymSong, emptyMymCell, isEmptyMymCell, newMymBank, newMymSong, encodeBank, encodeSong,
  encodeInstrument, emptySeq,
} from './format';

const FXI = (l: string) => EFFECT_LETTERS.indexOf(l) + 1;
const ch = (c: string) => c.charCodeAt(0);

/** maxYMiser note number of a tracker note (both are MIDI-like: the displayed name sounds an octave lower) */
export const mymNote = (n: number) => n + 11;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const u16 = (v: number) => v & 0xffff;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

export interface MymResult { mys: Uint8Array; myv: Uint8Array; warnings: string[]; stats: { patterns: number; orders: number; sequences: number; instruments: number } }

// ------------------------------------------------------------------ sequences

class SeqPool {
  seqs: MymSeq[] = [{ values: [0], length: 1, repeat: 0 }];     // id 0: reserved
  private map = new Map<string, number>();
  add(s: MymSeq): number {
    const key = `${s.length}/${s.repeat}/${s.values.slice(0, s.length).join(',')}`;
    const hit = this.map.get(key);
    if (hit !== undefined) return hit;
    if (this.seqs.length >= MYM_MAX_SEQUENCES) throw new Error('maxYMiser: more than 255 different sequences');
    this.seqs.push(s);
    this.map.set(key, this.seqs.length - 1);
    return this.seqs.length - 1;
  }
}

/** ADSR level (0..15, fractional) for every tick from the trigger until sustain is reached; the last value is held */
function adsrLevels(a: { attack: number; decay: number; sustain: number }): number[] {
  const out: number[] = [];
  let phase: 'a' | 'd' | 's', level: number, tick = 0;
  if (a.attack <= 0) { level = 15; phase = 'd'; if (a.decay <= 0) { level = a.sustain; phase = 's'; } } else { level = 0; phase = 'a'; }
  out.push(level);
  for (let guard = 0; guard < 600 && phase !== 's'; guard++) {
    if (phase === 'a') {
      tick++; level = Math.min(15, (tick / a.attack) * 15);
      if (tick >= a.attack) { level = 15; phase = 'd'; tick = 0; }
    } else if (a.decay <= 0) { level = a.sustain; phase = 's'; }
    else {
      tick++; level = 15 - (15 - a.sustain) * Math.min(1, tick / a.decay);
      if (tick >= a.decay) { level = a.sustain; phase = 's'; }
    }
    out.push(level);
  }
  return out;
}

const ymLevel = (env: number) => LINEAR_TO_YM_VOL[clamp(Math.round((clamp(env, 0, 15) / 15) * 64), 0, 64)];

/** vibrato offset (period units) after `t` ticks of a note started on a row boundary; the editor's phase does not advance on a row's first tick */
function vibOffset(t: number, speed: number, depth: number, rowTicks: number): number {
  const pos = speed * (t - Math.floor(t / Math.max(1, rowTicks)));
  return (VIB_TABLE[pos & 63] * depth) / 128;
}

/** one vibrato cycle as a sequence (value = what maxYMiser subtracts from the period) */
function vibratoSeq(speed: number, depth: number, rowTicks: number, step: number, base: (t: number) => number = () => 0): { seq: MymSeq; exact: boolean } {
  const adv = (rowTicks - 1) * speed;                              // phase advance per row (64 = one cycle)
  const m = adv > 0 ? 64 / gcd(64, adv % 64 || 64) : 1;
  const T = Math.max(1, m * rowTicks);                             // the phase pattern repeats exactly after T ticks
  const vals: number[] = [];
  if (Math.ceil(T / step) <= MYM_SEQ_WORDS && T % step === 0) {
    const L = T / step;
    for (let k = 0; k < L; k++) vals.push(u16(-Math.round(vibOffset(k * step, speed, depth, rowTicks) + base(k * step))));
    return { seq: { values: vals, length: L, repeat: 0 }, exact: true };
  }
  // otherwise one smooth cycle at the average rate (phase drifts a little against the editor's row-quantised vibrato)
  const P = adv > 0 ? (64 * rowTicks) / adv : T;
  const L = clamp(Math.round(P / step), 4, MYM_SEQ_WORDS);
  for (let k = 0; k < L; k++) vals.push(u16(-Math.round(((VIB_TABLE[Math.round((k * 64) / L) & 63] * depth) / 128) + base(k * step))));
  return { seq: { values: vals, length: L, repeat: 0 }, exact: false };
}

// ------------------------------------------------------------------ instruments

interface Compiled {
  name: string;
  rec: Uint8Array;                      // 64-byte instrument record (sequence ids filled in later)
  vol: MymSeq; arp: MymSeq | null; vib: MymSeq | null; mix: MymSeq; noise: MymSeq | null; fix: MymSeq | null;
  /** the same mixer with the buzzer switched on (for the X effect) */
  mixBuzz: MymSeq;
  step: number;
  vibDefault: { speed: number; depth: number };
  hard: boolean;
  /** step-table instrument: its volume steps ignore the volume column unless `velocity` */
  stepTable: boolean;
  /** volume column works in the log domain (step tables with `velocity`) */
  velocity: boolean;
  /** constant fractional-semitone tuning of a step table, applied per note as a fine detune */
  detune: number;
  ids?: { vol: number; arp: number; vib: number; mix: number; noise: number; fix: number; mixBuzz: number };
}

const MIX_TONE = 0x0100, MIX_NOISE = 0x1000, MIX_BUZZ = 0x0010;

function compileInstrument(inst: Instrument, opt: { rowTicks: number; step: number; warn: (k: string, m: string) => void; label: string }): Compiled {
  const { rowTicks, warn, label } = opt;
  let step = Math.max(1, opt.step);
  const rec = new Uint8Array(64);
  const nm = (inst.name || '').replace(/[^\x20-\x7e]/g, '?').slice(0, 15);
  for (let i = 0; i < nm.length; i++) rec[INST.name + i] = nm.charCodeAt(i);
  rec[INST.portaMask] = rec[INST.arpMask] = rec[INST.vibMask] = rec[INST.transMask] = 7;
  rec[INST.wave] = 14; rec[INST.sampleRate] = 0x20;

  const sampleAt = <T,>(f: (t: number) => T, n: number): T[] => Array.from({ length: n }, (_, k) => f(k * step));
  const periodic = (len: number) => Math.ceil(len / step);

  let arpRepeat = 0;
  let vol: number[], arp: number[] | null = null, vib: MymSeq | null = null, mixV: number[], noiseV: number[] | null = null;
  let volRepeat = -1;
  let fix: MymSeq | null = null;
  let hard = false;
  const vibDefault = { speed: 0, depth: 0 };
  let detune = 0;

  if (inst.seq) {
    const sq = inst.seq;
    const n = sq.steps.length;
    if (!n) { vol = [0]; mixV = [MIX_TONE]; }
    else {
      const total = sq.loopFrom >= 0 && sq.loopFrom < n ? n : n + 1;            // one-shot: a closing silent step
      const sp = Math.max(1, Math.ceil(total / MYM_SEQ_WORDS));
      if (sp > step) step = sp;
      const stepAt = (k: number) => { const t = k * step; return t < n ? sq.steps[t] : null; };
      const cnt = Math.min(MYM_SEQ_WORDS, Math.ceil(total / step));
      vol = []; mixV = []; noiseV = []; arp = [];
      // a constant tuning offset (fraction of a semitone) is applied per note; a varying one is rounded step by step
      const fr = sq.steps.map((x) => x.semi - Math.round(x.semi));
      const frs = fr.slice().sort((a, b) => a - b);
      const med = frs[frs.length >> 1];
      if (Math.abs(med) >= 0.02 && fr.every((x) => Math.abs(x - med) < 0.06)) detune = med;
      else if (fr.some((x) => Math.abs(x) >= 0.3)) warn('semifrac:' + label, `${label}: fractional semitone offsets in the step table are rounded`);
      for (let k = 0; k < cnt; k++) {
        const s = stepAt(k);
        vol.push(s ? clamp(Math.round(s.vol), 0, 15) : 0);
        mixV.push(s ? (s.tone ? MIX_TONE : 0) | (s.noise > 0 ? MIX_NOISE : 0) : MIX_TONE);
        noiseV.push(s && s.noise > 0 ? s.noise & 31 : 0);
        arp.push(s ? u16(Math.round(s.semi - detune)) : 0);
      }
      if (sq.loopFrom >= 0 && sq.loopFrom < n) volRepeat = Math.floor(sq.loopFrom / step);
      else volRepeat = cnt - 1;

      if (arp.every((x) => x === 0)) arp = null;
      if (noiseV.every((x) => x === 0)) noiseV = null;
      if (mixV.every((x) => x === mixV[0])) mixV = [mixV[0]];
    }
  } else {
    hard = inst.useHardEnv;
    // volume
    let env: number[];
    if (inst.adsr.useAdsr) {
      env = adsrLevels(inst.adsr);
    } else {
      env = inst.volEnv.length ? inst.volEnv.slice() : [15];
      const z = env.findIndex((e) => e <= 0);
      if (z >= 0) env = env.slice(0, z + 1);
    }
    const cnt = Math.min(MYM_SEQ_WORDS, Math.ceil(env.length / step));
    if (Math.ceil(env.length / step) > MYM_SEQ_WORDS) { /* step was chosen by the caller to fit; truncate otherwise */ warn('envlong:' + label, `${label}: the volume envelope is longer than a sequence; it is cut`); }
    vol = Array.from({ length: cnt }, (_, k) => {
      const e = env[Math.min(env.length - 1, k * step)];
      if (hard) return e > 0 && Math.round((e / 15) * 64) > 0 ? 15 : 0;
      return ymLevel(e);
    });
    volRepeat = cnt - 1;
    // arpeggio macro: one entry per tick, looped.  The editor reads the macro before it steps it, so entry 0 lasts two ticks.
    const macroSeq = (vals: number[], what: string): MymSeq => {
      const g = [vals[0], ...vals];
      const n = Math.min(MYM_SEQ_WORDS, Math.ceil(g.length / step));
      if (Math.ceil(g.length / step) > MYM_SEQ_WORDS) warn(what + 'long:' + label, `${label}: ${what} macro longer than ${MYM_SEQ_WORDS - 1} steps is cut`);
      return { values: Array.from({ length: n }, (_, k) => u16(g[Math.min(g.length - 1, k * step)])), length: n, repeat: g.length > 1 ? Math.min(n - 1, Math.ceil(1 / step)) : 0 };
    };
    if (inst.arpMacro.length > 1 || (inst.arpMacro.length === 1 && inst.arpMacro[0] !== 0)) {
      const a = macroSeq(inst.arpMacro, 'arpeggio');
      arp = a.values; arpRepeat = a.repeat;
    }
    // pitch macro and built-in vibrato (both add to the period)
    const macro = inst.pitchMacro;
    const hasMacro = macro.length > 1 || (macro.length === 1 && macro[0] !== 0);
    if (inst.vibratoDepth > 0 && inst.vibratoSpeed > 0) {
      vibDefault.speed = inst.vibratoSpeed; vibDefault.depth = inst.vibratoDepth;
      const base = hasMacro ? (t: number) => macro[t % macro.length] ?? 0 : undefined;
      // the editor adds the macro to the sine inside the same period offset
      const r = vibratoSeq(inst.vibratoSpeed, inst.vibratoDepth, rowTicks, step, base);
      vib = r.seq;
      if (!r.exact) warn('vibapprox:' + label, `${label}: vibrato cycle is longer than a sequence; approximated`);
      if (hasMacro && macro.length > 1) warn('vibmacro:' + label, `${label}: pitch macro together with vibrato is approximated`);
    } else if (hasMacro) {
      vib = macroSeq(macro.map((x) => -x), 'pitch');
    }
    // mixer / noise / buzzer
    let mix = 0;
    if (hard) {
      mix |= MIX_BUZZ;
      if (inst.syncBuzz && inst.toneEnabled) mix |= MIX_TONE;
    } else if (inst.toneEnabled) mix |= MIX_TONE;
    if (inst.noiseEnabled) { mix |= MIX_NOISE; noiseV = [inst.noisePeriod & 31]; }
    if (!mix) mix = MIX_TONE;          // all off would silence the voice anyway; keep the sequence valid
    mixV = [mix];
    if (hard) {
      rec[INST.wave] = inst.hardEnvShape & 15; rec[INST.sync] = 1;
      if (!inst.hardEnvAutoPeriod && inst.hardEnvPeriod) {
        rec[INST.fixMask] = 2;
        fix = { values: [u16(clamp(inst.hardEnvPeriod, 1, 65534))], length: 1, repeat: 0 };
      } else if ((inst.hardEnvDivisor || 1) > 1) {
        const k = Math.log2(inst.hardEnvDivisor);
        if (Number.isInteger(k) && k <= 5) { rec[INST.detuneMask] = 2; rec[INST.detuneCoarse] = (-12 * k) & 255; }
        else warn('envdiv:' + label, `${label}: hardware-envelope divisor ${inst.hardEnvDivisor} is not a power of two; exported as 1`);
      }
    }
  }
  rec[INST.seqSpeed] = step;
  if (detune) rec[INST.detuneMask] = 6;
  const mixSeq: MymSeq = { values: mixV, length: mixV.length, repeat: 0 };
  const mixBuzzVals = mixV.map((w) => (w & MIX_NOISE) | MIX_BUZZ | (inst.syncBuzz && inst.toneEnabled ? MIX_TONE : 0));
  return {
    name: nm, rec,
    vol: { values: vol, length: vol.length, repeat: clamp(volRepeat, 0, vol.length - 1) },
    arp: arp && { values: arp, length: arp.length, repeat: arpRepeat },
    vib, mix: mixSeq,
    noise: noiseV && { values: noiseV, length: noiseV.length, repeat: 0 },
    fix,
    mixBuzz: { values: mixBuzzVals, length: mixBuzzVals.length, repeat: 0 },
    step, vibDefault, hard, velocity: !!inst.seq?.velocity, stepTable: !!inst.seq, detune,
  };
}

function seqSpeedFor(inst: Instrument): number {
  // sequences hold at most 31 steps: a longer volume envelope is stretched by the instrument's sequence speed
  if (inst.seq) return 1;
  const envLen = inst.adsr.useAdsr ? adsrLevels(inst.adsr).length : inst.volEnv.length;
  return clamp(Math.ceil(envLen / MYM_SEQ_WORDS), 1, 8);
}

// ------------------------------------------------------------------ song

interface Eff { l: string; p: number; prio: number }
interface TrackState {
  inst: number;             // tracker instrument currently loaded (0 = none)
  vol: number;              // tracker volume 0..64
  mAtt: number;             // attenuation currently loaded in the maxYMiser voice
  active: boolean;          // a note is sounding
  arpOn: boolean;           // maxYMiser X effect is non-zero
  slideOn: boolean;         // maxYMiser H effect is non-zero
  portaSpeed: number;
  vibSpeed: number; vibDepth: number;
  vibKey: string;           // vibrato currently loaded: '' = the instrument's own
  lastNote: number;         // tracker note last triggered
  age: number;              // ticks since it was triggered
}

/** maxYMiser volume-column attenuation (YM steps) for a tracker volume 0..64 */
const attFor = (vol: number, velocity = false) => {
  if (vol >= 64) return 0;
  if (velocity) return vol <= 0 ? 15 : clamp(Math.round(-2 * Math.log2(vol / 64)), 0, 15);       // 3 dB per step, as the step tables do
  return 15 - LINEAR_TO_YM_VOL[clamp(vol, 0, 64)];
};

/**
 * What the editor does after a note-off, as a maxYMiser volume sequence.  maxYMiser cuts the voice on a note-off, so a
 * release is played by re-triggering the note with a copy of the instrument whose volume sequence is the fade.
 * 'cut' = plain note-off, 'ignore' = the editor keeps playing the envelope (no release table), else the fade.
 */
function releaseVolume(inst: Instrument, c: Compiled, age: number, vol: number): MymSeq | 'cut' | 'ignore' {
  const fin = (vals: number[]): MymSeq | 'cut' => {
    const v = vals.slice(0, MYM_SEQ_WORDS - 1);
    if (!v.length || v.every((x) => x === 0)) return 'cut';
    v.push(0);
    return { values: v, length: v.length, repeat: v.length - 1 };
  };
  const gate = (x: number) => (c.hard ? (x > 0 ? 15 : 0) : x);
  if (inst.seq) {
    const sq = inst.seq, n = sq.steps.length, R = sq.release;
    if (R <= 0 || !n) return 'cut';
    const stepAt = (i: number) => { if (i < n) return sq.steps[i]; if (sq.loopFrom < 0 || sq.loopFrom >= n) return null; return sq.steps[sq.loopFrom + ((i - sq.loopFrom) % (n - sq.loopFrom))]; };
    const out: number[] = [];
    for (let k = 0; k <= R - 2; k++) {
      const st = stepAt(age + k);
      if (!st) break;
      let lvl = st.vol;
      if (sq.velocity) lvl += vol > 0 ? 2 * Math.log2(vol / 64) : -99; else if (vol === 0) lvl = 0;
      const f = Math.max(0, 1 - (k + 2) / (R + 1));
      out.push(gate(clamp(Math.round(lvl * f), 0, 15)));
    }
    return fin(out);
  }
  if (inst.adsr.useAdsr) {
    const R = inst.adsr.release;
    if (R <= 0) return 'cut';
    const g = adsrLevels(inst.adsr);
    const start = g[clamp(age - 1, 0, g.length - 1)];
    const out: number[] = [];
    for (let k = 0; k <= R - 2; k++) out.push(gate(ymLevel(start * (1 - (k + 1) / R) * (vol / 64))));
    return fin(out);
  }
  if (!inst.volRelease.length) return 'ignore';
  const tail = inst.volRelease.length > 1 ? inst.volRelease.slice(1) : inst.volRelease;
  const out = tail.map((e) => gate(ymLevel(e * (vol / 64))));
  const z = out.findIndex((x) => x === 0);
  return fin(z >= 0 ? out.slice(0, z) : out.concat([]));
}

export function songToMaxymiser(song: Song): MymResult {
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (k: string, m: string) => { if (!warned.has(k)) { warned.add(k); warnings.push(m); } };
  const counts = new Map<string, number>();
  const unsup = (key: string, text: string) => counts.set(key + '\u0000' + text, (counts.get(key + '\u0000' + text) ?? 0) + 1);

  const drumCh = drumChannelOf(song);
  const toneChannels = drumCh >= 0 ? channelsOf(song) - 1 : channelsOf(song);
  const nCh = Math.min(VOICES, toneChannels);
  if (toneChannels > VOICES) warn('chips', `channels ${VOICES + 1}..${toneChannels} (second chip) are not exported`);
  if (drumCh >= 0) warn('drumch', 'the digidrum channel is not exported (maxYMiser samples are a different system)');

  const r = renderSong(song);           // the order the player really walks (jumps, breaks, loops) and the loop point
  if (!r.rows.length) throw new Error('maxYMiser: the song is empty');
  const bpm = song.bpm;
  const tc = clamp(Math.round(bpm * 0.4), 50, 200);
  if (Math.round(bpm * 0.4) < 50) warn('tc', `tempo ${bpm} BPM is below what maxYMiser can replay (50 Hz minimum): it plays faster`);
  if (Math.round(bpm * 0.4) > 200) warn('tc', `tempo ${bpm} BPM is above what maxYMiser can replay (200 Hz maximum): it plays slower`);

  // ---- segments: runs of consecutive rows of one pattern, at most 64 long
  interface Seg { order: number; start: number; len: number }
  const segs: Seg[] = [];
  let loopSeg = 0;
  for (const m of r.rows) {
    const last = segs[segs.length - 1];
    const boundary = r.loopFrame >= 0 && m.frame === r.loopFrame;
    if (last && !boundary && last.order === m.order && m.row === last.start + last.len && last.len < MYM_ROWS) last.len++;
    else { segs.push({ order: m.order, start: m.row, len: 1 }); if (boundary) loopSeg = segs.length - 1; }
  }
  if (r.loopFrame < 0) warn('noloop', 'the song ends; maxYMiser songs always repeat, so it loops from the start');
  if (segs.length > MYM_MAX_ORDERS) throw new Error(`maxYMiser: ${segs.length} song positions needed, at most ${MYM_MAX_ORDERS}`);

  // ---- which instruments are used (in order of first use) and which vibrato effects go with them
  const used: number[] = [];
  const vibsOf = new Map<number, Set<string>>();
  {
    const cur = new Array(VOICES).fill(0);
    const sp = new Array(VOICES).fill(0), dp = new Array(VOICES).fill(0);
    for (const s of segs) {
      const pat = song.patterns[song.order[s.order] ?? 0];
      for (let i = 0; i < s.len; i++) {
        const row = pat?.cells[s.start + i];
        if (!row) continue;
        for (let c = 0; c < nCh; c++) {
          const cell = row[c];
          if (cell.instrument && song.instruments[cell.instrument]) { cur[c] = cell.instrument; if (!used.includes(cell.instrument)) used.push(cell.instrument); }
          if (cell.note > 0 && cell.note !== NOTE_OFF) { sp[c] = 0; dp[c] = 0; }
          if (cell.effect === FXI('4') && cur[c]) {
            const x = (cell.param >> 4) & 15, y = cell.param & 15;
            if (x) sp[c] = x; if (y) dp[c] = y;
            let set = vibsOf.get(cur[c]); if (!set) vibsOf.set(cur[c], set = new Set());
            set.add(`${sp[c]}/${dp[c]}`);
          }
        }
      }
    }
  }
  if (used.length > MYM_INSTRUMENTS) {
    warn('inst32', `${used.length} instruments are used but a maxYMiser bank holds ${MYM_INSTRUMENTS}: the later ones are left out`);
    used.length = MYM_INSTRUMENTS;
  }

  const pool = new SeqPool();
  const bank: MymBank = newMymBank();
  const relIds = new Map<string, number>();
  let nextSlot = 0;
  const compiled = new Map<number, Compiled>();
  const mid = new Map<number, number>();
  const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  used.forEach((idx, k) => {
    const inst = song.instruments[idx];
    const label = `instrument ${hex2(idx)}${inst.name ? ` "${inst.name}"` : ''}`;
    const step = seqSpeedFor(inst);
    const c = compileInstrument(inst, { rowTicks: Math.max(1, song.speed), step, warn, label });
    if (inst.digiDrums?.length) warn('idrum:' + idx, `${label}: digidrums are not exported`);
    const ids = {
      vol: pool.add(c.vol), arp: c.arp ? pool.add(c.arp) : 0, vib: c.vib ? pool.add(c.vib) : 0, mix: pool.add(c.mix),
      noise: c.noise ? pool.add(c.noise) : 0, fix: c.fix ? pool.add(c.fix) : 0, mixBuzz: pool.add(c.mixBuzz),
    };
    c.ids = ids;
    c.rec[INST.volSeq] = ids.vol; c.rec[INST.arpSeq] = ids.arp; c.rec[INST.vibSeq] = ids.vib; c.rec[INST.mixSeq] = ids.mix;
    c.rec[INST.noiseSeq] = ids.noise; c.rec[INST.fixSeq] = ids.fix;
    bank.instruments[k].set(c.rec);
    compiled.set(idx, c);
    mid.set(idx, k + 1);
    nextSlot = k + 1;
  });

  // ---- vibrato effect sequences, made on demand
  const vibIds = new Map<string, number>();
  const vibFor = (speed: number, depth: number, step: number): number => {
    const key = `${speed}/${depth}/${step}`;
    let id = vibIds.get(key);
    if (id === undefined) {
      if (!speed || !depth) id = 0;
      else {
        const v = vibratoSeq(speed, depth, Math.max(1, rowTicksNow), step);
        if (!v.exact) warn('vibfx', 'a vibrato effect (4xy) has a cycle longer than a sequence: approximated');
        id = pool.add(v.seq);
      }
      vibIds.set(key, id);
    }
    return id;
  };

  // ---- pattern pass
  const L = (l: string) => FXI(l);
  const states: TrackState[] = Array.from({ length: VOICES }, () => ({ inst: 0, vol: 64, mAtt: 0, active: false, arpOn: false, slideOn: false, portaSpeed: 0, vibSpeed: 0, vibDepth: 0, vibKey: '', lastNote: 0, age: 0 }));
  let rowTicksNow = Math.max(1, song.speed);
  const patIds = new Map<string, number>();
  const patterns: MymCell[][] = [];
  const orders: number[][] = [];
  const idOf = (rows: MymCell[]): number => {
    if (rows.every(isEmptyMymCell)) return 0xff;
    const key = JSON.stringify(rows);
    let id = patIds.get(key);
    if (id === undefined) {
      if (patterns.length >= MYM_MAX_PATTERNS) throw new Error(`maxYMiser: more than ${MYM_MAX_PATTERNS} different patterns`);
      id = patterns.length; patterns.push(rows); patIds.set(key, id);
    }
    return id;
  };

  const unsupported = (cell: Cell) => {
    const e = cell.effect;
    const nm = EFFECT_LETTERS[e - 1];
    const p = `${nm}${hex2(cell.param)}`;
    switch (nm) {
      case '5': case '6': case 'A': unsup('volslide', 'volume slides (5xy 6xy Axy)'); break;
      case '7': unsup('tremolo', 'tremolo (7xy)'); break;
      case 'G': case 'H': unsup('gvol', 'global volume (Gxx Hxy)'); break;
      case 'L': case 'M': case 'P': case 'Y': unsup('hardenv', 'hardware-envelope effects (L M P Y)'); break;
      case 'R': unsup('retrig', 'retrigger (R)'); break;
      case 'Q': case 'S': case 'U': unsup('timerfx', 'timer effects (Q S U): use the SNDH / YM export for these'); break;
      case 'Z': unsup('digi', 'digidrums (Z)'); break;
      case 'E': {
        const sub = (cell.param >> 4) & 15;
        if (sub === 6) break;                                     // pattern loop: already unrolled by the player walk
        unsup('ext', 'extended effects (fine slides, retrigger, note cut / delay)'); break;
      }
      case 'B': case 'D': break;
      default: void p; break;
    }
  };

  const perTick = (p: number) => (rowTicksNow > 1 ? Math.max(1, Math.round((p * (rowTicksNow - 1)) / rowTicksNow)) : p);
  const mixOverride = (c: Compiled): number => c.ids!.mixBuzz;

  const speedCells: number[] = [];
  void speedCells;
  for (const seg of segs) {
    const pat = song.patterns[song.order[seg.order] ?? 0];
    const tracks: MymCell[][] = Array.from({ length: 3 }, () => Array.from({ length: MYM_ROWS }, emptyMymCell));
    for (let i = 0; i < seg.len; i++) {
      const rowCells = pat?.cells[seg.start + i];
      for (let c = 0; c < nCh; c++) {
        const st = states[c];
        const cell: Cell = rowCells?.[c] ?? { note: 0, instrument: 0, volume: 0, effect: 0, param: 0 };
        const out = tracks[c][i];
        const effs: Eff[] = [];
        const nmEff = cell.effect ? EFFECT_LETTERS[cell.effect - 1] : '';
        if (cell.effect) unsupported(cell);

        // --- instrument / volume bookkeeping, same order as the editor's triggerCell
        const isPorta = cell.effect === L('3');
        let note = cell.note;
        if (cell.effect === L('K') && note === 0) note = NOTE_OFF;           // key off
        if (cell.instrument && song.instruments[cell.instrument]) {
          st.inst = cell.instrument;
          if (note !== NOTE_OFF) st.vol = 64;
        }
        const portaNote = isPorta && st.active && note > 0 && note !== NOTE_OFF;
        let emitInst = false, relTrig = false;
        if (note === NOTE_OFF) {
          const cpo = st.inst ? compiled.get(st.inst) : undefined;
          let plain = true;
          if (st.active && cpo) {
            const rv = releaseVolume(song.instruments[st.inst], cpo, st.age, st.vol);
            if (rv === 'ignore') { plain = false; }
            else if (rv !== 'cut') {
              const key = `${st.inst}:${rv.values.join(',')}`;
              let rid = relIds.get(key);
              if (rid === undefined) {
                if (nextSlot < MYM_INSTRUMENTS) {
                  const rec = cpo.rec.slice();
                  rec[INST.volSeq] = pool.add(rv);
                  bank.instruments[nextSlot].set(rec);
                  rid = ++nextSlot;
                } else { rid = 0; warn('relslots', 'not enough instrument slots for every release fade: some note-offs cut instead'); }
                relIds.set(key, rid);
              }
              if (rid) { out.note = mymNote(st.lastNote); out.inst = rid; plain = false; relTrig = true; }
            }
          }
          if (plain) out.note = 1;
          st.active = false; st.arpOn = false; st.slideOn = false; st.vibKey = '';
          st.mAtt = 0;
        } else if (note > 0) {
          out.note = mymNote(note);
          if (!portaNote) {
            if (st.inst && mid.has(st.inst)) { emitInst = true; out.inst = mid.get(st.inst)!; st.active = true; }
            else { out.note = 0; if (st.inst) unsup('noinst', 'notes of instruments beyond the 32 a bank holds'); else unsup('noinst0', 'notes before any instrument is chosen'); }
            if (emitInst) {
              st.lastNote = note; st.age = 0;
              st.mAtt = 0; st.arpOn = false; st.slideOn = false; st.vibKey = '';
              const cp = compiled.get(st.inst)!;
              st.vibSpeed = cp.vibDefault.speed; st.vibDepth = cp.vibDefault.depth;
            }
          }
        } else if (cell.instrument && mid.has(cell.instrument)) {
          // instrument without a note: the editor keeps sounding, only the volume resets
        }
        if (cell.volume >= 0x10 && cell.volume <= 0x50) st.vol = cell.volume - 0x10;
        if (nmEff === 'C') st.vol = clamp(cell.param, 0, 64);

        // --- effects
        const cp = st.inst ? compiled.get(st.inst) : undefined;
        const hardInst = !!cp?.hard;
        const arpRow = nmEff === '0' && cell.param !== 0;
        if (arpRow) {
          effs.push({ l: 'X', p: cell.param, prio: 5 }); st.arpOn = true;
          if (song.instruments[st.inst]?.arpSpeed > 1) unsup('arpspeed', 'instrument arpeggio speed > 1 for the 0xy effect');
        } else if (st.arpOn && !emitInst) { effs.push({ l: 'X', p: 0, prio: 5 }); st.arpOn = false; }
        const slideUp = nmEff === '1', slideDn = nmEff === '2';
        if ((slideUp || slideDn) && cell.param) {
          // the editor slides on every tick but the first of a row, maxYMiser on every tick: scale to the same distance per row
          const p = perTick(cell.param);
          if (p > 127) unsup('slide', 'pitch slides faster than 127 period units per tick');
          effs.push({ l: 'H', p: slideUp ? Math.min(127, p) : (256 - Math.min(128, p)) & 255, prio: 6 }); st.slideOn = true;
        } else if (st.slideOn && !emitInst && !(slideUp || slideDn)) { effs.push({ l: 'H', p: 0, prio: 6 }); st.slideOn = false; }
        if (nmEff === '3') {
          const p = cell.param || st.portaSpeed;
          if (cell.param) st.portaSpeed = cell.param;
          if (p && (portaNote || cell.param)) effs.push({ l: 'P', p: Math.min(255, perTick(p)), prio: 6 });
        }
        if (nmEff === '4') {
          const x = (cell.param >> 4) & 15, y = cell.param & 15;
          if (x) st.vibSpeed = x; if (y) st.vibDepth = y;
          const stepNow = cp?.step ?? 1;
          const key = `${st.vibSpeed}/${st.vibDepth}`;
          const ownKey = cp ? `${cp.vibDefault.speed}/${cp.vibDefault.depth}` : '0/0';
          if (key !== (st.vibKey || ownKey)) {
            if (key === ownKey) effs.push({ l: 'V', p: cp?.ids?.vib ?? 0, prio: 4 });
            else effs.push({ l: 'V', p: vibFor(st.vibSpeed, st.vibDepth, stepNow), prio: 4 });
            st.vibKey = key === ownKey ? '' : key;
          }
        }
        if (nmEff === 'X') {
          // force the hardware envelope (buzzer) with this shape
          if (cp && !hardInst) { effs.push({ l: 'M', p: mixOverride(cp), prio: 3 }); effs.push({ l: 'W', p: cell.param & 15, prio: 3 }); }
          else if (cp) effs.push({ l: 'W', p: cell.param & 15, prio: 3 });
        }
        if (nmEff === 'F') {
          if (cell.param > 0 && cell.param < 0x20) { effs.push({ l: 'S', p: cell.param, prio: 1 }); rowTicksNow = cell.param; }
          else if (cell.param >= 0x20) unsup('tempo', 'tempo changes (Fxx >= 20): maxYMiser has one replay rate for the whole song');
        }
        if ((emitInst || relTrig) && cp && cp.detune) {
          const per = freqToYmPeriod(noteToFreq(relTrig ? st.lastNote : note));
          const fine = clamp(Math.round(per * (1 - Math.pow(2, -cp.detune / 12))), -128, 127);
          if (fine) effs.push({ l: 'E', p: fine & 255, prio: 9 });
        }
        // --- volume column
        if (cp && (note !== NOTE_OFF) && (st.active || emitInst)) {
          let want = attFor(st.vol, cp.velocity);
          if (!cp.velocity && cp.stepTable) want = st.vol === 0 ? 15 : 0;
          if (hardInst && st.vol > 0) want = Math.min(want, 14);
          if (want !== st.mAtt) { out.vol = 0x10 | want; st.mAtt = want; }
        }
        // --- last row of a short segment: pattern break goes on track 0 (handled below)
        // --- fill the two effect slots by priority
        effs.sort((a, b) => a.prio - b.prio);
        const kept = effs.slice(0, 2);
        if (effs.length > 2) unsup('slots', 'cells with more effects than a maxYMiser cell holds (two): extra ones are dropped');
        if (kept[0]) { out.fx1 = ch(kept[0].l); out.p1 = kept[0].p & 255; }
        if (kept[1]) { out.fx2 = ch(kept[1].l); out.p2 = kept[1].p & 255; }
      }
      for (const st of states) st.age += rowTicksNow;
    }
    if (seg.len < MYM_ROWS) {
      const t0 = tracks[0][seg.len - 1];
      if (!t0.fx1) { t0.fx1 = ch('B'); t0.p1 = 0; }
      else if (!t0.fx2) { t0.fx2 = ch('B'); t0.p2 = 0; }
      else {
        // free a slot on the other tracks
        let placed = false;
        for (let t = 1; t < 3 && !placed; t++) { const x = tracks[t][seg.len - 1]; if (!x.fx1) { x.fx1 = ch('B'); placed = true; } else if (!x.fx2) { x.fx2 = ch('B'); placed = true; } }
        if (!placed) { t0.fx2 = ch('B'); t0.p2 = 0; unsup('slots', 'cells with more effects than a maxYMiser cell holds (two): extra ones are dropped'); }
      }
    }
    orders.push([idOf(tracks[0]), idOf(tracks[1]), idOf(tracks[2]), 0xff]);
  }

  // ---- assemble
  bank.sequences = pool.seqs;
  const ms: MymSong = newMymSong();
  ms.state.set([0, 5, 0, 0, 0, 1, 2, 0, 1, 0, 255, 255, 3, 6, 50, 4, 1, 0, 7, 7, 0, 0, 0, 7, 0, 0, 0, 0, 18, 1, 0, 0, 1, 1, 1, 1, 7, 0, 0, 0, 0, 0, 0, 0, 6, 6, 6, 4, 0, 0, 1, 0, 0, 1, 2, 0], 0);
  ms.state[13] = clamp(song.speed, 2, 255);
  ms.state[14] = tc;
  ms.patterns = patterns;
  ms.orders = orders;
  ms.length = orders.length;
  ms.repeat = clamp(loopSeg, 0, orders.length - 1);
  if (!used.length) warn('noinst', 'the song uses no instruments');

  for (const [k, n] of counts) { const [, text] = k.split('\u0000'); warn('u:' + k, `not exported: ${text}${n > 1 ? ` (${n}×)` : ''}`); }

  return {
    mys: encodeSong(ms), myv: encodeBank(bank), warnings,
    stats: { patterns: patterns.length, orders: orders.length, sequences: pool.seqs.length - 1, instruments: used.length },
  };
}

/** one tracker instrument as a stand-alone maxYMiser .MYI file */
export function instrumentToMyi(inst: Instrument, speed = 6): { data: Uint8Array; warnings: string[] } {
  const warnings: string[] = [];
  const warned = new Set<string>();
  const c = compileInstrument(inst, { rowTicks: speed, step: seqSpeedFor(inst), warn: (k, m) => { if (!warned.has(k)) { warned.add(k); warnings.push(m); } }, label: inst.name || 'instrument' });
  const one = (s: MymSeq | null): MymSeq => s ?? { values: [0], length: 1, repeat: 0 };
  const tim = emptySeq(); tim.values = [0]; tim.length = 1;
  if (inst.digiDrums?.length) warnings.push('digidrums are not exported');
  return { data: encodeInstrument({ version: 0, inst: c.rec, sequences: [c.vol, one(c.arp), one(c.vib), c.mix, one(c.noise), one(c.fix), tim] }), warnings };
}
