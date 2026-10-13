/**
 * Instrument baking shared by the exporters for other trackers (Arkos Tracker .aks, Furnace .fur): an editor instrument
 * (ADSR / volume envelope, arpeggio and pitch macros, built-in vibrato, or a step table) becomes a list of per-tick values
 * that the target tracker's own instrument format can hold. Everything is "per 20 ms tick" like the editor's own renderer.
 */
import type { Instrument } from '../tracker/types';
import { LINEAR_TO_YM_VOL, VIB_TABLE } from '../tracker/render';

export const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
export const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;
export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** editor track volume 0..64 -> YM step 0..15 (3 dB per step, log domain) */
export const logVol = (v64: number) => (v64 <= 0 ? 0 : clamp(15 + Math.round(2 * Math.log2(v64 / 64)), 0, 15));

/** one baked tick of an instrument */
export interface Tk {
  /** YM volume step 0..15 (at full track volume) */
  vol: number;
  /** noise period 1..31, 0 = no noise */
  noise: number;
  tone: boolean;
  /** whole semitones above the note */
  semi: number;
  /** what the whole semitones leave out (step tables only): the tick sounds `semi + frac` semitones above the note */
  frac: number;
  /** period units added to the tone period (vibrato + pitch macro; positive lowers the pitch) */
  pitch: number;
}

export interface Baked {
  ticks: Tk[];
  /** tick the instrument loops back to; -1 = holds its last tick (or ends, when `looping` is false) */
  loopStart: number;
  /** false: a one-shot step table (silent after its last step) */
  looping: boolean;
  /** hardware envelope (buzzer) instrument */
  hard: boolean;
  /** volume steps after a note-off (YM steps, ending in 0); empty = the sound stops at once */
  release: number[];
}

/** ADSR level (0..15, fractional) per tick until sustain; the last value is held (same shape as the editor's) */
export function adsrLevels(a: { attack: number; decay: number; sustain: number }): number[] {
  const out: number[] = [];
  let phase: 'a' | 'd' | 's', level: number, tick = 0;
  if (a.attack <= 0) { level = 15; phase = 'd'; if (a.decay <= 0) { level = a.sustain; phase = 's'; } } else { level = 0; phase = 'a'; }
  out.push(level);
  for (let guard = 0; guard < 600 && phase !== 's'; guard++) {
    if (phase === 'a') { tick++; level = Math.min(15, (tick / a.attack) * 15); if (tick >= a.attack) { level = 15; phase = 'd'; tick = 0; } }
    else if (a.decay <= 0) { level = a.sustain; phase = 's'; }
    else { tick++; level = 15 - (15 - a.sustain) * Math.min(1, tick / a.decay); if (tick >= a.decay) { level = a.sustain; phase = 's'; } }
    out.push(level);
  }
  return out;
}

/** the YM volume step the editor plays for an envelope level 0..15 at full track volume */
export const ymLevel = (env: number) => LINEAR_TO_YM_VOL[clamp(Math.round((clamp(env, 0, 15) / 15) * 64), 0, 64)];

/**
 * Bake an instrument. `maxTicks` is the longest instrument the target holds; `target` names it in the warnings.
 * Release tails are returned in `release` (the exporter decides whether the target can play them).
 * `rowTicks` (the song's ticks per row) lets the built-in vibrato follow the editor exactly: its phase does not advance on a
 * row's first tick, so a time-linear table only matches when the row length is known (0 = ignore that).
 */
export function bakeInstrument(
  inst: Instrument, label: string, warn: (k: string, m: string) => void, maxTicks: number, target: string,
  pitchUnit = 'period units', warnFrac = true, rowTicks = 0,
): Baked {
  const ticks: Tk[] = [];
  let loopStart = -1;
  let looping = true;
  const hard = inst.useHardEnv;
  let release: number[] = [];

  if (inst.seq) {
    const sq = inst.seq, n = sq.steps.length || 1;
    const steps = sq.steps.length ? sq.steps : [{ vol: 0, semi: 0, noise: 0, tone: true }];
    let frac = false;
    for (const s of steps) if (Math.abs(s.semi - Math.round(s.semi)) > 0.05) frac = true;
    if (frac && warnFrac) warn('frac:' + label, `${label}: fractional semitone offsets are rounded (${target} pitch is in ${pitchUnit})`);
    for (let t = 0; t < Math.min(n, maxTicks); t++) {
      const s = steps[t];
      ticks.push({ vol: clamp(Math.round(s.vol), 0, 15), noise: s.noise > 0 ? s.noise & 31 : 0, tone: s.tone, semi: Math.round(s.semi), frac: s.semi - Math.round(s.semi), pitch: 0 });
    }
    if (n > maxTicks) warn('long:' + label, `${label}: the step table is cut to ${maxTicks} steps`);
    if (sq.loopFrom >= 0 && sq.loopFrom < ticks.length) loopStart = sq.loopFrom; else looping = false;
    if (sq.release > 0) {
      // the renderer has already counted one release tick when it first plays the tail: the held step is scaled by
      // (1 - (k + 1) / (rel + 1)) for k = 1 .. rel - 1, then the sound stops
      const held = ticks[ticks.length - 1]?.vol ?? 0;
      for (let k = 1; k < sq.release; k++) release.push(clamp(Math.round(held * Math.max(0, 1 - (k + 1) / (sq.release + 1))), 0, 15));
      release.push(0);
    }
  } else {
    const env = inst.adsr.useAdsr ? adsrLevels(inst.adsr) : (inst.volEnv.length ? inst.volEnv.slice() : [15]);
    let L0 = env.length;
    const z = inst.adsr.useAdsr ? -1 : env.findIndex((e) => e <= 0);
    if (z >= 0) L0 = z + 1;
    const arp = inst.arpMacro.length > 1 || (inst.arpMacro.length === 1 && inst.arpMacro[0] !== 0) ? inst.arpMacro : [0];
    const pit = inst.pitchMacro.length > 1 || (inst.pitchMacro.length === 1 && inst.pitchMacro[0] !== 0) ? inst.pitchMacro : [0];
    const vib = inst.vibratoDepth > 0 && inst.vibratoSpeed > 0;
    const spd = rowTicks > 0 ? rowTicks : 0;
    // the phase advances on every tick but the first of each row: one row moves it by speed * (rowTicks - 1)
    const vibCycle = !vib ? 1 : spd ? (64 / gcd(64, (inst.vibratoSpeed * (spd - 1)) % 64 || 64)) * spd : 64 / gcd(64, inst.vibratoSpeed);
    const vibIdx = (t: number) => (spd ? t - Math.ceil(t / spd) : Math.max(0, t - 1));
    let P = lcm(lcm(arp.length, pit.length), vibCycle);
    if (inst.arpSpeed > 1 && arp.length > 1) warn('arpspeed:' + label, `${label}: arpeggio speed > 1 is played at speed 1`);
    if (L0 + P > maxTicks) { warn('cycle:' + label, `${label}: arpeggio / pitch / vibrato cycle is longer than a ${target} instrument; cut`); P = Math.max(1, maxTicks - L0); }
    const periodic = P > 1;
    const total = periodic ? L0 + P : L0;
    if (total > maxTicks) warn('envlong:' + label, `${label}: the volume envelope is longer than ${maxTicks} ticks; cut`);
    const toneOn = hard ? inst.syncBuzz && inst.toneEnabled : inst.toneEnabled;
    for (let t = 0; t < Math.min(total, maxTicks); t++) {
      const e = env[Math.min(t, env.length - 1)];
      const past = inst.adsr.useAdsr ? false : z >= 0 && t >= L0;
      let vol = past ? 0 : ymLevel(e);
      if (hard) vol = vol > 0 ? 15 : 0;
      const ti = Math.max(0, t - 1);                               // the renderer holds the macro position on the trigger tick
      const off = (arp[ti % arp.length] ?? 0);
      const offP = (pit[ti % pit.length] ?? 0) + (vib ? Math.round(VIB_TABLE[(vibIdx(t) * inst.vibratoSpeed) & 63] * inst.vibratoDepth / 128) : 0);
      ticks.push({ vol, noise: inst.noiseEnabled ? Math.max(1, inst.noisePeriod & 31) : 0, tone: toneOn, semi: off, frac: 0, pitch: offP });
    }
    loopStart = periodic ? L0 : -1;
    // the editor has counted one release tick when it first reads the table, and holds the table's last value (a table that
    // should end the sound ends in 0)
    if (inst.volRelease.length) release = (inst.volRelease.length > 1 ? inst.volRelease.slice(1) : inst.volRelease).map((v) => (hard ? (v > 0 ? 15 : 0) : ymLevel(v)));
    else if (inst.adsr.useAdsr && inst.adsr.release > 0) {
      const s = inst.adsr.sustain, r = inst.adsr.release;
      for (let k = 1; k < r; k++) { const v = ymLevel(s * (1 - k / r)); release.push(hard ? (v > 0 ? 15 : 0) : v); }
      release.push(0);
    }
  }
  return { ticks, loopStart, looping, hard, release };
}
