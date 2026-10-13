import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadModule } from '../src/core/load';
import { convert } from '../src/core/convert';
import { moduleToSong } from '../src/tracker/fromModule';
import { renderSong } from '../src/tracker/render';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${n}`, import.meta.url)));
const sum = (a: number[]) => a.reduce((p, c) => p + c, 0);

/** share of audible voice events of `a` that `b` also has in the same frame (tones within 3 % of period, noise as noise) */
function agreement(a: Uint8Array, b: Uint8Array, n: number): number {
  const set = (r: Uint8Array, f: number) => {
    const mix = r[f * 14 + 7], v: { p: number; noise: boolean }[] = [];
    for (let i = 0; i < 3; i++) {
      if (!(r[f * 14 + 8 + i] & 15)) continue;
      if (!(mix & (1 << i))) v.push({ p: r[f * 14 + 2 * i] | ((r[f * 14 + 2 * i + 1] & 15) << 8), noise: false });
      else if (!(mix & (8 << i))) v.push({ p: 0, noise: true });
    }
    return v;
  };
  let hit = 0, tot = 0;
  for (let f = 0; f < n; f++) {
    const bb = set(b, f);
    for (const x of set(a, f)) {
      tot++;
      const j = bb.findIndex((y) => (x.noise && y.noise) || (!x.noise && !y.noise && Math.abs(Math.log2(x.p / y.p)) < 0.045));
      if (j >= 0) { hit++; bb.splice(j, 1); }
    }
  }
  return hit / Math.max(1, tot);
}

describe('module -> pattern song', () => {
  const m = loadModule(fx('back_in_town_again.mod'));
  const res = moduleToSong(m);
  const ref = convert(m);
  const out = renderSong(res.song);

  it('keeps the exact length and loop point of the module', () => {
    expect(out.nframes).toBe(ref.nframes);
    expect(out.loopFrame).toBe(ref.loopFrame);
  });
  it('sounds like the frame-by-frame conversion', () => {
    const a = agreement(ref.regs, out.regs, ref.nframes);
    console.log('agreement with frame converter:', (a * 100).toFixed(1) + '%');
    expect(a).toBeGreaterThan(0.85);
  });
  it('produces a sane song structure', () => {
    const s = res.song;
    expect(s.patterns.length).toBeLessThanOrEqual(s.order.length);
    expect(s.order.every((p) => p >= 0 && p < s.patterns.length)).toBe(true);
    expect(s.instruments.length).toBeGreaterThan(2);
    expect(s.instruments.length).toBeLessThanOrEqual(256);
    for (const p of s.patterns) { expect(p.cells.length).toBe(p.rows); for (const row of p.cells) expect(row.length).toBe(s.channelCount); }
    for (const p of s.patterns) for (const row of p.cells) for (const c of row) {
      expect(c.note).toBeGreaterThanOrEqual(0); expect(c.note).toBeLessThanOrEqual(97);
      expect(c.instrument).toBeLessThan(s.instruments.length);
    }
  });
  it('arpeggio fill folds notes that would be dropped', () => {
    const a = moduleToSong(m, { arpFill: 3 });
    expect(sum(a.folded)).toBeGreaterThan(0);
    expect(sum(a.dropped)).toBeLessThan(sum(res.dropped));
    const hasArp = a.song.patterns.some((p) => p.cells.some((r) => r.some((c) => c.effect === 1 && c.param !== 0)));
    expect(hasArp).toBe(true);
    expect(renderSong(a.song).nframes).toBe(ref.nframes);
  });
  it('mute / macro mapping reaches the pattern instruments', () => {
    const first = res.instMap[0];
    const r2 = moduleToSong(m, { inst: { [first.src]: { mode: 'mute' } } });
    expect(r2.instMap.find((x) => x.src === first.src)).toBeUndefined();
    const r3 = moduleToSong(m, { inst: { [first.src]: { mode: 'macro', macro: { loopFrom: 0, velocity: true, steps: [{ vol: 15, semi: 0, noise: 0, tone: true }] } } } });
    const mi = r3.instMap.find((x) => x.src === first.src)!;
    expect(mi.kind).toBe('macro');
    expect(r3.song.instruments[mi.ay].seq!.steps.length).toBe(1);
  });
});

describe('xm with tempo and many channels', () => {
  it('converts OMARSBAZAAR.xm with the right length', () => {
    const x = loadModule(fx('OMARSBAZAAR.xm'));
    const r = moduleToSong(x, { arpFill: 3 });
    expect(renderSong(r.song).nframes).toBe(10026);
    expect(r.song.patterns.length).toBeLessThan(256);
  });
});
