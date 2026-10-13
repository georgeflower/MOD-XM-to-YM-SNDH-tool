import { describe, it, expect } from 'vitest';
import { newSong, emptyPattern, parseEffectChar, NOTE_OFF } from '../src/tracker/types';
import { renderSong } from '../src/tracker/render';
import { renderYm } from '../src/export/ymemu';
import {
  fxParamHz, fxRate, fxSetting, FX_SID, FX_SINUS, FX_SYNC, fxKindOf, fxVoiceOf, fxHzOf, fxEvents, sinusLevel, SIN32, hasFx,
} from '../src/core/fx';

const cell = (note: number, instrument = 0, effect = 0, param = 0) => ({ note, instrument, volume: 0, effect, param });

describe('timer effects: model', () => {
  it('maps the parameter like the YM Tracker', () => {
    expect(fxParamHz(0)).toBe(0);
    expect(fxParamHz(0x04)).toBeCloseTo(20 * 16, 6);
    expect(fxParamHz(0x24)).toBeCloseTo(20 * Math.pow(2, 4 + 2 / 16), 6);
    expect(fxParamHz(0x80)).toBeCloseTo(20 * Math.pow(2, 8 / 16), 6);
  });
  it('quantises to MFP rates and flags what cannot be reached', () => {
    const r = fxRate(1000);
    expect(Math.abs(Math.log(r.hz / 1000))).toBeLessThan(0.02);
    expect(fxRate(1e9).hz).toBeLessThanOrEqual(20000);
    expect(fxRate(1).hz).toBeGreaterThanOrEqual(48);
    expect(fxSetting(FX_SID, 0, 0x24)!.clamped).toBe(false);
    expect(fxSetting(FX_SID, 0, 0xff)!.clamped).toBe(true);      // way beyond the MFP
    expect(fxSetting(FX_SID, 0, 0)).toBeNull();
    // the sinus interrupt runs 32x faster, the musical rate stays
    const s = fxSetting(FX_SINUS, 1, 0x04)!;
    expect(s.hz).toBeCloseTo(320, -1);
  });
  it('sinus table and level', () => {
    expect(SIN32.length).toBe(32);
    expect(SIN32.slice(0, 16).join()).toBe('0,3,6,8,11,12,14,15,15,15,14,12,11,8,6,3');
    expect(SIN32.slice(16).every((x) => x === 0)).toBe(true);
    expect(sinusLevel(8, 15)).toBe(15);
    expect(sinusLevel(40, 15)).toBe(0);
    expect(sinusLevel(8, 7)).toBe(7);
  });
  it('events: changes only, loop point restated', () => {
    const t = new Uint32Array([0, 5, 5, 5, 0, 0]);
    expect(fxEvents(t, 6, 0).map((e) => e.frame)).toEqual([1, 4]);
    // loop at 2 while the song ends silent: the loop frame must say "5 again"
    expect(fxEvents(t, 6, 2)).toEqual([{ frame: 1, state: 5 }, { frame: 2, state: 5 }, { frame: 4, state: 0 }]);
    // loop at 0 with the effect running at the end: frame 0 must say "stop"
    expect(fxEvents(new Uint32Array([0, 7, 7]), 3, 0)).toEqual([{ frame: 0, state: 0 }, { frame: 1, state: 7 }]);
  });
});

describe('timer effects: renderer', () => {
  function song() {
    const s = newSong(3);
    s.patterns[0] = emptyPattern(16, 3);
    s.speed = 6; s.bpm = 125;
    return s;
  }
  it('Q starts on the row, Q00 / a new note ends it', () => {
    const s = song();
    s.patterns[0].cells[0][0] = cell(49, 1, parseEffectChar('Q'), 0x24);
    s.patterns[0].cells[4][0] = cell(0, 0, parseEffectChar('Q'), 0);
    s.patterns[0].cells[6][0] = cell(49, 1, parseEffectChar('S'), 0x04);
    s.patterns[0].cells[10][0] = cell(51, 1);
    const r = renderSong(s);
    expect(hasFx(r.fx)).toBe(true);
    const k = (f: number) => fxKindOf(r.fx![f]);
    expect(k(0)).toBe(FX_SID); expect(fxVoiceOf(r.fx![0])).toBe(0);
    expect(k(23)).toBe(FX_SID);
    expect(k(24)).toBe(0);                   // row 4 (24 frames at 6 frames per row): Q00
    expect(k(36)).toBe(FX_SINUS);            // row 6
    expect(k(59)).toBe(FX_SINUS);
    expect(k(60)).toBe(0);                   // row 10: a plain new note
    expect(fxHzOf(r.fx![0])).toBeGreaterThan(335); expect(fxHzOf(r.fx![0])).toBeLessThan(360);
    expect(r.warnings.filter((w) => /not rendered/.test(w))).toEqual([]);
  });
  it('one timer: a second voice is ignored with a warning, the first keeps running', () => {
    const s = song();
    s.patterns[0].cells[0][1] = cell(49, 1, parseEffectChar('U'), 0x30);
    s.patterns[0].cells[2][0] = cell(52, 1, parseEffectChar('Q'), 0x20);
    const r = renderSong(s);
    expect(r.warnings.some((w) => /one runs at a time/.test(w))).toBe(true);
    expect(fxVoiceOf(r.fx![20])).toBe(1); expect(fxKindOf(r.fx![20])).toBe(FX_SYNC);
  });
  it('a silent voice has no effect; NOTE_OFF drops the voice volume', () => {
    const s = song();
    s.patterns[0].cells[0][0] = cell(49, 1, parseEffectChar('Q'), 0x24);
    s.patterns[0].cells[8][0] = cell(NOTE_OFF);
    const r = renderSong(s);
    expect(fxKindOf(r.fx![0])).toBe(FX_SID);
    // after the key off the instrument releases to silence; the effect disappears with the sound
    expect(fxKindOf(r.fx![r.nframes - 1])).toBe(0);
  });
});

describe('timer effects: preview emulator', () => {
  const n = 30;
  function base(volReg: number) {
    const regs = new Uint8Array(n * 14);
    for (let f = 0; f < n; f++) { regs[f * 14] = 40; regs[f * 14 + 7] = 0b00111110; regs[f * 14 + 8] = volReg; regs[f * 14 + 13] = 0xff; }
    return regs;
  }
  const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
  it('SID voice pulses the volume; no effect = steady tone', () => {
    const regs = base(12);
    const fx = new Uint32Array(n);
    const set = fxSetting(FX_SID, 0, 0x34)!;
    for (let f = 0; f < n; f++) fx[f] = ((FX_SID << 16) | (0 << 12) | (set.code << 8) | set.count) >>> 0;
    const dry = renderYm(regs, n), wet = renderYm(regs, n, 44100, 50, 4, null, fx);
    expect(rms(dry)).toBeGreaterThan(0.01);
    expect(rms(wet)).toBeGreaterThan(0.002);
    expect(rms(wet)).toBeLessThan(rms(dry) * 0.95);        // half the time the voice is off
    let diff = 0; for (let i = 0; i < dry.length; i++) diff += Math.abs(dry[i] - wet[i]);
    expect(diff).toBeGreaterThan(1);
  });
  it('sync-buzzer restarts the envelope at the timer rate', () => {
    const regs = base(0x10);
    for (let f = 0; f < n; f++) { regs[f * 14 + 7] = 0xff; regs[f * 14 + 11] = 20; }
    regs[13] = 0x0c; regs[13 + 0] = 0x0c;               // shape in frame 0
    const fx = new Uint32Array(n);
    const set = fxSetting(FX_SYNC, 0, 0x04)!;           // 320 Hz
    for (let f = 0; f < n; f++) fx[f] = ((FX_SYNC << 16) | (0 << 12) | (set.code << 8) | set.count) >>> 0;
    const wet = renderYm(regs, n, 44100, 50, 4, null, fx), dry = renderYm(regs, n);
    // with restarts the envelope never gets past its first steps: a 320 Hz sawtooth
    const zc = (a: Float32Array) => { let c = 0; for (let i = 1; i < a.length; i++) if (a[i - 1] < 0 !== a[i] < 0) c++; return c; };
    expect(rms(wet)).toBeGreaterThan(0.001);
    expect(zc(wet)).not.toBe(zc(dry));
  });
});

import { packStream, unpackStream } from '../src/export/stream';
import { starterKit, trigCode } from '../src/core/drums';
describe('timer effects: stream', () => {
  it('events survive pack/unpack, together with drum triggers', () => {
    const n = 60, regs = new Uint8Array(n * 14);
    for (let f = 0; f < n; f++) { regs[f * 14 + 7] = 0xff; regs[f * 14 + 13] = 0xff; regs[f * 14] = f; }
    const mk = (kind: number, voice: number, code: number, count: number) => ((kind << 16) | (voice << 12) | (code << 8) | count) >>> 0;
    const fx = new Uint32Array(n);
    for (let f = 5; f < 20; f++) fx[f] = mk(1, 0, 3, 200);
    for (let f = 30; f < 45; f++) fx[f] = mk(2, 2, 5, 17);
    const trig = new Uint8Array(n); trig[5] = trigCode(1, 0); trig[7] = trigCode(2, 1); trig[30] = trigCode(0, 0);
    const track = { drums: starterKit(), trig };
    for (const loop of [0, 10, 32]) {
      const p = packStream(regs, n, loop, track, fx);
      const t2 = new Uint8Array(n), f2 = new Uint32Array(n);
      const back = unpackStream(p.data, n, t2, f2);
      expect(Array.from(back)).toEqual(Array.from(regs));
      expect(Array.from(t2)).toEqual(Array.from(trig));
      // the unpacked state equals the track, except that the restated loop frame may differ at most there
      expect(Array.from(f2)).toEqual(Array.from(fx));
    }
  });
  it('streams without effects are byte-identical to before', () => {
    const n = 20, regs = new Uint8Array(n * 14);
    for (let f = 0; f < n; f++) { regs[f * 14 + 7] = 0xff; regs[f * 14 + 13] = 0xff; regs[f * 14 + 1] = f & 3; }
    expect(Array.from(packStream(regs, n, 0, null, new Uint32Array(n)).data)).toEqual(Array.from(packStream(regs, n, 0).data));
  });
});

import { writeYm6 } from '../src/export/ym';
import { parseYm } from '../src/import/ym';
import { writeSndh } from '../src/export/sndh';
import { gameKitFiles } from '../src/export/gamekit';
import { FX_SINUS as SINUS, packFx } from '../src/core/fx';

describe('timer effects: exports', () => {
  function fxSong() {
    const n = 40, regs = new Uint8Array(n * 14);
    for (let f = 0; f < n; f++) { regs[f * 14 + 7] = 0b00111110; regs[f * 14 + 8] = 12; regs[f * 14 + 9] = 10; regs[f * 14 + 13] = 0xff; regs[f * 14] = 50; }
    regs[10 * 14 + 13] = 12;                              // envelope shape written once
    const fx = new Uint32Array(n);
    const q = fxSetting(FX_SID, 0, 0x34)!, s = fxSetting(SINUS, 1, 0x24)!, u = fxSetting(FX_SYNC, 0, 0x28)!;
    for (let f = 4; f < 14; f++) fx[f] = packFx(q);
    for (let f = 16; f < 26; f++) fx[f] = packFx(s);
    for (let f = 28; f < 38; f++) fx[f] = packFx(u);
    return { n, regs, fx, q, s, u };
  }
  it('YM6 writes the effect slots and the importer reads them back', () => {
    const { n, regs, fx, q, s } = fxSong();
    const y = writeYm6(regs, n, 0, null, 't', 'a', 'c', 50, fx);
    const t = parseYm(y.data);
    expect(t.fx).toBeTruthy();
    for (let f = 0; f < n; f++) expect(fxKindOf(t.fx![f])).toBe(fxKindOf(fx[f]));
    expect(fxVoiceOf(t.fx![20])).toBe(1);
    expect(fxHzOf(t.fx![5])).toBeCloseTo(q.hz, 0);
    expect(fxHzOf(t.fx![20])).toBeCloseTo(s.hz, 0);
    // registers survive (R8 prescaler bits stripped)
    expect(t.regs[5 * 14 + 8]).toBe(12);
    // the sync-buzzer frames carry the shape: written once in the imported registers
    expect(t.regs[28 * 14 + 13]).toBe(12);
    expect(t.regs[29 * 14 + 13]).toBe(0xff);
  });
  it('SNDH and game kit grow the engine only with effects', () => {
    const { n, regs, fx } = fxSong();
    const a = writeSndh(regs, n, 0, { title: 't', author: 'a' }), b = writeSndh(regs, n, 0, { title: 't', author: 'a' }, null, fx);
    expect(b.length).toBeGreaterThan(a.length);               // events in the stream
    const files = gameKitFiles('song', regs, n, 0, null, fx);
    const h = files.find((f) => f.name === 'ymplay.h')!.data;
    expect(h).toContain('ymfx_start');
    expect(h).toContain('ymplay_fxev');
    const plain = gameKitFiles('song', regs, n, 0).find((f) => f.name === 'ymplay.h')!.data;
    expect(plain).not.toContain('ymfx_start');
    expect(plain).not.toContain('ymdrum_init');
  });
});
