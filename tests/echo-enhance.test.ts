import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadModule } from '../src/core/load';
import { convert } from '../src/core/convert';
import { detectEchoes, echoLabel } from '../src/core/echo';
import { PRIO_OFF } from '../src/core/replay';
import { fxKindOf, fxVoiceOf, fxHzOf, FX_SID, FX_SINUS } from '../src/core/fx';
import { mappingToJson, parseMapping, DEFAULT_OPTS } from '../src/core/mapping';
import { emptyCell, type Module } from '../src/core/types';
import { moduleToSong } from '../src/tracker/fromModule';
import { renderSong } from '../src/tracker/render';
import { parseEffectChar } from '../src/tracker/types';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${n}`, import.meta.url)));

/** Omar's Bazaar with a fifth channel that repeats channel 1 three rows later at half volume */
function withEcho(): Module {
  const m = loadModule(fx('OMARSBAZAAR.xm'));
  const flat = m.order.flatMap((pi) => m.patterns[pi].map((row) => row[0]));
  const pats = m.patterns.map((p) => p.map((row) => [...row.map((c) => ({ ...c })), emptyCell()]));
  let k = 0;
  const seen = new Set<number>();
  for (const pi of m.order) {
    const p = pats[pi];
    for (let r = 0; r < p.length; r++, k++) {
      if (seen.has(pi)) continue;
      const src = flat[k - 3];
      if (src && src.note > 0 && src.note < 97) p[r][4] = { note: src.note, inst: src.inst, vol: 0x10 + 32, eff: 0, par: 0 };
    }
    seen.add(pi);
  }
  return { ...m, nch: 5, patterns: pats };
}

const RN = 14;
const per = (regs: Uint8Array, f: number, v: number) => regs[f * RN + 2 * v] | ((regs[f * RN + 2 * v + 1] & 15) << 8);
const vol = (regs: Uint8Array, f: number, v: number) => regs[f * RN + 8 + v] & 31;

describe('echo channels', () => {
  it('finds a channel that repeats another a few rows later, quieter', () => {
    const e = detectEchoes(withEcho());
    const x = e.find((q) => q.ch === 4);
    expect(x).toBeDefined();
    expect(x!.of).toBe(0);
    expect(x!.rows).toBe(3);
    expect(x!.match).toBeGreaterThan(0.6);
    expect(x!.level).toBeLessThan(0.8);
    expect(echoLabel(x!)).toBe('echo of ch 1, 3 rows later');
    // the original module has no echo channels
    expect(detectEchoes(loadModule(fx('OMARSBAZAAR.xm')))).toEqual([]);
  });
});

describe('AY touches', () => {
  const m = loadModule(fx('OMARSBAZAAR.xm'));
  // only one channel left: two voices are free all the time
  const one = { prio: { 0: PRIO_OFF, 1: PRIO_OFF, 2: PRIO_OFF } };

  it('chorus: a free voice plays the lead a few cents off, two levels quieter', () => {
    const plain = convert(m, one), ch = convert(m, { ...one, enhance: { free: 'chorus', chorusCents: 8 } });
    let checked = 0;
    for (let f = 0; f < plain.nframes && checked < 50; f++) {
      const voices = [0, 1, 2].filter((v) => vol(plain.regs, f, v) > 3 && !(vol(plain.regs, f, v) & 16));
      if (voices.length !== 1) continue;
      const v = voices[0], p = per(plain.regs, f, v);
      const extra = [0, 1, 2].filter((w) => w !== v && vol(ch.regs, f, w) > 0);
      expect(extra.length).toBe(1);
      const q = per(ch.regs, f, extra[0]);
      const cents = 1200 * Math.log2(p / q);
      expect(q).toBeLessThan(p);                                          // higher, by at least one period step
      if (p > 400) expect(Math.abs(cents - 8)).toBeLessThan(3);           // period rounding at high notes
      expect(vol(ch.regs, f, extra[0])).toBe(vol(plain.regs, f, v) - 2);
      checked++;
    }
    expect(checked).toBe(50);
  });

  it('echo: a free voice plays the lead again later and quieter', () => {
    const plain = convert(m, one), ec = convert(m, { ...one, enhance: { free: 'echo', echoFrames: 9 } });
    let checked = 0;
    for (let f = 20; f < plain.nframes && checked < 30; f++) {
      const v = [0, 1, 2].find((w) => vol(plain.regs, f - 9, w) > 6 && !(vol(plain.regs, f - 9, w) & 16));
      if (v === undefined || [0, 1, 2].filter((w) => vol(plain.regs, f, w) > 0).length !== 1) continue;
      const hit = [0, 1, 2].some((w) => per(ec.regs, f, w) === per(plain.regs, f - 9, v) && vol(ec.regs, f, w) === vol(plain.regs, f - 9, v) - 4);
      expect(hit).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('lead sound: SID voice / sinus-SID timer at twice the note frequency, on the lead voice', () => {
    const r = convert(m, { enhance: { leadFx: 'sid' } });
    expect(r.fx).toBeDefined();
    let n = 0;
    for (let f = 0; f < r.nframes && n < 40; f++) {
      const s = r.fx![f];
      if (!s) continue;
      expect(fxKindOf(s)).toBe(FX_SID);
      const v = fxVoiceOf(s), hz = 125000 / per(r.regs, f, v);
      expect(Math.abs(Math.log(fxHzOf(s) / (2 * hz * 1.006)))).toBeLessThan(0.03);
      n++;
    }
    expect(n).toBe(40);
    const soft = convert(m, { enhance: { leadFx: 'soft' } });
    const used = Array.from(soft.fx!).filter(Boolean);
    expect(used.length).toBeGreaterThan(100);
    for (const s of used.slice(0, 50)) { expect(fxKindOf(s)).toBe(FX_SINUS); expect(fxHzOf(s)).toBeLessThanOrEqual(2 * 313); }
  });

  it('soft note starts: a melodic note starts 4 levels down, then 2, then full', () => {
    const plain = convert(m, one), soft = convert(m, { ...one, enhance: { soft: true } });
    let checked = 0;
    for (let f = 1; f + 2 < plain.nframes && checked < 20; f++) for (let v = 0; v < 3; v++) {
      const a = vol(plain.regs, f - 1, v), b = vol(plain.regs, f, v);
      if (a !== 0 || vol(soft.regs, f - 1, v) !== 0 || b <= 4 || b & 16 || !(plain.regs[f * RN + 7] & (8 << v)) || !(plain.regs[(f - 1) * RN + 7] & (8 << v))) continue;
      expect(vol(soft.regs, f, v)).toBe(b - 4);
      if (vol(plain.regs, f + 1, v) === b) expect(vol(soft.regs, f + 1, v)).toBe(b - 2);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('the touches are saved with the mapping', () => {
    const opts = { ...DEFAULT_OPTS, free: 'chorus' as const, chorusCents: 12, leadFx: 'sid' as const, soft: true, echoFrames: 7 };
    const back = parseMapping(mappingToJson({ opts, prio: {}, inst: {} }, { title: 't', kind: 'xm', channels: 4, instruments: 1 }));
    expect(back.opts).toMatchObject({ free: 'chorus', chorusCents: 12, leadFx: 'sid', soft: true, echoFrames: 7 });
  });

  it('Edit as AY patterns carries the touches: chorus notes with E1x, S / Q on lead notes, soft instruments', () => {
    const lead = convert(m, {}).leadCh;
    const notesOf = (song: ReturnType<typeof moduleToSong>['song']) => song.order.flatMap((pi) => song.patterns[pi].cells);
    const plain = moduleToSong(m, { leadCh: lead });
    const ch = moduleToSong(m, { leadCh: lead, enhance: { free: 'chorus' } });
    const E = parseEffectChar('E');
    const detuned = notesOf(ch.song).flat().filter((c) => c.note > 0 && c.note < 97 && c.effect === E && (c.param >> 4) === 1).length;
    expect(detuned).toBeGreaterThan(20);
    expect(ch.report.some((l) => /chorus of the lead \(channel 4\)/.test(l))).toBe(true);
    const sid = moduleToSong(m, { leadCh: lead, enhance: { leadFx: 'sid' } });
    const Q = parseEffectChar('Q');
    expect(notesOf(sid.song).flat().filter((c) => c.effect === Q && c.param).length).toBeGreaterThan(50);
    const r = renderSong(sid.song);
    expect(r.fx && Array.from(r.fx).filter(Boolean).length).toBeGreaterThan(500);
    expect(r.warnings.join()).not.toMatch(/several voices/);
    const soft = moduleToSong(m, { leadCh: lead, enhance: { soft: true } });
    const i = soft.song.instruments.findIndex((x, k) => k > 0 && x.seq && x.seq.steps.length > 2 && plain.song.instruments[k]?.seq?.steps[0].vol! > 4);
    expect(i).toBeGreaterThan(0);
    expect(soft.song.instruments[i].seq!.steps[0].vol).toBe(plain.song.instruments[i].seq!.steps[0].vol - 4);
    expect(soft.song.instruments[i].seq!.release).toBeGreaterThanOrEqual(4);
  });
});
