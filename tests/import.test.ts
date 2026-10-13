import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { lhaExtract } from '../src/import/lha';
import { parseYm } from '../src/import/ym';
import { loadModule } from '../src/core/load';
import { convert } from '../src/core/convert';
import { writeYm5 } from '../src/export/ym';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${n}`, import.meta.url)));

describe('LHA / YM import', () => {
  const raw = fx('lha/bita.ym');
  for (const f of ['bita_lh5_level0', 'bita_lh5_level1', 'bita_lh5_level2', 'bita_lh7']) {
    it(`unpacks ${f}.lzh bit-exact`, () => {
      expect(Buffer.from(lhaExtract(fx(`lha/${f}.lzh`)).data).equals(Buffer.from(raw))).toBe(true);
    });
  }
  it('reads a YM5 written by this tool back to the same registers', () => {
    const m = loadModule(fx('back_in_town_again.mod'));
    const r = convert(m, {});
    const t = parseYm(writeYm5(r.regs, r.nframes, r.loopFrame, 'ttl', 'aut', 'cmt'));
    expect(t.nframes).toBe(r.nframes);
    expect(t.title).toBe('ttl'); expect(t.author).toBe('aut'); expect(t.comment).toBe('cmt');
    let bad = 0;
    for (let f = 0; f < r.nframes; f++) for (let k = 0; k < 13; k++) if (t.regs[f * 14 + k] !== r.regs[f * 14 + k]) bad++;
    expect(bad).toBe(0);
  });
  it('reads the LHA-packed copy identically to the raw one', () => {
    const a = parseYm(raw), b = parseYm(fx('lha/bita_lh5_level0.lzh'));
    expect(Buffer.from(a.regs).equals(Buffer.from(b.regs))).toBe(true);
    expect(a.nframes).toBe(3840);
  });
  it('YM3 (no header, interleaved) works', () => {
    const n = 100, d = new Uint8Array(4 + n * 14);
    d.set([0x59, 0x4d, 0x33, 0x21]);
    for (let r = 0; r < 14; r++) for (let f = 0; f < n; f++) d[4 + r * n + f] = (r * 7 + f) & 15;
    const t = parseYm(d);
    expect(t.nframes).toBe(n);
    expect(t.regs[5 * 14 + 2]).toBe((2 * 7 + 5) & 15);
  });
});
