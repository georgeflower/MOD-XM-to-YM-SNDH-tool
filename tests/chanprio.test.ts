import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadModule } from '../src/core/load';
import { convert } from '../src/core/convert';
import { moduleToSong } from '../src/tracker/fromModule';
import { PRIO_OFF } from '../src/core/replay';
import { channelStats, suggestPriorities, noteLabel } from '../src/core/chanstats';
import { DEFAULT_OPTS, mappingToJson, parseMapping } from '../src/core/mapping';

const m = loadModule(new Uint8Array(readFileSync(new URL('../fixtures/OMARSBAZAAR.xm', import.meta.url))));
const sum = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };

describe('manual import: channel priority, off and solo', () => {
  const base = convert(m, {});
  it('a channel set to Off is not played, the others still are', () => {
    const r = convert(m, { prio: { 0: PRIO_OFF } });
    expect(r.nframes).toBe(base.nframes);                 // timing is unchanged
    expect(r.played[0] + r.dropped[0] + r.folded[0]).toBe(0);
    expect(r.played[1]).toBeGreaterThan(0);
    expect(Buffer.from(r.regs).equals(Buffer.from(base.regs))).toBe(false);
  });
  it('solo plays one channel alone, with all three voices free for it', () => {
    const r = convert(m, { solo: 1 });
    expect(r.nframes).toBe(base.nframes);
    expect(r.played[1]).toBeGreaterThan(0);
    for (const c of [0, 2, 3]) expect(r.played[c] + r.dropped[c]).toBe(0);
    expect(sum(r.dropPerFrame)).toBeLessThan(sum(base.dropPerFrame) + 1);
  });
  it('a raised priority keeps that channel\'s notes at the others\' cost', () => {
    const lead = convert(m, { prio: { 3: 8 } });
    expect(lead.dropped[3]).toBeLessThanOrEqual(base.dropped[3]);
  });
  it('the same options drive the editable pattern import', () => {
    const off = moduleToSong(m, { prio: { 0: PRIO_OFF } });
    const solo = moduleToSong(m, { solo: 2 });
    expect(off.song.patterns.length).toBeGreaterThan(0);
    expect(solo.song.patterns.length).toBeGreaterThan(0);
    const notes = (s: typeof solo.song) => { let n = 0; for (const o of new Set(s.order)) for (const row of s.patterns[o].cells) for (let c = 0; c < 3; c++) if (row[c].note) n++; return n; };
    expect(notes(solo.song)).toBeLessThan(notes(moduleToSong(m, {}).song));
  });
  it('Off survives a saved mapping', () => {
    const json = mappingToJson({ opts: DEFAULT_OPTS, prio: { 0: PRIO_OFF, 2: 8 }, inst: {} }, { title: 't', kind: 'xm', channels: 4, instruments: 7 });
    const r = parseMapping(json, { title: 't', kind: 'xm', channels: 4, instruments: 7 });
    expect(r.prio[0]).toBe(PRIO_OFF);
    expect(r.prio[2]).toBe(8);
  });
});

describe('manual import: channel statistics', () => {
  const stats = channelStats(m);
  it('describes every channel', () => {
    expect(stats.length).toBe(m.nch);
    for (const s of stats) {
      expect(s.activeFrac).toBeGreaterThanOrEqual(0); expect(s.activeFrac).toBeLessThanOrEqual(1);
      expect(s.buckets.length).toBe(96);
      expect(s.notes).toBeGreaterThan(0);
      expect(s.insts.length).toBeGreaterThan(0);
    }
  });
  it('names notes', () => { expect(noteLabel(49)).toBe('C-4'); expect(noteLabel(58)).toBe('A-4'); });
  it('suggests one lead and leaves the rest normal', () => {
    const p = suggestPriorities(stats, { low: -3, normal: 0, lead: 8 });
    expect(Object.values(p).filter((v) => v === 8).length).toBe(1);
  });
});
