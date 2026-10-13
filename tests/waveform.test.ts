import { describe, it, expect } from 'vitest';
import { analyseWave, buzzPeriod, buzzable, BUZZ_SHAPE } from '../src/core/waveform';
import { analyseSample } from '../src/core/samples';
import { convert } from '../src/core/convert';
import { moduleToSong } from '../src/tracker/fromModule';
import { renderSong } from '../src/tracker/render';
import { renderYm } from '../src/export/ymemu';
import { emptyCell, type Module, type Sample } from '../src/core/types';

const GENS: Record<string, (p: number) => number> = {
  square: (p) => (p < 0.5 ? 1 : -1), pulse: (p) => (p < 0.125 ? 1 : -1),
  saw: (p) => 1 - 2 * p, sawup: (p) => 2 * p - 1,
  tri: (p) => (p < 0.5 ? 4 * p - 1 : 3 - 4 * p), sine: (p) => Math.sin(2 * Math.PI * p),
};

function sample(kind: string, cycle = 64, cycles = 40, loop: 0 | 1 = 1): Sample {
  const len = Math.round(cycle * cycles);
  const data = new Float64Array(len);
  for (let i = 0; i < len; i++) data[i] = GENS[kind]((i / cycle) % 1) * 0.8;
  return { name: kind, data, ls: 0, ll: len, loop, vol: 64, fine: 0, rel: 0 };
}

describe('waveform classifier', () => {
  const cases: [string, string][] = [['square', 'square'], ['pulse', 'pulse'], ['saw', 'saw'], ['sawup', 'sawup'], ['tri', 'smooth'], ['sine', 'smooth']];
  for (const [gen, want] of cases) {
    for (const loop of [1, 0] as const) {
      it(`${gen} (${loop ? 'looped' : 'one-shot'}) -> ${want}`, () => {
        const s = sample(gen, 40.3, 40, loop);
        expect(analyseWave(s, analyseSample(s).cycle).cls).toBe(want);
      });
    }
  }
  it('noise and a rich mixture stay "complex" (plain tone)', () => {
    const noise = sample('square'); let seed = 12345;
    for (let i = 0; i < noise.data.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; noise.data[i] = seed / 2 ** 31 - 1; }
    expect(analyseSample(noise).cls).not.toBe('tonal');         // the converter only classifies the waveform of tonal samples
    const mix = sample('sine'); for (let i = 0; i < mix.data.length; i++) { const p = (i / 64) % 1; mix.data[i] = Math.sin(2 * Math.PI * p) + 0.5 * Math.sin(4 * Math.PI * p + 1) + 0.4 * Math.sin(6 * Math.PI * p + 2); }
    expect(analyseWave(mix, 64).cls).toBe('complex');
    expect(analyseWave(mix, null).cls).toBe('complex');
  });
  it('buzzer period: a saw cycle is one ramp, a triangle cycle two; high notes are out of range', () => {
    expect(buzzPeriod(100, 8)).toBeCloseTo(2e6 / (256 * 100), 6);
    expect(buzzPeriod(100, 10)).toBeCloseTo(2e6 / (512 * 100), 6);
    expect(buzzable(65, 8)).toBe(true); expect(buzzable(600, 8)).toBe(false);
    expect(buzzable(65, 10)).toBe(true); expect(buzzable(200, 10)).toBe(false);
  });
});

/** one sustained note per entry on channel 0 of a synthetic XM-style module */
function mod(kind: string, notes: { row: number; note: number }[], rows = 32): Module {
  const pat = Array.from({ length: rows }, () => Array.from({ length: 4 }, () => emptyCell()));
  notes.forEach((n, i) => { pat[n.row][0] = { ...emptyCell(), note: n.note, inst: i === 0 ? 1 : 0 }; });
  return {
    kind: 'xm', title: 't', nch: 4, order: [0], restart: 0, patterns: [pat], speed: 6, bpm: 125, amiga: false,
    instruments: [null, { name: kind, samples: [sample(kind, 64, 40)], keymap: new Array(96).fill(0), venv: [], vflags: 0, vsus: 0, vls: 0, vle: 0, fade: 0, vib: [0, 0, 0, 0] }],
  };
}
const hz = (regs: Uint8Array, f: number, v = 0) => 125000 / (regs[f * 14 + 2 * v] | ((regs[f * 14 + 2 * v + 1] & 15) << 8));

describe('frame converter: waveform -> buzzer', () => {
  it('off by default: every tonal sample is a square tone, no envelope', () => {
    const r = convert(mod('saw', [{ row: 0, note: 25 }]));
    for (let f = 0; f < r.nframes; f++) expect(r.regs[f * 14 + 8] & 16).toBe(0);
    expect(r.instruments[0].wave).toBe('saw');                 // detected and reported either way
  });

  it('a sawtooth bass becomes a buzzer: tone off, envelope at the pitch, shape written once', () => {
    const off = convert(mod('saw', [{ row: 0, note: 25 }]));
    const r = convert(mod('saw', [{ row: 0, note: 25 }]), { waveform: true });
    const f0 = 3;
    expect(r.regs[f0 * 14 + 8] & 16).toBe(16);
    expect(r.regs[f0 * 14 + 7] & 0x09).toBe(0x09);             // tone A and noise A both off
    const ep = r.regs[f0 * 14 + 11] | (r.regs[f0 * 14 + 12] << 8);
    const toneHz = hz(off.regs, f0);                           // the pitch the square version plays
    expect(2e6 / (256 * ep)).toBeGreaterThan(toneHz * 0.99); expect(2e6 / (256 * ep)).toBeLessThan(toneHz * 1.01);
    const shapes: number[] = [];
    for (let f = 0; f < r.nframes; f++) if (r.regs[f * 14 + 13] !== 0xff) shapes.push(f);
    expect(shapes).toEqual([0 + (shapes[0] ?? 0)]);            // exactly one write (note start)
    expect(r.regs[shapes[0] * 14 + 13]).toBe(8);
    expect(r.instruments[0].buzz).toBe(true);
  });

  it('rising saw and triangle pick their own shapes; the triangle needs half the period', () => {
    const shapeOf = (kind: string) => { const r = convert(mod(kind, [{ row: 0, note: 25 }]), { waveform: true }); for (let f = 0; f < r.nframes; f++) if (r.regs[f * 14 + 8] & 16) return r.regs[f * 14 + 13]; return -1; };
    expect(shapeOf('sawup')).toBe(12);
    expect(shapeOf('tri')).toBe(10);
    expect(shapeOf('sine')).toBe(10);
    expect(shapeOf('square')).toBe(-1);
  });

  it('notes too high for the buzzer stay square tones', () => {
    const r = convert(mod('saw', [{ row: 0, note: 61 }]), { waveform: true });
    for (let f = 0; f < r.nframes; f++) expect(r.regs[f * 14 + 8] & 16).toBe(0);
    expect(r.instruments[0].buzz).toBeFalsy();
  });

  it('an instrument can be forced either way', () => {
    const forcedOff = convert(mod('saw', [{ row: 0, note: 25 }]), { waveform: true, inst: { 1: { mode: 'auto', wave: 'tone' } } });
    for (let f = 0; f < forcedOff.nframes; f++) expect(forcedOff.regs[f * 14 + 8] & 16).toBe(0);
    const forcedOn = convert(mod('square', [{ row: 0, note: 25 }]), { inst: { 1: { mode: 'auto', wave: 'saw' } } });
    expect(forcedOn.regs[3 * 14 + 8] & 16).toBe(16);
  });

  it('a new note restarts the envelope; a held note does not', () => {
    const r = convert(mod('saw', [{ row: 0, note: 25 }, { row: 8, note: 25 }]), { waveform: true });
    const writes: number[] = [];
    for (let f = 0; f < r.nframes; f++) if (r.regs[f * 14 + 13] !== 0xff) writes.push(f);
    expect(writes.length).toBe(2);
    expect(writes[1]).toBe(48);
  });
});

/** fundamental frequency from the autocorrelation peak of rendered audio (30 .. 800 Hz) */
function f0(x: ArrayLike<number>, rate: number): number {
  let best = 0, bl = 1;
  for (let lag = Math.floor(rate / 800); lag < rate / 30; lag++) {
    let a = 0;
    for (let i = 4000; i < 24000 && i + lag < x.length; i++) a += x[i] * x[i + lag];
    if (a > best) { best = a; bl = lag; }
  }
  return rate / bl;
}

describe('waveform -> buzzer in the emulated chip and in the pattern editor', () => {
  it('the buzzer sounds at the pitch of the square tone it replaces', () => {
    const m = mod('saw', [{ row: 0, note: 30 }]);
    const sq = convert(m), bz = convert(m, { waveform: true });
    const a = f0(renderYm(sq.regs, sq.nframes, 44100, 50, 4), 44100), b = f0(renderYm(bz.regs, bz.nframes, 44100, 50, 4), 44100);
    expect(b / a).toBeGreaterThan(0.99); expect(b / a).toBeLessThan(1.01);
  });

  it('pattern editor: a sustained saw becomes a buzzer instrument that plays the same pitch', () => {
    const m = mod('saw', [{ row: 0, note: 30 }]);
    const r = moduleToSong(m, { waveform: true });
    const inst = r.song.instruments.find((x) => x.useHardEnv);
    expect(inst).toBeTruthy();
    expect(inst!.hardEnvShape).toBe(BUZZ_SHAPE.saw);
    expect(inst!.seq!.steps.every((x) => !x.tone)).toBe(true);
    const rd = renderSong(r.song);
    const bz = convert(m, { waveform: true });
    const f = 6;
    expect(rd.regs[f * 14 + 8] & 16).toBe(16);
    const ep = rd.regs[f * 14 + 11] | (rd.regs[f * 14 + 12] << 8), ep2 = bz.regs[f * 14 + 11] | (bz.regs[f * 14 + 12] << 8);
    expect(ep / ep2).toBeGreaterThan(0.98); expect(ep / ep2).toBeLessThan(1.02);
    const off = moduleToSong(m, {});
    expect(off.song.instruments.some((x) => x.useHardEnv)).toBe(false);
  });

  it('pattern editor: a triangle is written an octave up (its envelope cycle is two ramps) and still sounds at the pitch', () => {
    const m = mod('tri', [{ row: 0, note: 25 }]);
    const r = moduleToSong(m, { waveform: true });
    const inst = r.song.instruments.find((x) => x.useHardEnv)!;
    expect(inst.hardEnvShape).toBe(10);
    const rd = renderSong(r.song), bz = convert(m, { waveform: true });
    const f = 6;
    const ep = rd.regs[f * 14 + 11] | (rd.regs[f * 14 + 12] << 8), ep2 = bz.regs[f * 14 + 11] | (bz.regs[f * 14 + 12] << 8);
    // the written note is an octave up, so the renderer's saw-sized period is the converter's triangle period
    expect(ep / ep2).toBeGreaterThan(0.97); expect(ep / ep2).toBeLessThan(1.03);
  });
});
