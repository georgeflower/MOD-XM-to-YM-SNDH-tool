/** Period <-> frequency models. XM linear periods and Amiga (ProTracker) periods. */

// ---- XM linear ----
export const xmPeriodOf = (noteIdx: number, fine: number) => 7680 - noteIdx * 64 - fine / 2.0;
export const xmRateOf = (period: number) => 8363.0 * Math.pow(2.0, (4608.0 - period) / 768.0);

// ---- Amiga ----
// ProTracker finetune-0 table, notes C-1..B-3 (index 0..35)
export const PT_PERIODS = [
  856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
  428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
  214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
];
export const AMIGA_CLOCK = 3546894.6; // PAL Paula clock / 1 => rate = clock / period
/** XM note number (1 = C-0, 49 = C-4) of PT index 0 (C-1): PT C-2 (period 428) sounds like XM C-4. */
export const PT_NOTE_BASE = 37;

/** period for PT note index (may lie outside 0..35, extrapolated by octaves), finetune -8..7 */
export function amigaPeriodOf(idx: number, finetune: number): number {
  let base: number;
  if (idx >= 0 && idx < 36) base = PT_PERIODS[idx];
  else base = PT_PERIODS[((idx % 12) + 12) % 12] * Math.pow(2, -(Math.floor(idx / 12)));
  return Math.round(base * Math.pow(2, -finetune / 96));
}
export const amigaRateOf = (period: number) => AMIGA_CLOCK / Math.max(1, period);

/** nearest PT note index for a raw period (finetune 0 table) */
export function periodToIndex(period: number): number {
  let best = 0, bd = 1e9;
  for (let i = 0; i < 36; i++) {
    const dd = Math.abs(PT_PERIODS[i] - period);
    if (dd < bd) { bd = dd; best = i; }
  }
  return best;
}
