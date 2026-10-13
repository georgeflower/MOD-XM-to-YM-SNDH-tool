import type { Macro, MacroStep } from './convert';

const st = (vol: number, semi = 0, noise = 0, tone = true): MacroStep => ({ vol, semi, noise, tone });
const seq = (vols: number[], f: (i: number) => Partial<MacroStep> = () => ({})): MacroStep[] =>
  vols.map((v, i) => ({ ...st(v), ...f(i) }));

/** starting points for hand-made AY instruments (one step = one 50 Hz frame) */
export const MACRO_PRESETS: Record<string, Macro> = {
  'Pluck': { velocity: true, loopFrom: -1, steps: seq([15, 13, 11, 9, 8, 7, 6, 5, 4, 3, 2, 1]) },
  'Organ (sustain)': { velocity: true, loopFrom: 0, steps: [st(15)] },
  'Lead + vibrato': { velocity: true, loopFrom: 2, steps: [st(13), st(15), ...[0, 0.2, 0.35, 0.2, 0, -0.2, -0.35, -0.2].map((s) => st(15, s))] },
  'Bass thump': { velocity: true, loopFrom: -1, steps: seq([15, 15, 14, 13, 12, 11, 10, 8, 6, 4, 2], (i) => ({ semi: i === 0 ? 12 : i === 1 ? 5 : 0 })) },
  'Tom': { velocity: true, loopFrom: -1, steps: seq([15, 13, 11, 8, 5, 2], (i) => ({ semi: -3 * i })) },
  'Hat (noise)': { velocity: true, loopFrom: -1, steps: [st(14, 0, 3, false), st(6, 0, 3, false)] },
  'Snare (tone+noise)': { velocity: true, loopFrom: -1, steps: [st(15, 0, 12, true), st(12, -12, 10, true), st(8, 0, 8, false), st(4, 0, 8, false)] },
  'Arpeggio major': { velocity: true, loopFrom: 0, steps: [st(15, 0), st(15, 4), st(15, 7)] },
  'Arpeggio minor': { velocity: true, loopFrom: 0, steps: [st(15, 0), st(15, 3), st(15, 7)] },
};

export const cloneMacro = (m: Macro): Macro => ({ ...m, steps: m.steps.map((s) => ({ ...s })) });
