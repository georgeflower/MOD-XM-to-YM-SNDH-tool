import { describe, it, expect } from 'vitest';
import { mfpRate, prepareDrum, decodeWav, synthDrum, starterKit, compactDrums, trigCode, drumFrames, DAC, type DrumTrack } from '../src/core/drums';
import { renderYm } from '../src/export/ymemu';
import { encodeWav } from '../src/export/wav';

describe('digidrum core', () => {
  it('quantises timer rates to what the MFP can do', () => {
    const r = mfpRate(8000);
    expect(r.hz).toBeGreaterThan(7900); expect(r.hz).toBeLessThan(8100);
    expect(r.hz).toBeCloseTo(2457600 / ([0, 4, 10, 16, 50, 64, 100, 200][r.code] * r.count), 6);
    expect(mfpRate(100000).hz).toBeLessThanOrEqual(24000);
    for (const hz of [4000, 6000, 11025, 16000]) expect(Math.abs(Math.log(mfpRate(hz).hz / hz))).toBeLessThan(0.02);
  });

  it('turns audio into 4-bit DAC drums', () => {
    const sr = 22050, x = new Float32Array(sr / 4).map((_, i) => Math.sin(i * 0.2));
    const d = prepareDrum('t', x, sr, { rateHz: 8000, normalize: true });
    expect(d.pcm.length).toBeGreaterThan(1500); expect(d.pcm.length).toBeLessThan(2100);
    expect(Math.max(...d.pcm)).toBe(15);
    expect(d.pcm.every((v) => v <= 15)).toBe(true);
    // reconstruct: close to the (normalised) input in amplitude terms
    const mid = d.pcm.length >> 1;
    expect(DAC[d.pcm[mid]]).toBeGreaterThanOrEqual(0);
    const kit = starterKit();
    expect(kit.length).toBe(6);
    for (const k of kit) { expect(k.pcm.length).toBeGreaterThan(200); expect(k.pcm.some((v) => v > 8)).toBe(true); }
  });

  it('reads WAV files (16-bit stereo -> mono)', () => {
    const pcm = new Float32Array(1000).map((_, i) => Math.sin(i / 10) * 0.5);
    const wav = encodeWav(pcm, 11025, false);
    const r = decodeWav(wav);
    expect(r.rate).toBe(11025);
    expect(r.data.length).toBe(1000);
    expect(r.data[100]).toBeCloseTo(pcm[100], 2);
  });

  it('renderYm plays a drum on a silent voice, then returns to the registers', () => {
    const n = 20, regs = new Uint8Array(n * 14);
    for (let f = 0; f < n; f++) regs[f * 14 + 7] = 0xff;           // everything off
    const d = synthDrum('Kick', 8000);
    const trig = new Uint8Array(n); trig[2] = trigCode(1, 0);
    const track: DrumTrack = { drums: [d], trig };
    const dry = renderYm(regs, n), wet = renderYm(regs, n, 44100, 50, 4, track);
    // renderYm removes the DC offset, so judge activity by the swing inside a frame range
    const swing = (a: Float32Array, f0: number, f1: number) => { let lo = 1e9, hi = -1e9; for (let i = f0 * 882; i < f1 * 882; i++) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); } return hi - lo; };
    expect(swing(dry, 0, n)).toBe(0);
    expect(swing(wet, 0, 2)).toBe(0);
    expect(swing(wet, 2, 2 + drumFrames(d))).toBeGreaterThan(0.05);
    expect(swing(wet, 3 + drumFrames(d), n)).toBe(0);
  });

  it('compactDrums drops unused samples and renumbers triggers', () => {
    const kit = starterKit();
    const trig = new Uint8Array(10); trig[1] = trigCode(0, 4); trig[5] = trigCode(2, 1); trig[8] = trigCode(0, 4);
    const c = compactDrums({ drums: kit, trig });
    expect(c.drums.map((d) => d.name)).toEqual([kit[4].name, kit[1].name]);
    expect(c.trig[1]).toBe(trigCode(0, 0)); expect(c.trig[5]).toBe(trigCode(2, 1)); expect(c.trig[8]).toBe(trigCode(0, 0));
  });
});

import { readFileSync } from 'node:fs';
import { loadModule } from '../src/core/load';
import { convert } from '../src/core/convert';
import { trigDrum, trigVoice, TRIG_STOP, hasDrums } from '../src/core/drums';
const fxb = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${n}`, import.meta.url)));

describe('converter: percussion as digidrums', () => {
  const m = loadModule(fxb('OMARSBAZAAR.xm'));
  const plain = convert(m);
  const r = convert(m, { digiDrums: true, digiRate: 8000 });
  it('produces a drum track and leaves non-drum results alone', () => {
    expect(plain.drums).toBeUndefined();
    expect(r.drums).toBeTruthy();
    expect(hasDrums(r.drums)).toBe(true);
    expect(r.drums!.drums.length).toBeGreaterThan(0);
    expect(r.drums!.drums.length).toBeLessThanOrEqual(63);
    expect(r.nframes).toBe(plain.nframes);
    for (const d of r.drums!.drums) { expect(d.pcm.every((v) => v <= 15)).toBe(true); expect(d.pcm.length).toBeGreaterThan(1); }
  });
  it('keeps the dump consistent with the triggers (voice silent while its drum plays)', () => {
    const tr = r.drums!.trig;
    let live: { v: number; end: number } | null = null, checked = 0;
    for (let f = 0; f < r.nframes; f++) {
      if (tr[f]) { const i = trigDrum(tr[f]); if (i !== TRIG_STOP) live = { v: trigVoice(tr[f]), end: f + drumFrames(r.drums!.drums[i]) }; else live = null; }
      if (live && f >= live.end) live = null;
      if (live) {
        expect(r.regs[f * 14 + 8 + live.v]).toBe(0);
        expect(r.regs[f * 14 + 7] & (1 << live.v)).toBeTruthy();
        expect(r.regs[f * 14 + 7] & (8 << live.v)).toBeTruthy();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
  it('the drum voice is not given to a tone note during a drum', () => {
    const tr = r.drums!.trig; let busyFrames = 0;
    for (let f = 0; f < r.nframes; f++) if (tr[f]) busyFrames++;
    expect(busyFrames).toBeGreaterThan(5);
    expect(r.report.some((l) => l.startsWith('digidrums:'))).toBe(true);
  });
});
