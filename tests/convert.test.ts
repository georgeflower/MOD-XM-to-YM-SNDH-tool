import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadModule } from '../src/core/load';
import { convert } from '../src/core/convert';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${n}`, import.meta.url)));

describe('OLGIENG.XM matches the Python reference', () => {
  it('produces the same register dump', () => {
    const m = loadModule(fx('OLGIENG.XM'));
    const r = convert(m);
    const ref = fx('olgieng.ref.regs');
    expect(r.nframes).toBe(9312);
    expect(r.regs.length).toBe(ref.length);
    let bad = 0;
    for (let f = 0; f < r.nframes; f++) {
      for (let k = 0; k < 14; k++) if (r.regs[f * 14 + k] !== ref[f * 14 + k]) { bad++; break; }
    }
    console.log('frames differing from reference:', bad, 'of', r.nframes);
    expect(bad).toBe(0);
  });
});
