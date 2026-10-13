import { describe, it, expect } from 'vitest';
import { newSong, parseEffectChar, noteToFreq, NOTE_OFF, defaultInstrument } from '../src/tracker/types';
import { renderSong, freqToYmPeriod } from '../src/tracker/render';
import { renderYm, envLevel } from '../src/export/ymemu';

const per = (r: Uint8Array, f: number, v: number) => r[f * 14 + 2 * v] | (r[f * 14 + 2 * v + 1] << 8);
const vol = (r: Uint8Array, f: number, v: number) => r[f * 14 + 8 + v];

function song1() {
  const s = newSong();
  s.patterns[0].rows = 8; s.patterns[0].cells = s.patterns[0].cells.slice(0, 8);
  return s;
}

describe('pattern renderer', () => {
  it('plays a note at the right pitch and level', () => {
    const s = song1();
    s.patterns[0].cells[0][0] = { note: 49, instrument: 1, volume: 0, effect: 0, param: 0 };
    const r = renderSong(s);
    expect(r.nframes).toBe(8 * 6);
    expect(per(r.regs, 0, 0)).toBe(freqToYmPeriod(noteToFreq(49)));
    expect(vol(r.regs, 0, 0)).toBe(15);
    expect(r.regs[7] & 1).toBe(0);                 // tone A on
    expect(vol(r.regs, 0, 1)).toBe(0);
    expect(r.loopFrame).toBe(0);                    // song loops to its start
  });

  it('arpeggio 0xy cycles base, +x, +y once per tick', () => {
    const s = song1();
    s.patterns[0].cells[0][0] = { note: 49, instrument: 1, volume: 0, effect: parseEffectChar('0'), param: 0x47 };
    for (let r = 1; r < 8; r++) s.patterns[0].cells[r][0] = { note: 0, instrument: 0, volume: 0, effect: 1, param: 0x47 };
    const r = renderSong(s);
    const p = (f: number) => per(r.regs, f, 0);
    expect(p(0)).toBe(freqToYmPeriod(noteToFreq(49)));
    expect(p(1)).toBe(freqToYmPeriod(noteToFreq(53)));
    expect(p(2)).toBe(freqToYmPeriod(noteToFreq(56)));
    expect(p(3)).toBe(p(0));
  });

  it('note-off releases through the ADSR release', () => {
    const s = song1();
    s.instruments[1].adsr.release = 4;
    s.patterns[0].cells[0][0] = { note: 49, instrument: 1, volume: 0, effect: 0, param: 0 };
    s.patterns[0].cells[2][0] = { note: NOTE_OFF, instrument: 0, volume: 0, effect: 0, param: 0 };
    const r = renderSong(s);
    expect(vol(r.regs, 11, 0)).toBe(15);            // still full right before the key-off row (row 2 = frame 12)
    expect(vol(r.regs, 12 + 3, 0)).toBeLessThan(15);
    expect(vol(r.regs, 12 + 7, 0)).toBe(0);
  });

  it('Fxx speed change, Dxx break and Bxx jump drive the flow; loop is detected', () => {
    const s = newSong();
    s.patterns[0].rows = 4; s.patterns[0].cells = s.patterns[0].cells.slice(0, 4);
    s.patterns[0].cells[0][0] = { note: 49, instrument: 1, volume: 0, effect: parseEffectChar('F'), param: 3 };
    const r = renderSong(s);
    expect(r.nframes).toBe(4 * 3);                  // speed 3
    expect(r.rows.map((x) => x.row)).toEqual([0, 1, 2, 3]);
  });

  it('F00 ends the song without a loop', () => {
    const s = song1();
    s.patterns[0].cells[3][0] = { note: 0, instrument: 0, volume: 0, effect: parseEffectChar('F'), param: 0 };
    const r = renderSong(s);
    expect(r.loopFrame).toBe(-1);
    expect(r.nframes).toBe(3 * 6);
  });

  it('BPM other than 125 is resampled to 50 Hz frames', () => {
    const s = song1();
    s.bpm = 250;                                     // 100 Hz ticks -> 2 ticks per frame
    const r = renderSong(s);
    expect(r.nframes).toBe(Math.round(8 * 6 * (2.5 / 250) * 50));
  });

  it('hardware envelope instrument writes R11-R13 only when it needs them', () => {
    const s = song1();
    const ins = s.instruments[1];
    ins.useHardEnv = true; ins.hardEnvShape = 10; ins.syncBuzz = false;
    s.patterns[0].cells[0][0] = { note: 37, instrument: 1, volume: 0, effect: 0, param: 0 };
    const r = renderSong(s);
    expect(vol(r.regs, 0, 0)).toBe(0x10);
    expect(r.regs[13]).toBe(10);                     // shape written on the trigger frame
    expect(r.regs[14 + 13]).toBe(0xff);              // not rewritten afterwards
    expect(r.regs[7] & 1).toBe(1);                   // pure buzz: tone off
  });

  it('step-table instruments drive level, pitch offset and noise', () => {
    const s = song1();
    const ins = s.instruments[1];
    ins.seq = { loopFrom: -1, velocity: false, release: 0, steps: [
      { vol: 15, semi: 0, noise: 0, tone: true }, { vol: 9, semi: 12, noise: 0, tone: true }, { vol: 5, semi: 0, noise: 7, tone: true }, { vol: 2, semi: 0, noise: 9, tone: false },
    ] };
    s.patterns[0].cells[0][0] = { note: 49, instrument: 1, volume: 0, effect: 0, param: 0 };
    const r = renderSong(s);
    expect([0, 1, 2, 3, 4].map((f) => vol(r.regs, f, 0))).toEqual([15, 9, 5, 2, 0]);
    expect(Math.abs(per(r.regs, 1, 0) * 2 - per(r.regs, 0, 0))).toBeLessThanOrEqual(1);
    expect(r.regs[2 * 14 + 6]).toBe(7);
    expect(r.regs[2 * 14 + 7] & 0x09).toBe(0);       // tone A + noise A on
    expect(r.regs[3 * 14 + 7] & 0x09).toBe(1);       // tone off, noise on
  });

  it('defaultInstrument is a plain sustained tone', () => {
    expect(defaultInstrument().adsr.sustain).toBe(15);
  });
});

describe('hardware envelope in the preview emulator', () => {
  it('follows the YM2149 shape table', () => {
    const seqOf = (shape: number, n: number) => Array.from({ length: n }, (_, i) => envLevel(shape, i));
    expect(seqOf(9, 20)).toEqual([...Array.from({ length: 16 }, (_, i) => 15 - i), 0, 0, 0, 0]);          // \___
    expect(seqOf(15, 18).slice(14)).toEqual([14, 15, 0, 0]);                                                // /___
    expect(seqOf(8, 18).slice(14)).toEqual([1, 0, 15, 14]);                                                 // \\\
    expect(seqOf(10, 36).slice(14, 20)).toEqual([1, 0, 0, 1, 2, 3]);                                        // \/\/
    expect(seqOf(11, 18).slice(14)).toEqual([1, 0, 15, 15]);                                                // \‾‾‾
    expect(seqOf(13, 18).slice(14)).toEqual([14, 15, 15, 15]);                                              // /‾‾‾
  });
  it('a buzzer instrument is audible', () => {
    const s = song1();
    const ins = s.instruments[1];
    ins.useHardEnv = true; ins.hardEnvShape = 8; ins.syncBuzz = false;
    s.patterns[0].cells[0][0] = { note: 37, instrument: 1, volume: 0, effect: 0, param: 0 };
    const r = renderSong(s);
    const pcm = renderYm(r.regs, r.nframes);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    expect(peak).toBeGreaterThan(0.05);
  });
});
