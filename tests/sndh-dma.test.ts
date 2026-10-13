import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSndh } from '../src/import/sndh';
import { dmaToDrums, DMA_RATES } from '../src/import/dma';
import { regsToSong } from '../src/tracker/fromRegs';
import { renderSong } from '../src/tracker/render';
import { trigVoice, trigDrum, TRIG_STOP, drumFrames, type DrumTrack } from '../src/core/drums';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${n}`, import.meta.url)));

describe('STe DMA sound in an SNDH (maxYMiser TEST_STE.SND)', () => {
  const data = fx('maxymiser/TEST_STE.SND');

  it('the emulated machine is an STe: the player allocates its buffer and starts the DMA track', () => {
    const t = parseSndh(data, { subtune: 1 });
    expect(t.warnings.join('\n')).not.toMatch(/did not return/);
    expect(t.nframes).toBe(321);
    expect(t.info.dmaHits).toBeGreaterThan(30);
    expect(t.info.dmaSamples).toBe(3);
    expect(t.warnings.join('\n')).toMatch(/STe DMA sound: 3 samples/);
  });

  it('the samples become digidrums on voice C, which is silent while they play', () => {
    const t = parseSndh(data, { subtune: 1 });
    const d = t.drums!;
    expect(d.drums.length).toBe(3);
    let hits = 0;
    for (let f = 0; f < t.nframes; f++) {
      const c = d.trig[f];
      if (!c) continue;
      hits++;
      expect(trigVoice(c)).toBe(2);
      const dr = d.drums[trigDrum(c)];
      expect(dr.pcm.length).toBeGreaterThan(500);
      expect(dr.pcm.some((v) => v > 0)).toBe(true);
      // the voice C registers are zeroed for the sample's duration
      for (let k = 0; k < Math.min(drumFrames(dr), 4); k++) if (f + k < t.nframes) expect(t.regs[(f + k) * 14 + 10] & 31).toBe(0);
    }
    expect(hits).toBe(t.info.dmaHits);
  });

  it('can be left out', () => {
    const t = parseSndh(data, { subtune: 1, dma: false });
    expect(t.drums).toBeUndefined();
    expect(t.info.dmaHits).toBeGreaterThan(30);
    expect(t.warnings.join('\n')).toMatch(/left out/);
  });

  it('opens in the pattern editor with the samples on the drum channel and the 5-frame tempo', () => {
    const t = parseSndh(data, { subtune: 1 });
    const r = regsToSong(t);
    expect(r.speed).toBe(5);
    expect(r.song.drumChannel).toBe(3);
    const re = renderSong(r.song);
    expect(re.drums).toBeTruthy();
    for (let f = 0; f < t.nframes; f++) expect(re.drums!.trig[f] ?? 0).toBe(t.drums!.trig[f] ?? 0);
  });
});

describe('dmaToDrums', () => {
  const mem = new Uint8Array(0x10000);
  for (let i = 0; i < 0x2000; i++) mem[0x1000 + i] = (Math.sin(i / 7) * 100) & 255;
  const ev = (frame: number, play: boolean, start = 0x1000, end = 0x1800, mode = 1) => ({ frame, play, loop: false, start, end, mode: 0x80 | mode });
  const quiet = () => new Uint8Array(14 * 40).map((_, i) => (i % 14 === 7 ? 0xff : 0));

  it('one sound started twice is one drum; the rate comes from the mode byte', () => {
    const r = dmaToDrums([ev(0, true), ev(10, true), ev(20, true, 0x1800, 0x2000)], mem, quiet(), 40);
    expect(r.samples).toBe(2);
    expect(r.hits).toBe(3);
    const d = r.track!;
    expect(trigDrum(d.trig[0])).toBe(trigDrum(d.trig[10]));
    expect(trigDrum(d.trig[20])).not.toBe(trigDrum(d.trig[0]));
    expect(DMA_RATES[1]).toBe(12517);
    expect(d.drums[0].rateHz).toBeGreaterThan(11000);
    expect(d.drums[0].rateHz).toBeLessThan(12500 * 1.01);
  });

  it('a stop while the sample runs becomes a stop trigger, a stop afterwards is ignored', () => {
    const r = dmaToDrums([ev(0, true, 0x1000, 0x2000), ev(3, false), ev(30, false)], mem, quiet(), 40);
    const d = r.track!;
    expect(trigDrum(d.trig[3])).toBe(TRIG_STOP);
    expect(d.trig[30]).toBe(0);
  });

  it('a timer digidrum at the same frame wins; tiny or out-of-range blocks are not samples', () => {
    const own: DrumTrack = { drums: [{ name: 'x', pcm: new Uint8Array([1, 2, 3]), rateHz: 8000 }], trig: new Uint8Array(40) };
    own.trig[5] = (3 << 6) | 0;
    const r = dmaToDrums([ev(5, true), ev(6, true, 0x1000, 0x1004), ev(7, true, 0x1000, 0xfffff0)], mem, quiet(), 40, own);
    expect(r.hits).toBe(0);
    expect(r.dropped).toBe(1);
  });

  it('stereo samples are mixed down; the voice is silenced while the sample plays', () => {
    const regs = quiet();
    for (let f = 0; f < 40; f++) { regs[f * 14 + 10] = 12; regs[f * 14 + 7] = 0xf8; }
    const r = dmaToDrums([{ frame: 2, play: true, loop: false, start: 0x1000, end: 0x1800, mode: 1 }], mem, regs, 40);
    expect(r.track).toBeTruthy();
    const fr = drumFrames(r.track!.drums[0]);
    expect(regs[2 * 14 + 10]).toBe(0);
    expect(regs[(2 + fr - 1) * 14 + 10]).toBe(0);
    expect(regs[1 * 14 + 10]).toBe(12);
    expect(regs[(2 + fr + 1) * 14 + 10]).toBe(12);
  });
});
