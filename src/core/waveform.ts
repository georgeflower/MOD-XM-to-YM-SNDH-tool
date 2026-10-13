/**
 * Sample -> AY waveform. A YM2149 voice has two ways to make a tone: the square-wave generator and, borrowed from the
 * envelope generator, the "buzzer" - a hardware envelope run so fast it becomes a sawtooth or triangle wave at the
 * note's pitch. The buzzer is what AY bass lines use for a sawtooth / triangle / sine-ish sound, so a sample is
 * classified by the spectrum of its single cycle and mapped to the closest of those:
 *
 *   square (odd harmonics, 1/k)            -> square tone (the default sound)
 *   thin pulse (all harmonics, flat)       -> sawtooth buzzer (the AY has no pulse-width control; the saw is the closest bright wave)
 *   sawtooth (all harmonics, 1/k)          -> sawtooth buzzer, \\\\ (falling) or //// (rising)
 *   triangle / sine (odd 1/k^2 or pure)    -> triangle buzzer
 *   anything else                          -> square tone
 *
 * The envelope generator is shared by the three voices and cannot be scaled in level, so a buzzer is only used while
 * the note is loud, only for one voice at a time and only where the envelope period is large enough to hit the pitch.
 */
import type { Sample } from './types';
import { fold } from './samples';

export type WaveClass = 'square' | 'pulse' | 'saw' | 'sawup' | 'smooth' | 'complex';
export interface WaveInfo { cls: WaveClass; /** distance to the best template (0 = perfect) */ dist: number; /** harmonic amplitudes 1..8 relative to the fundamental */ h: number[] }
/** what a source instrument may be forced to: 'tone' = plain square wave */
export type WaveChoice = 'tone' | 'saw' | 'sawup' | 'smooth';

/** hardware envelope shape of each buzzer wave: 8 = \\\\  12 = ////  10 = \/\/ (triangle) */
export const BUZZ_SHAPE: Record<WaveChoice, number> = { tone: 0, saw: 8, sawup: 12, smooth: 10 };
/** smallest envelope period that still hits the pitch within ~0.8 % */
export const BUZZ_MIN_PERIOD = 32;
/** AY level at or above which a note is played as a buzzer (the buzzer cannot be quieter than full) */
export const BUZZ_MIN_LEVEL = 12;

/** envelope period that makes `shape` sound at `hz` (YM clock 2 MHz; a triangle cycle is two ramps) */
export function buzzPeriod(hz: number, shape: number, clock = 2_000_000): number {
  const ramps = shape === 10 || shape === 14 ? 512 : 256;
  return clock / (ramps * hz);
}
/** is `hz` playable as a buzzer of `shape` (envelope period 32 .. 65535)? */
export function buzzable(hz: number, shape: number): boolean {
  const p = buzzPeriod(hz, shape);
  return p >= BUZZ_MIN_PERIOD && p <= 65535;
}

const N = 64;
const K = 8;

/** the mean waveform of one cycle (N points), or null when the sample cannot give one */
function oneCycle(s: Sample, cycle: number): Float64Array | null {
  if (!(cycle >= 8)) return null;
  const p0 = s.loop ? s.ls : Math.floor(s.data.length * 0.1);
  const avail = s.loop ? 1e9 : s.data.length - p0;
  const ncyc = Math.min(8, Math.floor(avail / cycle) - 1);
  if (ncyc < 1) return null;
  const span = fold(s, p0, p0 + Math.ceil((ncyc + 1) * cycle) + 2);
  if (span.length < (ncyc + 1) * cycle) return null;
  const out = new Float64Array(N);
  for (let c = 0; c < ncyc; c++) {
    for (let j = 0; j < N; j++) {
      const pos = (c + j / N) * cycle, i = Math.floor(pos), fr = pos - i;
      out[j] += (span[i] * (1 - fr) + span[Math.min(span.length - 1, i + 1)] * fr) / ncyc;
    }
  }
  return out;
}

function harmonics(x: Float64Array): number[] {
  const h: number[] = [];
  for (let k = 1; k <= K; k++) {
    let re = 0, im = 0;
    for (let j = 0; j < N; j++) { const a = (2 * Math.PI * k * j) / N; re += x[j] * Math.cos(a); im -= x[j] * Math.sin(a); }
    h.push(Math.hypot(re, im));
  }
  const h1 = h[0] || 1e-12;
  return h.map((v) => v / h1);
}

const tpl = (f: (k: number) => number) => Array.from({ length: K }, (_, i) => f(i + 1));
const pulse = (d: number) => tpl((k) => Math.abs(Math.sin(k * Math.PI * d)) / (k * Math.sin(Math.PI * d)));
const TEMPLATES: { cls: WaveClass; t: number[] }[] = [
  { cls: 'square', t: tpl((k) => (k % 2 ? 1 / k : 0)) },
  { cls: 'saw', t: tpl((k) => 1 / k) },
  { cls: 'smooth', t: tpl((k) => (k % 2 ? 1 / (k * k) : 0)) },
  { cls: 'smooth', t: tpl((k) => (k === 1 ? 1 : 0)) },
  { cls: 'pulse', t: pulse(0.25) },
  { cls: 'pulse', t: pulse(0.125) },
];

/** classify the waveform of a sample from the spectrum of one of its cycles (`cycle` = samples per cycle) */
export function analyseWave(s: Sample, cycle: number | null): WaveInfo {
  const none: WaveInfo = { cls: 'complex', dist: 1, h: [] };
  if (!cycle) return none;
  const x = oneCycle(s, cycle);
  if (!x) return none;
  let mean = 0;
  for (const v of x) mean += v / N;
  for (let j = 0; j < N; j++) x[j] -= mean;
  const h = harmonics(x);
  // only compare harmonics the sample rate can represent
  const kmax = Math.max(3, Math.min(K, Math.floor(cycle / 2)));
  let best = 'complex' as WaveClass, bd = Infinity;
  for (const { cls, t } of TEMPLATES) {
    let e = 0;
    for (let k = 1; k < kmax; k++) e += (h[k] - t[k]) ** 2;
    const d = Math.sqrt(e / (kmax - 1));
    if (d < bd) { bd = d; best = cls; }
  }
  if (bd > 0.12) return { cls: 'complex', dist: bd, h };
  if (best === 'saw') {
    let up = 0;
    for (let j = 0; j < N; j++) if (x[(j + 1) % N] > x[j]) up++;
    return { cls: up > N / 2 ? 'sawup' : 'saw', dist: bd, h };
  }
  return { cls: best, dist: bd, h };
}

/** buzzer wave a detected class maps to ('tone' = no buzzer) */
export function waveOfClass(cls: WaveClass): WaveChoice {
  switch (cls) {
    case 'saw': case 'pulse': return 'saw';
    case 'sawup': return 'sawup';
    case 'smooth': return 'smooth';
    default: return 'tone';
  }
}
