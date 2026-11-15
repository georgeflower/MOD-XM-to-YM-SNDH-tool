/**
 * Echo / delay channels: a channel that plays the melody of another channel again, a fixed time later (usually quieter).
 * Trackers do this by hand (copy the track a few rows down at a lower volume) and the SNES DSP echo becomes such channels
 * in the SPC import. On three YM voices an echo is the first thing to give up, so it is found here and marked.
 *
 * Per channel the note starts (frame, note) are collected; for every pair of channels the delay with the most notes in
 * common (same note, same delay within a frame) is taken, and the later channel is an echo of the earlier one when most of
 * its notes are copies at that delay.
 */
import type { Module } from './types';
import { replay, noteAges, type ReplayResult } from './replay';

export interface EchoInfo {
  /** the echo channel (0-based) */
  ch: number;
  /** the channel it repeats (0-based) */
  of: number;
  /** delay in 50 Hz frames and in pattern rows (rounded) */
  frames: number;
  rows: number;
  /** share of the echo channel's notes that repeat the other channel (0..1) */
  match: number;
  /** loudness of the echo against the original (median ratio, 1 = as loud) */
  level: number;
}

interface Ev { f: number; note: number; vol: number }

const MAX_DELAY = 150;                   // 3 s
const MIN_NOTES = 6;
const MIN_MATCH = 0.6;

export function detectEchoes(m: Module, rep: ReplayResult = replay(m)): EchoInfo[] {
  const frames = rep.frames, ages = noteAges(frames), nch = m.nch;
  const evs: Ev[][] = Array.from({ length: nch }, () => []);
  for (let f = 0; f < frames.length; f++) for (let c = 0; c < nch; c++) {
    const st = frames[f][c];
    if (!st || ages[f][c] !== 0 || st.vol <= 0) continue;
    const nx = frames[f + 1]?.[c];
    evs[c].push({ f, note: st.note, vol: Math.max(st.vol, nx && ages[f + 1][c] === 1 ? nx.vol : 0) });
  }
  const lens = rep.rows.map((r) => r.len).filter((x) => x > 0).sort((a, b) => a - b);
  const rowLen = lens.length ? lens[lens.length >> 1] : 6;

  // index: channel -> note -> sorted frames
  const idx = evs.map((l) => { const mp = new Map<number, Ev[]>(); for (const e of l) (mp.get(e.note) ?? mp.set(e.note, []).get(e.note)!).push(e); return mp; });
  const near = (c: number, note: number, f: number): Ev | null => {
    const l = idx[c].get(note);
    if (!l) return null;
    let lo = 0, hi = l.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (l[mid].f < f - 1) lo = mid + 1; else if (l[mid].f > f + 1) hi = mid - 1; else return l[mid]; }
    return null;
  };

  const found: EchoInfo[] = [];
  for (let b = 0; b < nch; b++) {
    if (evs[b].length < MIN_NOTES) continue;
    let best: EchoInfo | null = null;
    for (let a = 0; a < nch; a++) {
      if (a === b || evs[a].length < MIN_NOTES) continue;
      // delay histogram over notes in common
      const hist = new Map<number, number>();
      for (const e of evs[b]) {
        const l = idx[a].get(e.note);
        if (!l) continue;
        for (const x of l) { const d = e.f - x.f; if (d >= 1 && d <= MAX_DELAY) hist.set(d, (hist.get(d) ?? 0) + 1); }
      }
      let d = 0, top = 0;
      for (const [k, v] of hist) { const s = v + (hist.get(k - 1) ?? 0) * 0.5 + (hist.get(k + 1) ?? 0) * 0.5; if (s > top) { top = s; d = k; } }
      if (!d) continue;
      let hit = 0;
      const ratios: number[] = [];
      for (const e of evs[b]) { const x = near(a, e.note, e.f - d); if (x) { hit++; if (x.vol > 0) ratios.push(e.vol / x.vol); } }
      const match = hit / evs[b].length;
      if (match < MIN_MATCH || hit < MIN_NOTES) continue;
      ratios.sort((p, q) => p - q);
      const level = ratios.length ? ratios[ratios.length >> 1] : 1;
      // the original is the one that plays first: a channel that is just as much an echo the other way round (two
      // channels playing a repeating riff in canon) only counts when it is clearly quieter
      if (best && (match < best.match || (match === best.match && d >= best.frames))) continue;
      best = { ch: b, of: a, frames: d, rows: Math.max(1, Math.round(d / rowLen)), match, level };
    }
    if (best) found.push(best);
  }
  // two channels that are each other's echo (a repeating riff): keep the quieter / later one as the echo
  return found.filter((e) => {
    const back = found.find((x) => x.ch === e.of && x.of === e.ch);
    if (!back) return true;
    if (Math.abs(e.level - back.level) > 0.1) return e.level < back.level;
    return e.frames < back.frames || (e.frames === back.frames && e.ch > back.ch);
  });
}

/** "echo of ch 3, 2 rows later" */
export const echoLabel = (e: EchoInfo) => `echo of ch ${e.of + 1}, ${e.rows} row${e.rows === 1 ? '' : 's'} later`;
