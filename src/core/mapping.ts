/**
 * Converter settings as a file: the instrument mapping (role, transpose, waveform, custom macros), the channel
 * priorities and the conversion options, so a tuned conversion of a module can be reopened later.
 * The file is plain JSON; loading validates and clamps everything (it may have been edited by hand).
 */
import type { InstMap, InstMode, Macro, MacroStep } from './convert';
import type { WaveChoice } from './waveform';

export interface Opts {
  gainDb: number; drumBonus: number; sticky: number; arpOrder: 'xy' | 'yx'; arpFill: number; arpMinVol: number;
  digi: boolean; digiRate: number; digiMaxMs: number; middle: boolean; waveform: boolean;
}
export const DEFAULT_OPTS: Opts = {
  gainDb: 0, drumBonus: 3, sticky: 1.5, arpOrder: 'xy', arpFill: 0, arpMinVol: 3,
  digi: false, digiRate: 8000, digiMaxMs: 500, middle: false, waveform: false,
};

export const MAPPING_FORMAT = 'mod-xm-to-ym-mapping';
export interface MappingModuleInfo { title: string; kind: string; channels: number; instruments: number }
export interface Mapping { opts: Opts; prio: Record<number, number>; inst: Record<number, InstMap> }

export function mappingToJson(m: Mapping, mod: MappingModuleInfo): string {
  return JSON.stringify({ format: MAPPING_FORMAT, version: 1, module: mod, opts: m.opts, prio: m.prio, inst: m.inst }, null, 2) + '\n';
}

const MODES: InstMode[] = ['auto', 'mute', 'tone', 'kick', 'snare', 'hat', 'macro', 'digi'];
const WAVES: WaveChoice[] = ['tone', 'saw', 'sawup', 'smooth'];
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const int = (v: unknown, lo: number, hi: number, d: number) => Math.round(num(v, lo, hi, d));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function cleanMacro(v: unknown): Macro | null {
  if (!isObj(v) || !Array.isArray(v.steps) || !v.steps.length) return null;
  const steps: MacroStep[] = v.steps.slice(0, 256).map((s) => {
    const o = isObj(s) ? s : {};
    return { vol: int(o.vol, 0, 15, 0), semi: num(o.semi, -48, 48, 0), noise: int(o.noise, 0, 31, 0), tone: o.tone !== false };
  });
  const lf = int(v.loopFrom, -1, steps.length - 1, -1);
  return { steps, loopFrom: lf, velocity: v.velocity !== false };
}

export interface ParsedMapping extends Mapping { warnings: string[] }

/** parse a mapping file; throws on a file that is not one, warns about a different module and dropped entries */
export function parseMapping(text: string, mod?: MappingModuleInfo): ParsedMapping {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error('Not a mapping file (not valid JSON)'); }
  if (!isObj(j) || j.format !== MAPPING_FORMAT) throw new Error('Not a mapping file saved by this tool');
  if (typeof j.version === 'number' && j.version > 1) throw new Error('This mapping file is from a newer version of the tool');
  const warnings: string[] = [];
  const m = isObj(j.module) ? j.module : null;
  if (mod && m) {
    const diff: string[] = [];
    if (typeof m.title === 'string' && m.title !== mod.title) diff.push(`title "${m.title}"`);
    if (typeof m.channels === 'number' && m.channels !== mod.channels) diff.push(`${m.channels} channels`);
    if (typeof m.instruments === 'number' && m.instruments !== mod.instruments) diff.push(`${m.instruments} instruments`);
    if (diff.length) warnings.push(`the mapping was saved for a different module (${diff.join(', ')})`);
  }
  const o = isObj(j.opts) ? j.opts : {};
  const d = DEFAULT_OPTS;
  const opts: Opts = {
    gainDb: num(o.gainDb, -12, 12, d.gainDb), drumBonus: num(o.drumBonus, 0, 6, d.drumBonus), sticky: num(o.sticky, 0, 4, d.sticky),
    arpOrder: o.arpOrder === 'yx' ? 'yx' : 'xy', arpFill: int(o.arpFill, 0, 3, d.arpFill), arpMinVol: int(o.arpMinVol, 1, 12, d.arpMinVol),
    digi: o.digi === true, digiRate: int(o.digiRate, 2000, 24000, d.digiRate), digiMaxMs: int(o.digiMaxMs, 50, 1500, d.digiMaxMs),
    middle: o.middle === true, waveform: o.waveform === true,
  };
  const prio: Record<number, number> = {};
  if (isObj(j.prio)) for (const [k, v] of Object.entries(j.prio)) { const c = Number(k); if (Number.isInteger(c) && c >= 0 && c < 64 && typeof v === 'number' && Number.isFinite(v)) prio[c] = Math.max(-10, Math.min(10, v)); }
  const inst: Record<number, InstMap> = {};
  let dropped = 0;
  if (isObj(j.inst)) {
    for (const [k, v] of Object.entries(j.inst)) {
      const n = Number(k);
      if (!Number.isInteger(n) || n < 1 || n > 255 || !isObj(v) || !MODES.includes(v.mode as InstMode)) { dropped++; continue; }
      const e: InstMap = { mode: v.mode as InstMode };
      if (typeof v.transpose === 'number' && v.transpose) e.transpose = int(v.transpose, -48, 48, 0);
      if (WAVES.includes(v.wave as WaveChoice)) e.wave = v.wave as WaveChoice;
      if (e.mode === 'macro') {
        const mac = cleanMacro(v.macro);
        if (!mac) { dropped++; continue; }
        e.macro = mac;
      }
      inst[n] = e;
    }
  }
  if (dropped) warnings.push(`${dropped} instrument entr${dropped === 1 ? 'y' : 'ies'} could not be read and were left on auto`);
  return { opts, prio, inst, warnings };
}
