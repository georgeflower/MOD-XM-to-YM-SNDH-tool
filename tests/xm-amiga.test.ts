import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseXm } from '../src/core/xm';
import { replay } from '../src/core/replay';
import { convert } from '../src/core/convert';
import { moduleToSong } from '../src/tracker/fromModule';
import { renderSong } from '../src/tracker/render';
import { xmAmigaPeriodOf, xmAmigaRateOf, xmPeriodOf, xmRateOf } from '../src/core/pitch';
import type { Module } from '../src/core/types';

const orig = new Uint8Array(readFileSync(new URL('../fixtures/OMARSBAZAAR.xm', import.meta.url)));
/** the same file saved with the Amiga frequency table (header flags bit 0 clear) */
function amigaXm(): Uint8Array { const b = orig.slice(); b[74] &= 0xfe; return b; }

describe('XM with the Amiga frequency table', () => {
  it('loads (it used to be refused) and is flagged', () => {
    expect(parseXm(orig).xmAmiga).toBe(false);
    const m = parseXm(amigaXm());
    expect(m.xmAmiga).toBe(true);
    expect(m.amiga).toBe(false);
  });

  it('plays the same pitches as the linear table (equal temperament, 8363 Hz at C-4)', () => {
    for (const n of [0, 12, 33, 48, 60, 80, 95]) for (const fine of [-100, 0, 64]) {
      expect(xmAmigaRateOf(xmAmigaPeriodOf(n, fine)) / xmRateOf(xmPeriodOf(n, fine))).toBeCloseTo(1, 9);
    }
    const a = replay(parseXm(orig), { maxTicks: 400 }), b = replay(parseXm(amigaXm()), { maxTicks: 400 });
    expect(b.frames.length).toBe(a.frames.length);
    let checked = 0;
    for (let f = 0; f < a.frames.length; f++) for (let c = 0; c < a.frames[f].length; c++) {
      const x = a.frames[f][c], y = b.frames[f][c];
      expect(!!x).toBe(!!y);
      if (x && y) { expect(y.noteRate / x.noteRate).toBeCloseTo(1, 6); checked++; }
    }
    expect(checked).toBeGreaterThan(100);
  });

  /** one note, then 1xx on the next row: the Amiga table slides in period steps (pitch-dependent), the linear one in 1/192 octave steps */
  function slideTest(m: Module, note: number) {
    const inst = m.instruments.findIndex((i) => i && i.samples.length);
    const ins = m.instruments[inst]!;
    ins.vib[2] = 0;                                    // no instrument auto-vibrato
    for (const sm of ins.samples) { sm.rel = 0; sm.fine = 0; }
    const pat = m.patterns[m.order[0]];
    for (const row of pat) for (const c of row) { c.note = 0; c.inst = 0; c.vol = 0; c.eff = 0; c.par = 0; }
    pat[0][0].note = note; pat[0][0].inst = inst;
    pat[1][0].eff = 1; pat[1][0].par = 4;
    const r = replay(m, { maxTicks: 40 });
    const row1 = r.rows[1];
    const last = r.frames[row1.frame + row1.len - 1][0]!;
    return last.rate / last.noteRate;
  }

  it('slides in period units: 1xx 4 for 5 ticks', () => {
    const lin = slideTest(parseXm(orig), 49), ami = slideTest(parseXm(amigaXm()), 49);
    expect(lin).toBeCloseTo(Math.pow(2, 80 / 768), 3);     // 5 ticks x 4 x 4 units of 1/768 octave
    expect(ami).toBeCloseTo(428 / (428 - 20), 3);          // 5 ticks x 4 on the 4x scale = 5 ticks x 1 on the ProTracker scale
  });

  it('a high note slides faster than a low one (the Amiga table is not logarithmic)', () => {
    const hi = slideTest(parseXm(amigaXm()), 73), lo = slideTest(parseXm(amigaXm()), 25);
    expect(Math.log(hi)).toBeGreaterThan(Math.log(lo) * 3);
  });

  it('converts to YM registers and to a pattern song', () => {
    const m = parseXm(amigaXm());
    const r = convert(m, {});
    expect(r.nframes).toBeGreaterThan(500);
    const s = moduleToSong(m, {});
    expect(renderSong(s.song).nframes).toBeGreaterThan(500);
  });
});
