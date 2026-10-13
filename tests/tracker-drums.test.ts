import { describe, it, expect } from 'vitest';
import { newSong, parseEffectChar, NOTE_OFF, emptyPattern } from '../src/tracker/types';
import { renderSong } from '../src/tracker/render';
import { starterKit, drumFrames, trigCode, trigDrum, trigVoice, TRIG_STOP } from '../src/core/drums';

function song1(channels = 3) {
  const s = newSong(channels);
  s.patterns[0] = emptyPattern(16, channels);
  s.instruments[1].digiDrums = starterKit();
  return s;
}
const cell = (note: number, instrument = 0, effect = 0, param = 0) => ({ note, instrument, volume: 0, effect, param });
const mixer = (r: Uint8Array, f: number) => r[f * 14 + 7];

describe('digidrums in the pattern renderer', () => {
  it('Zxx triggers the instrument\'s drum xx on the channel\'s voice and silences the voice meanwhile', () => {
    const s = song1();
    s.patterns[0].cells[0][1] = cell(49, 1);                             // a held tone on voice B
    s.patterns[0].cells[2][1] = cell(0, 0, parseEffectChar('Z'), 2);     // drum #2 (snare) on voice B
    const r = renderSong(s);
    expect(r.drums).toBeTruthy();
    const t = r.drums!.trig;
    expect(t[12]).toBe(trigCode(1, 0));                                  // row 2 = frame 12
    expect(r.drums!.drums[0].name).toBe('Snare');
    expect(t.filter(Boolean).length).toBe(1);
    const n = drumFrames(r.drums!.drums[0]);
    for (let f = 12; f < 12 + n && f < r.nframes; f++) {
      expect(r.regs[f * 14 + 9]).toBe(0);                                // voice B volume forced off
      expect(mixer(r.regs, f) & 0x12).toBe(0x12);                             // tone B + noise B disabled
    }
    expect(r.regs[11 * 14 + 9]).toBe(15);                                // the tone plays before the drum
  });

  it('a note on the same channel stops its Z drum; Z00 stops it too', () => {
    const s = song1();
    s.patterns[0].cells[0][0] = cell(0, 1, parseEffectChar('Z'), 1);     // kick (long)
    s.patterns[0].cells[1][0] = cell(60, 1);                             // new note on the same voice
    s.patterns[0].cells[4][2] = cell(0, 1, parseEffectChar('Z'), 4);
    s.patterns[0].cells[5][2] = cell(0, 0, parseEffectChar('Z'), 0);
    const r = renderSong(s);
    const t = r.drums!.trig;
    expect(trigDrum(t[0])).toBe(0);
    expect(trigVoice(t[6])).toBe(0); expect(trigDrum(t[6])).toBe(TRIG_STOP);
    expect(trigVoice(t[24])).toBe(2);
    expect(trigDrum(t[30])).toBe(TRIG_STOP);
    // after the stop the note is audible on voice A again
    expect(r.regs[7 * 14 + 8]).toBeGreaterThan(0);
  });

  it('the drum channel plays digidrum (note-1) on voice C; note off and new drums cut the old one', () => {
    const s = song1(4); s.drumChannel = 3;
    s.patterns[0].cells[0][3] = cell(1, 1);                              // kick (11 frames)
    s.patterns[0].cells[1][3] = cell(NOTE_OFF);                          // cut it after 6 frames
    s.patterns[0].cells[2][3] = cell(4, 0);                              // open hat (200 ms)
    s.patterns[0].cells[3][3] = cell(5, 0);                              // tom cuts the open hat
    s.patterns[0].cells[0][2] = cell(49, 1);
    const r = renderSong(s);
    expect(r.warnings.join()).not.toMatch(/drum channel is not rendered/);
    const t = r.drums!.trig;
    expect(r.drums!.drums.map((d) => d.name)).toEqual(['Kick', 'Open hat', 'Tom']);
    expect(t[0]).toBe(trigCode(2, 0));
    expect(trigVoice(t[6])).toBe(2); expect(trigDrum(t[6])).toBe(TRIG_STOP);
    expect(t[12]).toBe(trigCode(2, 1));
    expect(t[18]).toBe(trigCode(2, 2));
    expect(r.regs[10]).toBe(0);                                          // voice C belongs to the drum while it plays
    expect(r.regs[0 * 14 + 10]).toBe(0);
  });

  it('songs without drums carry no drum track', () => {
    const s = song1();
    s.patterns[0].cells[0][0] = cell(49, 1);
    expect(renderSong(s).drums).toBeUndefined();
  });

  it('warns when a Z effect names a drum the instrument does not have', () => {
    const s = song1();
    s.patterns[0].cells[0][0] = cell(0, 1, parseEffectChar('Z'), 20);
    expect(renderSong(s).warnings.join()).toMatch(/no digidrum 20/);
  });
});

import { readFileSync } from 'node:fs';
import { loadModule } from '../src/core/load';
import { moduleToSong } from '../src/tracker/fromModule';
import { encodeYmt, decodeYmt } from '../src/tracker/ymt';
import { hasDrums } from '../src/core/drums';

describe('module -> patterns with a digidrum channel', () => {
  const m = loadModule(new Uint8Array(readFileSync(new URL('../fixtures/OMARSBAZAAR.xm', import.meta.url))));
  const plain = moduleToSong(m, {});
  const r = moduleToSong(m, { digiDrums: true });
  it('adds a 4th column with drum notes and a bank instrument', () => {
    expect(plain.song.channelCount).toBe(3);
    expect(plain.song.drumChannel).toBe(-1);
    expect(r.song.channelCount).toBe(4);
    expect(r.song.drumChannel).toBe(3);
    for (const p of r.song.patterns) for (const row of p.cells) expect(row.length).toBe(4);
    let hits = 0, bank = -1;
    for (const o of new Set(r.song.order)) for (const row of r.song.patterns[o].cells) { const c = row[3]; if (c.note) { hits++; bank = c.instrument; } }
    expect(hits).toBeGreaterThan(20);
    expect(r.song.instruments[bank].digiDrums!.length).toBeGreaterThan(0);
    expect(r.report.some((l) => l.startsWith('digidrums:'))).toBe(true);
  });
  it('renders to a dump with drum triggers; tone voices stay intact outside drums', () => {
    const a = renderSong(r.song);
    expect(hasDrums(a.drums)).toBe(true);
    const trigs = Array.from(a.drums!.trig).filter(Boolean).length;
    expect(trigs).toBeGreaterThan(20);
    // length is unchanged by the drum channel
    expect(a.nframes).toBe(renderSong(plain.song).nframes);
  });
  it('survives a .ymt round trip', async () => {
    const back = await decodeYmt(await encodeYmt(r.song, { gzip: true }));
    expect(back.channelCount).toBe(4);
    expect(back.drumChannel).toBe(3);
    const bank = back.instruments.find((i) => (i.digiDrums?.length ?? 0) > 0)!;
    const orig = r.song.instruments.find((i) => (i.digiDrums?.length ?? 0) > 0)!;
    expect(bank.digiDrums!.length).toBe(orig.digiDrums!.length);
    expect(Array.from(bank.digiDrums![0].pcm)).toEqual(Array.from(orig.digiDrums![0].pcm));
    const b = renderSong(back);
    expect(Array.from(b.drums!.trig)).toEqual(Array.from(renderSong(r.song).drums!.trig));
  });
});
