import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSndh, parseSndhHeader, detectLoop, isSndh } from '../src/import/sndh';
import { iceDepack, isIce } from '../src/import/ice';
import { writeSndh } from '../src/export/sndh';
import { loadModule } from '../src/core/load';
import { convert } from '../src/core/convert';
import { M68k } from '../src/import/m68k';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${n}`, import.meta.url)));

/** register image comparison: R0-R12, R7 bits 6/7 are forced on by the importer */
function diffFrames(a: Uint8Array, b: Uint8Array, n: number): number {
  let bad = 0;
  for (let f = 0; f < n; f++) {
    for (let k = 0; k < 13; k++) {
      const x = k === 7 ? a[f * 14 + k] | 0xc0 : a[f * 14 + k];
      const y = k === 7 ? b[f * 14 + k] | 0xc0 : b[f * 14 + k];
      if (x !== y) { bad++; break; }
    }
  }
  return bad;
}

describe('68000 core vs. psgplay (Musashi) register traces', () => {
  for (const v of ['alu', 'mix']) {
    it(`m68k_${v}.sndh: 3005 frames identical`, () => {
      const ref = fx(`m68k/m68k_${v}.psgplay.regs`);
      const t = parseSndh(fx(`m68k/m68k_${v}.sndh`), { seconds: 60 });
      expect(ref.length / 14).toBe(3005);
      expect(t.nframes).toBe(3000);
      expect(diffFrames(t.regs, ref, 3000)).toBe(0);
    });
  }
});

describe('SNDH import', () => {
  const mod = loadModule(fx('back_in_town_again.mod'));
  const res = convert(mod, {});
  const sndh = writeSndh(res.regs, res.nframes, res.loopFrame, { title: 'Back in town', author: 'Tester' });

  it('reads the header tags', () => {
    const h = parseSndhHeader(sndh);
    expect(h.title).toBe('Back in town');
    expect(h.author).toBe('Tester');
    expect(h.subtunes).toBe(1);
    expect(h.durations[0]).toBe(77);
    expect(h.rateHz).toBe(50);
  });
  it('round-trips our own SNDH export (registers identical)', () => {
    const t = parseSndh(sndh);
    expect(t.nframes).toBeGreaterThanOrEqual(res.nframes);
    expect(diffFrames(t.regs, res.regs, res.nframes)).toBe(0);
    expect(t.title).toBe('Back in town');
  });
  it('unpacks ICE! and imports it', () => {
    const packed = fx('ice/bita.sndh.ice');
    expect(isIce(packed)).toBe(true);
    const plain = fx('ice/bita.sndh');
    expect(Buffer.from(iceDepack(packed)).equals(Buffer.from(plain))).toBe(true);
    expect(isSndh(packed)).toBe(true);
    const a = parseSndh(packed), b = parseSndh(plain);
    expect(diffFrames(a.regs, b.regs, b.nframes)).toBe(0);
  });
  it('detects a loop when the rendered time covers it several times', () => {
    const n = 120, loop = 40;
    const regs = new Uint8Array(n * 14);
    let seed = 5;
    for (let f = 0; f < n; f++) for (let k = 0; k < 13; k++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; regs[f * 14 + k] = (seed >> 6) & 15; }
    const s = writeSndh(regs, n, loop, { title: 't', author: 'a', seconds: 20 });
    const t = parseSndh(s);
    expect(t.nframes).toBe(n);
    expect(t.loopFrame).toBe(loop);
    const un = detectLoop(new Uint8Array(100 * 14).map((_, i) => (i * 7) & 15), 100);
    expect(un.loopFrame).toBe(0);
  });
});

describe('M68k basics', () => {
  it('runs a tiny routine', () => {
    const cpu = new M68k({ ioRead: () => 0, ioWrite: () => {} });
    // moveq #5,d0 ; addq.l #3,d0 ; rts
    cpu.mem.set([0x70, 0x05, 0x56, 0x80, 0x4e, 0x75], 0x1000);
    cpu.a[7] = 0x2000; cpu.wr32(0x2000, 0x400); cpu.pc = 0x1000;
    expect(cpu.run(0x400, 100)).toBe(true);
    expect(cpu.d[0]).toBe(8);
  });
});
