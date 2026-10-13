/**
 * Per-channel facts about a module for the manual import: how busy a channel is over the song, what pitch it sits at and
 * which instruments it plays, so the user can tell the melody from the bass and the drums.
 */
import type { Module } from './types';
import { replay } from './replay';

export interface ChanStat {
  ch: number;
  /** share of the frames in which the channel sounds (0..1) */
  activeFrac: number;
  /** notes started */
  notes: number;
  /** median note (1-based, 49 = C-4) of the sounding frames, null when the channel is silent */
  medianNote: number | null;
  /** loudness over the song, `buckets` values 0..1 */
  buckets: number[];
  /** the instruments the channel plays most, with their names */
  insts: { inst: number; name: string; frames: number }[];
}

const NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
export const noteLabel = (n: number) => `${NAMES[(n - 1) % 12]}${Math.floor((n - 1) / 12)}`;

export function channelStats(m: Module, buckets = 96): ChanStat[] {
  const rep = replay(m);
  const n = rep.frames.length, nch = m.nch;
  const act = new Array<number>(nch).fill(0), notes = new Array<number>(nch).fill(0);
  const sum = Array.from({ length: nch }, () => new Float64Array(buckets));
  const cnt = new Float64Array(buckets);
  const pitch: number[][] = Array.from({ length: nch }, () => []);
  const inst: Map<number, number>[] = Array.from({ length: nch }, () => new Map());
  for (let f = 0; f < n; f++) {
    const b = Math.min(buckets - 1, Math.floor((f * buckets) / Math.max(1, n)));
    cnt[b]++;
    rep.frames[f].forEach((st, c) => {
      if (!st || st.vol <= 0) return;
      act[c]++;
      if (st.age === 0) notes[c]++;
      sum[c][b] += Math.min(1, st.vol);
      if (f % 4 === 0) pitch[c].push(st.note);
      inst[c].set(st.inst, (inst[c].get(st.inst) ?? 0) + 1);
    });
  }
  return Array.from({ length: nch }, (_, c) => {
    const p = pitch[c].sort((a, b) => a - b);
    return {
      ch: c,
      activeFrac: n ? act[c] / n : 0,
      notes: notes[c],
      medianNote: p.length ? p[p.length >> 1] : null,
      buckets: Array.from(sum[c], (s, b) => (cnt[b] ? s / cnt[b] : 0)),
      insts: [...inst[c]].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i, frames]) => ({ inst: i, name: m.instruments[i]?.name?.trim() || `#${i}`, frames })),
    };
  });
}

/** a first guess: the busiest pitched channel is the lead, nearly silent ones are low priority, the rest normal */
export function suggestPriorities(stats: ChanStat[], levels: { low: number; normal: number; lead: number }): Record<number, number> {
  const out: Record<number, number> = {};
  let lead = -1, best = 0;
  for (const s of stats) {
    const score = s.notes * s.activeFrac * (s.medianNote !== null && s.medianNote >= 40 ? 1 : 0.5);
    if (s.activeFrac >= 0.1 && score > best) { best = score; lead = s.ch; }
  }
  for (const s of stats) {
    const v = s.ch === lead ? levels.lead : s.activeFrac < 0.05 ? levels.low : levels.normal;
    if (v !== 0) out[s.ch] = v;
  }
  return out;
}

