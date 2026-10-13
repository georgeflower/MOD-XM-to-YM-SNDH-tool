import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSndh } from '../src/import/sndh';
import { writeSndh } from '../src/export/sndh';
import { newSong, emptyPattern, parseEffectChar } from '../src/tracker/types';
import { renderSong } from '../src/tracker/render';
import { starterKit, compactDrums, trigCode } from '../src/core/drums';
import { fxKindOf, fxHzOf, fxVoiceOf, FX_SID, FX_SINUS, FX_SYNC } from '../src/core/fx';

const c = (note: number, instrument = 0, effect = 0, param = 0) => ({ note, instrument, volume: 0, effect, param });

describe('SNDH import: timer interrupts -> digidrums and timer effects', () => {
  it('our own SNDH with digidrums comes back with the same samples, triggers and registers', () => {
    const s = newSong(4); s.drumChannel = 3;
    s.patterns[0] = emptyPattern(32, 4);
    s.instruments[1].digiDrums = starterKit(8000);
    s.patterns[0].cells[0][0] = c(49, 1);
    s.patterns[0].cells[0][3] = c(1, 1);
    s.patterns[0].cells[8][1] = c(0, 1, parseEffectChar('Z'), 2);
    s.patterns[0].cells[16][3] = c(3, 1);
    s.patterns[0].cells[17][3] = c(2, 0);
    const r = renderSong(s);
    const d = compactDrums(r.drums!);
    const t = parseSndh(writeSndh(r.regs, r.nframes, Math.max(0, r.loopFrame), { title: 't', author: 'a', seconds: 8 }, r.drums));
    expect(t.nframes).toBe(r.nframes);
    expect(t.drums).toBeTruthy();
    expect(Array.from(t.drums!.trig)).toEqual(Array.from(d.trig));
    t.drums!.drums.forEach((g, i) => {
      expect(Array.from(g.pcm.slice(0, d.drums[i].pcm.length))).toEqual(Array.from(d.drums[i].pcm));
      expect(g.rateHz).toBeCloseTo(7979.2, 0);
    });
    for (let i = 0; i < r.nframes * 14; i++) expect(t.regs[i]).toBe(r.regs[i]);
  });

  it('our own SNDH with Q / S / U comes back as the same effects', () => {
    const s = newSong(3);
    s.patterns[0] = emptyPattern(48, 3);
    s.speed = 6; s.bpm = 125;
    s.instruments[2].useHardEnv = true; s.instruments[2].hardEnvShape = 12; s.instruments[2].hardEnvAutoPeriod = false; s.instruments[2].hardEnvPeriod = 2000;
    s.patterns[0].cells[0][0] = c(49, 1, parseEffectChar('Q'), 0x34);
    s.patterns[0].cells[8][0] = c(49, 1);
    s.patterns[0].cells[12][1] = c(49, 1, parseEffectChar('S'), 0x24);
    s.patterns[0].cells[24][1] = c(49, 1);
    s.patterns[0].cells[28][2] = c(49, 2, parseEffectChar('U'), 0x28);
    s.patterns[0].cells[40][2] = c(49, 2);
    const r = renderSong(s);
    const t = parseSndh(writeSndh(r.regs, r.nframes, Math.max(0, r.loopFrame), { title: 't', author: 'a', seconds: 12 }, r.drums, r.fx));
    expect(t.fx).toBeTruthy();
    for (let f = 0; f < r.nframes; f++) {
      expect(fxKindOf(t.fx![f])).toBe(fxKindOf(r.fx![f]));
      if (r.fx![f]) { expect(fxVoiceOf(t.fx![f])).toBe(fxVoiceOf(r.fx![f])); expect(fxHzOf(t.fx![f])).toBeCloseTo(fxHzOf(r.fx![f]), 0); }
    }
    for (let i = 0; i < r.nframes * 14; i++) expect(t.regs[i]).toBe(r.regs[i]);
  });

  it('an independently written driver (Timer B drum, Timer A swapping vectors, Timer D envelope writes)', () => {
    const t = parseSndh(new Uint8Array(readFileSync(new URL('../fixtures/timers/alt-timers.sndh', import.meta.url))));
    expect(t.nframes).toBe(200);
    const sample = [0, 3, 7, 11, 15, 14, 9, 4, 1, 2, 6, 13, 15, 12, 8, 5, 3, 1, 0, 4, 8, 12, 14, 15, 15, 13, 10, 6, 3, 1, 0, 2,
      5, 9, 12, 14, 13, 10, 7, 4, 2, 1, 0, 1, 3, 6, 9, 11, 12, 10, 8, 5, 3, 2, 1, 2, 4, 7, 9, 10, 8, 5, 3, 0];
    expect(t.drums!.drums.length).toBe(1);
    expect(Array.from(t.drums!.drums[0].pcm)).toEqual(sample);
    expect(t.drums!.drums[0].rateHz).toBeCloseTo(2_457_600 / 310, 0);
    expect(t.drums!.trig[3]).toBe(trigCode(1, 0));
    expect(t.regs[4 * 14 + 9]).toBe(0);                              // the drum voice is silent in the frame image
    // SID voice on voice A between frames 10 and 39, 1536 Hz; level 11
    expect(fxKindOf(t.fx![9])).toBe(0);
    for (const f of [10, 25, 39]) { expect(fxKindOf(t.fx![f])).toBe(FX_SID); expect(fxVoiceOf(t.fx![f])).toBe(0); expect(fxHzOf(t.fx![f])).toBeCloseTo(1536, -1); expect(t.regs[f * 14 + 8]).toBe(11); }
    expect(fxKindOf(t.fx![40])).toBe(0);
    // sync-buzzer between frames 60 and 89, 4915 Hz, shape 12 written once
    for (const f of [60, 75, 89]) { expect(fxKindOf(t.fx![f])).toBe(FX_SYNC); expect(fxHzOf(t.fx![f])).toBeCloseTo(4915, -2); }
    expect(t.regs[60 * 14 + 13]).toBe(12);
    expect(t.regs[61 * 14 + 13]).toBe(0xff);
    expect(fxKindOf(t.fx![90])).toBe(0);
    expect(FX_SINUS).toBe(2);
  });

  it('a tune without timer interrupts is unaffected', () => {
    const t = parseSndh(new Uint8Array(readFileSync(new URL('../fixtures/m68k/m68k_mix.sndh', import.meta.url))), { seconds: 10 });
    expect(t.drums).toBeUndefined();
    expect(t.fx).toBeUndefined();
  });
});
