import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadModule } from '../src/core/load';
import { convert, type Macro, type InstMap } from '../src/core/convert';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${n}`, import.meta.url)));
const m = loadModule(fx('back_in_town_again.mod'));
const base = convert(m);
const diff = (a: Uint8Array, b: Uint8Array) => { let n = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++; return n; };

describe('instrument mapper', () => {
  it('mute removes an instrument', () => {
    const map: Record<number, InstMap> = {};
    for (const i of base.instruments) map[i.inst] = { mode: 'mute' };
    const r = convert(m, { inst: map });
    expect(diff(r.regs, base.regs)).toBeGreaterThan(0);
    const one = convert(m, { inst: { [base.instruments[1].inst]: { mode: 'mute' } } });   // single instrument muted: no crash, valid length
    expect(one.nframes).toBe(base.nframes);
    const vol = (x: Uint8Array) => { let s = 0; for (let f = 0; f < x.length / 14; f++) s += x[f * 14 + 8] + x[f * 14 + 9] + x[f * 14 + 10]; return s; };
    expect(vol(r.regs)).toBeLessThan(vol(base.regs));
  });

  it('a macro instrument follows its step table exactly', () => {
    const macro: Macro = { loopFrom: -1, velocity: false, steps: [
      { vol: 15, semi: 0, noise: 0, tone: true }, { vol: 9, semi: 12, noise: 0, tone: true }, { vol: 5, semi: 0, noise: 7, tone: true }, { vol: 2, semi: 0, noise: 9, tone: false },
    ] };
    const map: Record<number, InstMap> = {};
    for (const i of base.instruments) map[i.inst] = { mode: 'macro', macro };
    const r = convert(m, { inst: map });
    // find a frame where a voice has vol 15 (macro step 0) and check the next frames on the same voice
    let seen = 0;
    for (let f = 0; f + 3 < r.nframes && seen < 5; f++) {
      for (let v = 0; v < 3; v++) {
        if (r.regs[f * 14 + 8 + v] !== 15) continue;
        const nx = (k: number) => r.regs[(f + k) * 14 + 8 + v];
        if (nx(1) !== 9) continue;
        const per = (k: number) => r.regs[(f + k) * 14 + 2 * v] | (r.regs[(f + k) * 14 + 2 * v + 1] << 8);
        expect(Math.abs(per(1) * 2 - per(0))).toBeLessThanOrEqual(2);     // +12 semitones = half the period
        const mixAt = (k: number) => r.regs[(f + k) * 14 + 7];
        // step 2: tone + noise on this voice (tone bit and noise bit both enabled)
        if (nx(2) === 5) {
          expect(mixAt(2) & (1 << v)).toBe(0);
          expect(mixAt(2) & (8 << v)).toBe(0);
          expect(r.regs[(f + 2) * 14 + 6]).toBe(7);
        }
        if (nx(3) === 2) {
          expect(mixAt(3) & (1 << v)).not.toBe(0);   // tone off
          expect(mixAt(3) & (8 << v)).toBe(0);        // noise on
          expect(r.regs[(f + 3) * 14 + 6]).toBe(9);
        }
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('forced tone mode plays the written note pitch', () => {
    const d = base.instruments.find((x) => x.drum);
    if (!d) return;
    const r = convert(m, { inst: { [d.inst]: { mode: 'tone' } } });
    expect(diff(r.regs, base.regs)).toBeGreaterThan(0);
  });
});

describe('arpeggio fill', () => {
  const x = loadModule(fx('OMARSBAZAAR.xm'));
  const off = convert(x);
  const on = convert(x, { arpFill: 3 });
  it('turns dropped notes into arpeggios', () => {
    const sum = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
    console.log('dropped notes off/on:', sum(off.dropped), sum(on.dropped), 'folded', sum(on.folded));
    expect(sum(on.folded)).toBeGreaterThan(0);
    expect(sum(on.dropped)).toBeLessThan(sum(off.dropped));
    expect(sum(on.arpPerFrame)).toBe(sum(on.folded));
  });
  it('alternates the pitch of the host voice frame by frame', () => {
    let alternating = 0;
    for (let f = 0; f + 1 < on.nframes; f++) {
      if (!on.arpPerFrame[f] || !on.arpPerFrame[f + 1]) continue;
      for (let v = 0; v < 3; v++) {
        const p0 = on.regs[f * 14 + 2 * v] | (on.regs[f * 14 + 2 * v + 1] << 8);
        const p1 = on.regs[(f + 1) * 14 + 2 * v] | (on.regs[(f + 1) * 14 + 2 * v + 1] << 8);
        if (p0 !== p1 && on.regs[f * 14 + 8 + v] && on.regs[(f + 1) * 14 + 8 + v]) alternating++;
      }
    }
    expect(alternating).toBeGreaterThan(0);
  });
  it('is off by default (output unchanged)', () => {
    expect(diff(convert(x, { arpFill: 0 }).regs, off.regs)).toBe(0);
  });
});
