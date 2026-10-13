import { describe, it, expect } from 'vitest';
import { newSong, defaultInstrument } from '../src/tracker/types';
import { renderSong } from '../src/tracker/render';
import { packStream, unpackStream } from '../src/export/stream';
import { writeSndh } from '../src/export/sndh';
import { parseSndh } from '../src/import/sndh';
import { encodeYmt, decodeYmt } from '../src/tracker/ymt';
import { writeYm5, writeYm6 } from '../src/export/ym';
import { INSTRUMENT_PRESETS } from '../src/tracker/presets';
import { songToMaxymiser } from '../src/maxymiser/convert';

function song(sync: boolean) {
  const s = newSong();
  s.instruments[1] = { ...defaultInstrument('sq'), syncSquare: sync, adsr: { useAdsr: true, attack: 0, decay: 0, sustain: 15, release: 2 } };
  s.patterns[0].cells[0][0] = { note: 37, instrument: 1, volume: 0, effect: 0, param: 0 };
  s.patterns[0].cells[8][0] = { note: 41, instrument: 1, volume: 0, effect: 0, param: 0 };
  return s;
}
const flagged = (regs: Uint8Array, nf: number) => { const o: number[] = []; for (let f = 0; f < nf; f++) if (regs[f * 14 + 8] & 0x20) o.push(f); return o; };

describe('sync-square', () => {
  it('the Punchy bass preset uses it; YM5 files and maxYMiser leave it out (with a warning)', () => {
    const s = newSong();
    s.instruments[1] = INSTRUMENT_PRESETS.find((p) => p.name.startsWith('Punchy bass'))!.make();
    s.patterns[0].cells[0][0] = { note: 25, instrument: 1, volume: 0, effect: 0, param: 0 };
    const r = renderSong(s);
    expect(flagged(r.regs, r.nframes)).toEqual([0]);
    const ym = writeYm5(r.regs, r.nframes, r.loopFrame, 't', 'a', '');
    const body = ym.subarray(ym.length - 4 - r.nframes * 16, ym.length - 4);
    for (let f = 0; f < r.nframes; f++) expect(body[8 * r.nframes + f] & 0xe0).toBe(0);
    expect(songToMaxymiser(s).warnings.join('\n')).toMatch(/sync-square is left out/);
  });

  it('flags the first audible frame of each note, and only for instruments that ask for it', () => {
    const r = renderSong(song(true));
    expect(flagged(r.regs, r.nframes)).toEqual([0, 48]);
    expect(flagged(renderSong(song(false)).regs, 100)).toEqual([]);
  });

  it('survives the packed stream', () => {
    const r = renderSong(song(true));
    const p = packStream(r.regs, r.nframes, r.loopFrame);
    expect(Buffer.from(unpackStream(p.data, r.nframes)).equals(Buffer.from(r.regs))).toBe(true);
  });

  it('the SNDH player restarts the tone counter: period 0, then the real period, high byte first, after >= 8 NOPs', () => {
    const r = renderSong(song(true));
    const sndh = writeSndh(r.regs, r.nframes, r.loopFrame, { title: 't', author: 'a' });
    const trace: { r: number; v: number; i: number }[] = [];
    const t = parseSndh(sndh, { seconds: 2, trace });
    // the played registers carry no flag bit
    expect(flagged(t.regs, t.nframes)).toEqual([]);
    expect(t.regs[8] & 0x1f).toBe(15);
    // the retrigger: R0 = 0, R1 = 0, then (after the NOPs) R1 and R0 back to the real period, high byte first
    const k = trace.findIndex((e, j) => j > 15 && e.r === 1 && e.v === 0 && trace[j - 1]?.r === 0 && trace[j - 1].v === 0);   // after the init clear
    expect(k).toBeGreaterThan(0);
    const real = r.regs[0] | (r.regs[1] << 8);
    expect(trace[k + 1]).toMatchObject({ r: 1, v: real >> 8 });
    expect(trace[k + 2]).toMatchObject({ r: 0, v: real & 255 });
    expect(trace[k + 1].i - trace[k].i).toBeGreaterThanOrEqual(8);          // >= 8 instructions (the NOPs) with the short period in place
  });

  it('a song without sync-square plays through the same player without any extra writes', () => {
    const r = renderSong(song(false));
    const trace: { r: number; v: number; i: number }[] = [];
    parseSndh(writeSndh(r.regs, r.nframes, r.loopFrame, { title: 't', author: 'a' }), { seconds: 1, trace });
    expect(trace.some((e, j) => e.r === 1 && e.v === 0 && trace[j - 1]?.r === 0 && trace[j - 1].v === 0 && j > 15)).toBe(false);
  });

  it('is not part of YM files, and is kept in .ymt files', async () => {
    const r = renderSong(song(true));
    const ym = writeYm6(r.regs, r.nframes, r.loopFrame, null, 't', 'a', '').data;
    const body = ym.subarray(ym.length - 4 - r.nframes * 16, ym.length - 4);       // register-major planes
    for (const reg of [8, 9, 10]) for (let f = 0; f < r.nframes; f++) expect(body[reg * r.nframes + f] & 0xe0).toBe(0);
    expect(body[8 * r.nframes] & 31).toBe(15);
    const back = await decodeYmt(await encodeYmt(song(true)));
    expect(back.instruments[1].syncSquare).toBe(true);
    expect((await decodeYmt(await encodeYmt(song(false)))).instruments[1].syncSquare).toBeFalsy();
  });
});
