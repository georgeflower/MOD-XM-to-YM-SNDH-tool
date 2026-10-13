import type { Sample } from './types';
import { fft, nextPow2 } from './fft';

/** Sample values at integer positions [a, b), honouring forward / ping-pong loops. */
export function fold(s: Sample, a: number, b: number): Float64Array {
  const n = s.data.length;
  const lo = Math.trunc(a), hi = Math.trunc(b);
  if (hi <= lo) return new Float64Array(0);
  const { ls, ll, loop } = s;
  const le = ls + ll;
  const out: number[] = [];
  for (let p = lo; p < hi; p++) {
    let i = p;
    if (loop === 1) {
      if (i >= le) i = ls + ((i - ls) % ll);
    } else if (loop === 2) {
      if (i >= le) {
        const m = (i - ls) % (2 * ll);
        i = m < ll ? ls + m : ls + 2 * ll - 1 - m;
      }
    }
    if (i >= 0 && i < n) out.push(s.data[i]);
  }
  return Float64Array.from(out);
}

export const ended = (s: Sample, pos: number) => s.loop === 0 && pos >= s.data.length;

/** autocorrelation-based fundamental period estimate (samples) + confidence */
export function autocorrCycle(xIn: Float64Array, minlag = 3): { cycle: number | null; q: number } {
  const n = xIn.length;
  if (n < 16) return { cycle: null, q: 0 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += xIn[i];
  mean /= n;
  let mx = 0;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = xIn[i] - mean; mx = Math.max(mx, Math.abs(x[i])); }
  if (mx < 1e-4) return { cycle: null, q: 0 };
  const size = nextPow2(2 * n);
  const re = new Float64Array(size), im = new Float64Array(size);
  re.set(x);
  fft(re, im);
  for (let k = 0; k < size; k++) { re[k] = re[k] * re[k] + im[k] * im[k]; im[k] = 0; }
  fft(re, im, true);
  const half = n >> 1;
  const ac = new Float64Array(half);
  const a0 = re[0] + 1e-12;
  for (let i = 0; i < half; i++) ac[i] = re[i] / a0;
  let firstNeg = -1;
  for (let i = 0; i < half; i++) if (ac[i] < 0) { firstNeg = i; break; }
  if (firstNeg < 0) return { cycle: null, q: 0 };
  const start = Math.max(firstNeg, minlag);
  const segLen = half - start;
  if (segLen < 3) return { cycle: null, q: 0 };
  let peak = -Infinity;
  for (let i = start; i < half; i++) if (ac[i] > peak) peak = ac[i];
  for (let k = 1; k < segLen - 1; k++) {
    const v = ac[start + k];
    if (v >= 0.9 * peak && v >= ac[start + k - 1] && v >= ac[start + k + 1]) {
      const lag = start + k;
      const y0 = ac[lag - 1], y1 = ac[lag], y2 = ac[lag + 1];
      const den = y0 - 2 * y1 + y2;
      const frac = Math.abs(den) > 1e-12 ? 0.5 * (y0 - y2) / den : 0;
      return { cycle: lag + frac, q: peak };
    }
  }
  return { cycle: null, q: peak };
}

export type SampleClass = 'tonal' | 'kick' | 'noise' | 'empty';
export interface SampleInfo { cls: SampleClass; cycle: number | null; q: number; zc: number }

export function analyseSample(s: Sample, overrideCycle?: number): SampleInfo {
  const d = s.data;
  if (d.length < 8) return { cls: 'empty', cycle: null, q: 0, zc: 0 };
  let body: Float64Array;
  if (s.loop) body = fold(s, s.ls, s.ls + Math.max(4096, 2 * s.ll + 2));
  else body = d.subarray(0, 8192);
  let { cycle, q } = autocorrCycle(body);
  if (cycle && s.loop === 1) {
    const n = Math.max(1, Math.round(s.ll / cycle));
    const snapped = s.ll / n;
    if (Math.abs(snapped - cycle) / cycle < 0.02) cycle = snapped;
  }
  if (overrideCycle) cycle = overrideCycle;
  let crossings = 0;
  for (let i = 1; i < d.length; i++) if ((d[i] < 0) !== (d[i - 1] < 0)) crossings++;
  const zc = crossings / Math.max(1, d.length);
  const cls: SampleClass = q >= 0.75 && cycle ? 'tonal' : zc > 0.04 ? 'noise' : 'kick';
  return { cls, cycle, q, zc };
}
