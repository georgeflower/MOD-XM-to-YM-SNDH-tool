/**
 * maxYMiser timer effects: the interrupt rate the replayer programs for a voice.
 *
 * The rate follows the voice's tone period (the timer component of the note, or its fixed-frequency sequence), the
 * effect kind and the waveform length:  SID (kind 5) runs `steps` interrupts per tone period, sync-buzzer (kind 11)
 * one.  The replayer divides with a table of (period threshold, scale) per MFP prescaler; this is that arithmetic, so a
 * fixed period can be searched for any wanted interrupt rate.
 */
import { MFP_CLOCK } from '../core/drums';

/** [threshold, scale] per MFP prescaler 1..7 (4, 10, 16, 50, 64, 100, 200), rows 0..16 = waveform length */
const TIMER_DIVIDERS: number[][] = [
  [0, 0, 104, 80, 260, 200, 416, 320, 1300, 1000, 1664, 1280, 2600, 2000, 5201, 4000],
  [0, 0, 104, 40, 260, 100, 416, 160, 1300, 500, 1664, 640, 2600, 1000, 5201, 2000],
  [0, 0, 104, 40, 260, 100, 416, 160, 1300, 500, 1664, 640, 2600, 1000, 5201, 2000],
  [0, 0, 156, 40, 390, 100, 624, 160, 1950, 500, 2496, 640, 3900, 1000, 7801, 2000],
  [0, 0, 208, 40, 520, 100, 832, 160, 2600, 500, 3328, 640, 5201, 1000, 10402, 2000],
  [0, 0, 260, 40, 650, 100, 1040, 160, 3250, 500, 4160, 640, 6501, 1000, 13002, 2000],
  [0, 0, 312, 40, 780, 100, 1248, 160, 3900, 500, 4992, 640, 7801, 1000, 0, 2000],
  [0, 0, 364, 40, 910, 100, 1456, 160, 4550, 500, 5825, 640, 9101, 1000, 0, 2000],
  [0, 0, 416, 40, 1040, 100, 1664, 160, 5201, 500, 6657, 640, 10402, 1000, 0, 2000],
  [0, 0, 468, 40, 1170, 100, 1872, 160, 5851, 500, 7489, 640, 11702, 1000, 0, 2000],
  [0, 0, 520, 40, 1300, 100, 2080, 160, 6501, 500, 8321, 640, 0, 1000, 0, 2000],
  [0, 0, 572, 40, 1430, 100, 2288, 160, 7151, 500, 9153, 640, 0, 1000, 0, 2000],
  [0, 0, 624, 40, 1560, 100, 2496, 160, 7801, 500, 9985, 640, 0, 1000, 0, 2000],
  [0, 0, 676, 40, 1690, 100, 2704, 160, 8451, 500, 0, 640, 0, 1000, 0, 2000],
  [0, 0, 728, 40, 1820, 100, 2912, 160, 9101, 500, 0, 640, 0, 1000, 0, 2000],
  [0, 0, 780, 40, 1950, 100, 3120, 160, 9751, 500, 0, 640, 0, 1000, 0, 2000],
  [0, 0, 832, 40, 2080, 100, 3328, 160, 10402, 500, 0, 640, 0, 1000, 0, 2000],
];
const DIVISORS = [0, 4, 10, 16, 50, 64, 100, 200];

/** interrupt rate (Hz) of a SID (kind 5) or sync-buzzer (kind 11) timer for a timer-component period; 0 = the replayer leaves it off */
export function timerFrequency(period: number, kind: 5 | 11, length: number): number {
  if (period <= 0) return 0;
  const steps = kind === 5 ? Math.max(1, length) : 1;
  const row = kind === 5 ? Math.max(1, Math.min(16, length)) : 0;
  for (let div = 1; div < 8; div++) {
    const threshold = TIMER_DIVIDERS[row][div * 2], scale = TIMER_DIVIDERS[row][div * 2 + 1];
    if (threshold === 0 || period > threshold) continue;
    const data = ((Math.trunc((393 * period) / (scale * steps)) + 1) >> 1);
    if (data <= 0 || data > 256 || (div === 1 && data < 24)) return 0;
    return MFP_CLOCK / (DIVISORS[div] * data);
  }
  return 0;
}

const cache = new Map<string, { period: number; hz: number }>();
/** the fixed timer period whose interrupt rate is nearest to `hz` (null when nothing within 6 % exists) */
export function timerPeriodFor(kind: 5 | 11, length: number, hz: number): { period: number; hz: number } | null {
  if (!(hz > 0)) return null;
  const key = `${kind}/${length}/${Math.round(hz * 100)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let best: { period: number; hz: number } | null = null, bestErr = Infinity;
  for (let p = 1; p <= 22000; p++) {
    const f = timerFrequency(p, kind, length);
    if (!f) continue;
    const e = Math.abs(Math.log(f / hz));
    if (e < bestErr - 1e-12) { bestErr = e; best = { period: p, hz: f }; }
  }
  if (!best || bestErr > 0.06) return null;
  cache.set(key, best);
  return best;
}
