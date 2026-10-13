import { describe, it, expect } from 'vitest';
import { DEFAULT_OPTS, mappingToJson, parseMapping } from '../src/core/mapping';
import type { InstMap } from '../src/core/convert';

const info = { title: 'song', kind: 'xm', channels: 8, instruments: 5 };

describe('mapping file', () => {
  it('round-trips options, priorities, modes, transpose, waveform and macros', () => {
    const inst: Record<number, InstMap> = {
      1: { mode: 'tone', transpose: -12, wave: 'saw' },
      2: { mode: 'kick' },
      3: { mode: 'macro', macro: { loopFrom: 1, velocity: false, steps: [{ vol: 15, semi: 0, noise: 0, tone: true }, { vol: 7, semi: -2.5, noise: 9, tone: false }] } },
      4: { mode: 'auto', wave: 'smooth' },
      5: { mode: 'digi' },
    };
    const opts = { ...DEFAULT_OPTS, gainDb: 3.5, middle: true, waveform: true, arpFill: 2, arpOrder: 'yx' as const, digi: true, digiRate: 12000 };
    const text = mappingToJson({ opts, prio: { 0: 2, 3: -1 }, inst }, info);
    const r = parseMapping(text, info);
    expect(r.warnings).toEqual([]);
    expect(r.opts).toEqual(opts);
    expect(r.prio).toEqual({ 0: 2, 3: -1 });
    expect(r.inst).toEqual(inst);
  });

  it('warns when the file belongs to another module, but still loads it', () => {
    const text = mappingToJson({ opts: DEFAULT_OPTS, prio: {}, inst: { 1: { mode: 'mute' } } }, info);
    const r = parseMapping(text, { title: 'other', kind: 'mod', channels: 4, instruments: 5 });
    expect(r.warnings.join()).toMatch(/different module/);
    expect(r.warnings.join()).toMatch(/other|song/);
    expect(r.inst[1].mode).toBe('mute');
  });

  it('rejects things that are not mapping files', () => {
    expect(() => parseMapping('not json')).toThrow(/JSON/);
    expect(() => parseMapping('{"a":1}')).toThrow(/mapping file/);
    expect(() => parseMapping('[1,2]')).toThrow(/mapping file/);
    expect(() => parseMapping(JSON.stringify({ format: 'mod-xm-to-ym-mapping', version: 9 }))).toThrow(/newer/);
  });

  it('clamps and drops hand-edited rubbish instead of passing it on', () => {
    const text = JSON.stringify({
      format: 'mod-xm-to-ym-mapping', version: 1,
      opts: { gainDb: 99, drumBonus: 'x', arpFill: 77, arpOrder: 'zz', digiRate: -5 },
      prio: { '2': 99, '-1': 1, abc: 2, '70': 1 },
      inst: {
        '1': { mode: 'tone', transpose: 500, wave: 'bogus' },
        '2': { mode: 'nonsense' },
        '3': { mode: 'macro' },
        '4': { mode: 'macro', macro: { steps: [{ vol: 99, semi: 99, noise: 99 }], loopFrom: 5 } },
        '0': { mode: 'mute' },
        '300': { mode: 'mute' },
      },
    });
    const r = parseMapping(text);
    expect(r.opts.gainDb).toBe(12);
    expect(r.opts.drumBonus).toBe(DEFAULT_OPTS.drumBonus);
    expect(r.opts.arpFill).toBe(3);
    expect(r.opts.arpOrder).toBe('xy');
    expect(r.opts.digiRate).toBe(2000);
    expect(r.prio).toEqual({ 2: 10 });
    expect(r.inst[1]).toEqual({ mode: 'tone', transpose: 48 });
    expect(r.inst[2]).toBeUndefined(); expect(r.inst[3]).toBeUndefined();
    expect(r.inst[4].macro).toEqual({ steps: [{ vol: 15, semi: 48, noise: 31, tone: true }], loopFrom: 0, velocity: true });
    expect(Object.keys(r.inst).sort()).toEqual(['1', '4']);
    expect(r.warnings.join()).toMatch(/4 instrument entries/);
  });
});
