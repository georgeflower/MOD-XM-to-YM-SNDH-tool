import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadModule } from '../src/core/load';
import { moduleToSong } from '../src/tracker/fromModule';
import { renderSong, type RenderResult } from '../src/tracker/render';
import { regsToSong } from '../src/tracker/fromRegs';
import { newSong, parseEffectChar, NOTE_OFF } from '../src/tracker/types';
import { parseYm } from '../src/import/ym';
import { parseSndh } from '../src/import/sndh';
import { writeYm6 } from '../src/export/ym';
import { writeSndh } from '../src/export/sndh';
import type { AyTune } from '../src/import/tune';
import { encodeYmt, decodeYmt } from '../src/tracker/ymt';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${n}`, import.meta.url)));

const asTune = (r: RenderResult, loopFrame = 0): AyTune => ({
  title: 'T', author: 'A', comment: '', regs: r.regs, nframes: r.nframes, loopFrame, drums: r.drums, fx: r.fx, source: 'ym', warnings: [],
});

/** share of frames in which any voice differs audibly: level, waveform, pitch (within 0.6 %), buzzer period */
function mismatch(a: { regs: Uint8Array; nframes: number }, b: { regs: Uint8Array; nframes: number }): number {
  const n = Math.min(a.nframes, b.nframes);
  let bad = 0;
  for (let f = 0; f < n; f++) {
    let fb = false;
    for (let v = 0; v < 3 && !fb; v++) {
      const g = (r: Uint8Array, i: number) => r[f * 14 + i];
      const va = g(a.regs, 8 + v), vb = g(b.regs, 8 + v);
      if ((va & 31) !== (vb & 31)) { fb = true; break; }
      if (!(va & 31)) continue;
      const mixA = g(a.regs, 7), mixB = g(b.regs, 7);
      const toneA = !(mixA & (1 << v)), toneB = !(mixB & (1 << v));
      if (!(va & 16) && (toneA !== toneB || !(mixA & (8 << v)) !== !(mixB & (8 << v)))) { fb = true; break; }
      const pa = g(a.regs, 2 * v) | ((g(a.regs, 2 * v + 1) & 15) << 8), pb = g(b.regs, 2 * v) | ((g(b.regs, 2 * v + 1) & 15) << 8);
      if (toneA && Math.abs(pa - pb) > Math.max(1, pa * 0.006)) fb = true;
      if ((va & 16) && (g(a.regs, 11) | (g(a.regs, 12) << 8)) !== (g(b.regs, 11) | (g(b.regs, 12) << 8))) fb = true;
    }
    if (fb) bad++;
  }
  return bad / n;
}

describe('register dump -> pattern song', () => {
  const m = loadModule(fx('OMARSBAZAAR.xm'));
  const src = renderSong(moduleToSong(m, {}).song);

  it('finds the tempo of a converted module and reproduces it frame for frame', () => {
    const r = regsToSong(asTune(src));
    expect(r.speed).toBe(6);
    expect(r.lead).toBe(0);
    const re = renderSong(r.song);
    expect(re.nframes).toBeGreaterThanOrEqual(src.nframes);
    expect(mismatch(src, re)).toBeLessThan(0.002);
  });

  it('digidrum hits land on a drum channel and trigger at the same frames', () => {
    const r = regsToSong(asTune(src));
    expect(r.song.drumChannel).toBe(3);
    const re = renderSong(r.song);
    expect(re.drums).toBeTruthy();
    for (let f = 0; f < src.nframes; f++) expect(re.drums!.trig[f] ?? 0).toBe(src.drums!.trig[f] ?? 0);
  });

  it('notes are real notes with shared instruments, not one instrument per note', () => {
    const r = regsToSong(asTune(src));
    let notes = 0;
    for (const o of r.song.order) for (const row of r.song.patterns[o].cells) for (let c = 0; c < 3; c++) if (row[c].note) notes++;
    expect(notes).toBeGreaterThan(400);
    expect(r.song.instruments.length - 1).toBeLessThan(notes / 3);
    expect(r.song.instruments.slice(1, -1).every((i) => !!i.seq)).toBe(true);
  });

  it('the song survives a .ymt round trip', async () => {
    const r = regsToSong(asTune(src));
    const back = await decodeYmt(await encodeYmt(r.song, { gzip: true }));
    expect(mismatch(src, renderSong(back))).toBeLessThan(0.002);
  });

  it('a real YM file (bita.ym) imports with the lead-in kept and few audible differences', () => {
    const t = parseYm(fx('lha/bita.ym'));
    const r = regsToSong(t);
    expect(r.speed).toBeGreaterThan(1);
    expect(r.song.instruments.length - 1).toBeLessThanOrEqual(255);
    const re = renderSong(r.song);
    expect(mismatch(t, re)).toBeLessThan(0.08);
  });

  it('a real SNDH file (bita.sndh from the 68000 emulator) imports too', () => {
    const t = parseSndh(fx('ice/bita.sndh'), { subtune: 1 });
    const r = regsToSong(t);
    expect(r.song.patterns.length).toBeGreaterThan(0);
    expect(mismatch(t, renderSong(r.song))).toBeLessThan(0.08);
  });

  it('survives the formats: writeYm6 -> parseYm and writeSndh -> parseSndh -> patterns', () => {
    const ym = writeYm6(src.regs, src.nframes, 0, src.drums, 'x', 'y', '', 50, src.fx);
    const t1 = parseYm(ym.data);
    expect(mismatch(src, renderSong(regsToSong(t1).song))).toBeLessThan(0.01);
    const sn = writeSndh(src.regs, src.nframes, 0, { title: 'x', author: 'y' }, src.drums, src.fx);
    const t2 = parseSndh(sn, { subtune: 1 });
    expect(mismatch(src, renderSong(regsToSong(t2).song))).toBeLessThan(0.01);
  });
});

describe('register dump -> patterns: sounds and effects', () => {
  /** buzzer, noise, vibrato, sync-square, slide, SID voice and sinus-SID */
  function demoSong() {
    const song = newSong(3);
    song.speed = 5;
    const [, lead, buzz, noise, vib, sync] = song.instruments;
    lead.name = 'Lead';
    buzz.name = 'Buzz'; buzz.useHardEnv = true; buzz.hardEnvShape = 10; buzz.hardEnvAutoPeriod = true; buzz.hardEnvDivisor = 1;
    buzz.adsr = { useAdsr: true, attack: 0, decay: 0, sustain: 15, release: 4 };
    noise.name = 'Hat'; noise.toneEnabled = false; noise.noiseEnabled = true; noise.noisePeriod = 8;
    noise.adsr = { useAdsr: true, attack: 0, decay: 6, sustain: 0, release: 0 };
    vib.name = 'Vib'; vib.vibratoSpeed = 6; vib.vibratoDepth = 6; vib.adsr = { useAdsr: true, attack: 2, decay: 8, sustain: 9, release: 5 };
    sync.name = 'Sync'; sync.syncSquare = true;
    const pat = song.patterns[0];
    const set = (r: number, c: number, note: number, inst: number, eff = '', par = 0) => {
      const x = pat.cells[r][c]; x.note = note; x.instrument = inst;
      if (eff) { x.effect = parseEffectChar(eff); x.param = par; }
    };
    set(0, 0, 40, 1); set(8, 0, 44, 1); set(16, 0, NOTE_OFF, 1); set(20, 0, 47, 4); set(36, 0, NOTE_OFF, 4);
    set(0, 1, 25, 2); set(12, 1, 29, 2); set(24, 1, 32, 2, 'X', 12); set(40, 1, NOTE_OFF, 2);
    for (let r = 2; r < 48; r += 4) set(r, 2, 60, 3);
    set(44, 0, 52, 5); set(52, 0, 55, 1, 'Q', 0x40); set(60, 0, NOTE_OFF, 1);
    set(48, 1, 33, 1, '1', 0x04); set(56, 1, 36, 1, 'S', 0x42);
    return song;
  }
  const src = renderSong(demoSong());

  it('is reproduced: levels, waveforms, buzzer, sync bit and timer effects', () => {
    expect(src.fx).toBeTruthy();
    const r = regsToSong(asTune(src));
    expect(r.speed).toBe(10);
    const re = renderSong(r.song);
    expect(mismatch(src, re)).toBeLessThan(0.02);
    for (let f = 0; f < src.nframes; f++) expect(re.fx?.[f] ?? 0).toBe(src.fx![f] ?? 0);
    const sync = r.song.instruments.filter((i) => i.syncSquare);
    expect(sync.length).toBeGreaterThan(0);
    for (let f = 0; f < src.nframes; f++) for (let v = 0; v < 3; v++) expect(re.regs[f * 14 + 8 + v] & 32).toBe(src.regs[f * 14 + 8 + v] & 32);
  });

  it('the buzzer comes out as a hardware-envelope instrument with the right shape', () => {
    const r = regsToSong(asTune(src));
    const bz = r.song.instruments.filter((i) => i.useHardEnv);
    expect(bz.length).toBeGreaterThan(0);
    expect(bz.map((b) => b.hardEnvShape).sort()).toEqual(expect.arrayContaining([10]));
  });

  it('without a regular tempo it falls back to one frame per row and stays accurate', () => {
    const r = regsToSong(asTune(src), { speed: 1 });
    expect(r.speed).toBe(1);
    expect(mismatch(src, renderSong(r.song))).toBeLessThan(0.02);
  });

  it('the loop frame becomes the order position the song restarts at', () => {
    const song = demoSong();
    song.patterns.push(structuredClone(song.patterns[0]));
    song.order = [0, 1]; song.restartPos = 1;
    const r0 = renderSong(song);
    expect(r0.loopFrame).toBeGreaterThan(0);
    const r = regsToSong(asTune(r0, r0.loopFrame));
    const re = renderSong(r.song);
    expect(re.loopFrame).toBe(r0.loopFrame);
  });

  it('a silent or very short tune still gives a usable song', () => {
    const regs = new Uint8Array(14 * 5); for (let f = 0; f < 5; f++) { regs[f * 14 + 7] = 0xff; regs[f * 14 + 13] = 0xff; }
    const r = regsToSong({ title: '', author: '', comment: '', regs, nframes: 5, loopFrame: 0, source: 'ym', warnings: [] });
    expect(r.song.patterns.length).toBeGreaterThan(0);
    expect(r.song.order.length).toBeGreaterThan(0);
    expect(() => renderSong(r.song)).not.toThrow();
  });
});
