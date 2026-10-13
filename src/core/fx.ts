/**
 * Timer effects (YM6 / YM Tracker Q, S, U): a voice's volume (or the hardware envelope) is driven by an MFP timer
 * interrupt at a few hundred Hz .. kHz, i.e. much faster than the 50 Hz frame dump can say.
 *
 *   Q  SID voice     every timer tick the voice volume toggles between its register value and 0
 *   S  sinus-SID     like SID, but the "on" half is a (rectified) sine, 32 steps per timer period
 *   U  sync-buzzer   every timer tick the envelope shape register is rewritten (restarts the envelope)
 *
 * Parameter xx: high nibble = pitch step, low nibble = octave, timer Hz = 20 * 2^(octave + pitch/16); 00 = off.
 * The ST has one MFP timer to spare for this (Timer A), so one effect runs at a time.
 *
 * Like digidrums they travel as a side track: one packed state per 50 Hz frame (0 = none).
 */
import { MFP_CLOCK, MFP_PREDIV } from './drums';

export const FX_SID = 1, FX_SINUS = 2, FX_SYNC = 3;
export type FxKind = 1 | 2 | 3;
export const FX_NAMES = ['', 'SID voice', 'sinus-SID', 'sync-buzzer'] as const;
export const FX_LETTERS = ['', 'Q', 'S', 'U'] as const;

/** fastest interrupt rate the engine is meant to sustain (the ISRs take ~100-150 cycles each) */
export const MAX_FX_HZ = 20_000;
/** slowest MFP timer rate: 2457600 / (200 * 255) */
export const MIN_FX_HZ = MFP_CLOCK / (200 * 255);
/** the sinus table has 32 steps per timer period of the Q-style toggle, so its interrupt runs 32x faster */
export const SINUS_STEPS = 32;

/** rectified sine, 32 steps, 0..15 (the "on" half-period of the sinus-SID); the next 32 steps are silent */
export const SIN32: readonly number[] = Array.from({ length: 32 }, (_, i) => Math.max(0, Math.min(15, Math.round(Math.max(0, Math.sin((i / 32) * Math.PI * 2)) * 15))));

/** sinus-SID level for table position 0..63 and voice volume 0..15 (what the 68000 ISR computes) */
export function sinusLevel(pos: number, vol: number): number {
  const t = pos & 63;
  return t < 32 ? (SIN32[t] * vol * 17 + 128) >> 8 : 0;
}
/** the volume an effect modulates: the register value, or full level when the voice runs on the hardware envelope */
export const fxVoiceVol = (volReg: number) => (volReg & 16 ? 15 : volReg & 15);

export interface FxRate { code: number; count: number; hz: number }
/** nearest MFP rate (prescaler code 1..7, data 1..255) for a target interrupt rate */
export function fxRate(target: number): FxRate {
  const t = Math.max(MIN_FX_HZ, Math.min(MAX_FX_HZ, target));
  let best: FxRate = { code: 7, count: 255, hz: MIN_FX_HZ }, bestErr = Infinity;
  for (let code = 1; code <= 7; code++) {
    const div = MFP_PREDIV[code];
    const count = Math.max(1, Math.min(255, Math.round(MFP_CLOCK / (div * t))));
    const hz = MFP_CLOCK / (div * count);
    const err = Math.abs(Math.log(hz / t));
    if (err < bestErr - 1e-12) { bestErr = err; best = { code, count, hz }; }
  }
  return best;
}

/** timer Hz asked for by a Q/S/U parameter (YM Tracker mapping); 0 for 00 (= off) */
export function fxParamHz(p: number): number {
  p &= 255;
  if (!p) return 0;
  return 20 * Math.pow(2, (p & 15) + ((p >> 4) & 15) / 16);
}

export interface FxSetting {
  kind: FxKind;
  voice: number;
  /** MFP prescaler code + data register of the interrupt (for sinus-SID that is 32x the musical timer rate) */
  code: number;
  count: number;
  /** the musical timer rate that really plays (Hz), after quantising / clamping */
  hz: number;
  /** the requested rate could not be reached */
  clamped: boolean;
}
/** Q/S/U + parameter on a voice -> what the engine is told */
export function fxSetting(kind: FxKind, voice: number, param: number): FxSetting | null {
  return fxSettingHz(kind, voice, fxParamHz(param));
}
/** same, from the wanted musical timer rate in Hz (0 = none) */
export function fxSettingHz(kind: FxKind, voice: number, want: number): FxSetting | null {
  if (!(want > 0)) return null;
  const mult = kind === FX_SINUS ? SINUS_STEPS : 1;
  const r = fxRate(want * mult);
  const hz = r.hz / mult;
  return { kind, voice, code: r.code, count: r.count, hz, clamped: Math.abs(Math.log(hz / want)) > 0.06 };
}

// ---- per-frame track: kind << 16 | voice << 12 | code << 8 | count   (0 = no effect)
export type FxTrack = Uint32Array;
export const packFx = (s: { kind: number; voice: number; code: number; count: number }) => ((s.kind << 16) | (s.voice << 12) | (s.code << 8) | (s.count & 255)) >>> 0;
export const fxKindOf = (v: number) => (v >>> 16) & 3;
export const fxVoiceOf = (v: number) => (v >>> 12) & 3;
export const fxCodeOf = (v: number) => (v >>> 8) & 15;
export const fxCountOf = (v: number) => v & 255;
export const fxHzOf = (v: number) => (v ? MFP_CLOCK / (MFP_PREDIV[fxCodeOf(v)] * fxCountOf(v)) / (fxKindOf(v) === FX_SINUS ? SINUS_STEPS : 1) : 0);
export const hasFx = (t?: FxTrack | null): t is FxTrack => !!t && t.some((x) => x !== 0);

export interface FxEvent { frame: number; /** packed state, 0 = stop */ state: number }
/**
 * The engine only hears about changes.  At the loop point the state is restated whenever the state coming
 * from the end of the song differs, so the second pass starts like the first.
 */
export function fxEvents(t: FxTrack, nframes: number, loopFrame: number): FxEvent[] {
  const ev: FxEvent[] = [];
  const last = nframes > 0 ? t[nframes - 1] ?? 0 : 0;
  for (let f = 0; f < nframes; f++) {
    const cur = t[f] ?? 0, prev = f ? t[f - 1] ?? 0 : 0;
    if (cur !== prev || (f === loopFrame && last !== cur)) ev.push({ frame: f, state: cur });
  }
  return ev;
}
