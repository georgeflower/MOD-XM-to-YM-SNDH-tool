import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadModule } from '../src/core/load';
import { convert } from '../src/core/convert';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${n}`, import.meta.url)));

describe('OMARSBAZAAR.xm (demo song)', () => {
  const m = loadModule(fx('OMARSBAZAAR.xm'));
  it('loads as a 4-channel XM with 26 orders', () => {
    expect(m.nch).toBe(4);
    expect(m.order.length).toBe(26);
    expect(m.speed).toBe(6); expect(m.bpm).toBe(125);
  });
  it('converts to a stable register dump of the expected length', () => {
    const a = convert(m), b = convert(m);
    expect(a.nframes).toBe(10026);
    expect(a.loopFrame).toBe(0);
    expect(a.regs.length).toBe(a.nframes * 14);
    expect(Buffer.from(a.regs).equals(Buffer.from(b.regs))).toBe(true);
    let sounding = 0;
    for (let f = 0; f < a.nframes; f++) for (let v = 0; v < 3; v++) if (a.regs[f * 14 + 8 + v] & 31) sounding++;
    expect(sounding).toBeGreaterThan(a.nframes);          // plenty of audible voice-frames
  });
});
