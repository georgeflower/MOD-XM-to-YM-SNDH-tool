import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadModule } from '../src/core/load';
import { convert } from '../src/core/convert';
import { moduleToSong } from '../src/tracker/fromModule';
import { renderSong } from '../src/tracker/render';

const mod = () => loadModule(new Uint8Array(readFileSync(new URL('../src/assets/back_in_town_again.mod', import.meta.url))));

/** per voice: median tone frequency and number of noise frames, from a register dump */
function stats(regs: Uint8Array, nf: number) {
  return [0, 1, 2].map((v) => {
    const per: number[] = []; let noise = 0;
    for (let f = 0; f < nf; f++) {
      const b = f * 14;
      if (!(regs[b + 8 + v] & 31)) continue;
      if (!(regs[b + 7] & (1 << v))) per.push(regs[b + 2 * v] | ((regs[b + 2 * v + 1] & 15) << 8));
      if (!(regs[b + 7] & (8 << v))) noise++;
    }
    per.sort((a, b) => a - b);
    return { hz: per.length ? 125000 / per[per.length >> 1] : 0, noise };
  });
}

describe('middle voice layout (bass + drums on B)', () => {
  it('frame converter: bass and the most noise end up on voice B, melody on A and C', () => {
    const m = mod();
    const r = convert(m, { middleLayout: true });
    const [a, b, c] = stats(r.regs, r.nframes);
    expect(b.hz).toBeLessThan(a.hz); expect(b.hz).toBeLessThan(c.hz);
    expect(b.noise).toBeGreaterThanOrEqual(Math.max(a.noise, c.noise));
  });

  it('pattern editor conversion: same layout', () => {
    const m = mod();
    const r = renderSong(moduleToSong(m, { middleLayout: true }).song);
    const [a, b, c] = stats(r.regs, r.nframes);
    expect(b.hz).toBeLessThan(a.hz); expect(b.hz).toBeLessThan(c.hz);
    expect(b.noise).toBeGreaterThanOrEqual(Math.max(a.noise, c.noise));
  });

  it('is off by default: the plain allocation is unchanged', () => {
    const m = mod();
    const a = convert(m, {}), b = convert(m, { middleLayout: false });
    expect(Buffer.from(a.regs).equals(Buffer.from(b.regs))).toBe(true);
  });

  it('keeps the same amount of music (voice-frames played) as the plain allocation, within a few percent', () => {
    const m = mod();
    const a = convert(m, {}), b = convert(m, { middleLayout: true });
    const sum = (x: number[]) => x.reduce((p, q) => p + q, 0);
    expect(Math.abs(sum(b.played) - sum(a.played)) / sum(a.played)).toBeLessThan(0.05);
  });
});
