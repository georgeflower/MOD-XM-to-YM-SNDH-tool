import { describe, it, expect } from 'vitest';
import { newSong } from '../src/tracker/types';
import { renderSong } from '../src/tracker/render';
import { Editor } from '../src/tracker/editor';
import { INSTRUMENT_PRESETS } from '../src/tracker/presets';
import { songToMaxymiser } from '../src/maxymiser/convert';
import { maxymiserToSong } from '../src/maxymiser/import';

const PRESET = (name: string) => INSTRUMENT_PRESETS.find((p) => p.name.startsWith(name))!;

function play(presetName: string, note = 37, rows = 4) {
  const s = newSong();
  s.instruments[1] = PRESET(presetName).make();
  s.patterns[0].cells[0][0] = { note, instrument: 1, volume: 0, effect: 0, param: 0 };
  s.patterns[0].rows = 16;
  s.patterns[0].cells.length = 16;
  s.speed = 6; s.bpm = 125;
  void rows;
  return renderSong(s);
}
const reg = (r: { regs: Uint8Array }, frame: number, n: number) => r.regs[frame * 14 + n];

describe('instrument presets', () => {
  it('every preset renders sound on the first frame and stays within register ranges', () => {
    for (const p of INSTRUMENT_PRESETS) {
      const s = newSong();
      s.instruments[1] = p.make();
      s.patterns[0].cells[0][0] = { note: 37, instrument: 1, volume: 0, effect: 0, param: 0 };
      const r = renderSong(s);
      const audible = reg(r, 0, 8) > 0 || reg(r, 0, 9) > 0 || reg(r, 0, 10) > 0;
      expect(audible, p.name).toBe(true);
      for (let f = 0; f < 30; f++) for (let k = 0; k < 14; k++) expect(r.regs[f * 14 + k]).toBeLessThanOrEqual(255);
    }
  });

  it('chord ornament cycles through the chord at 50 Hz', () => {
    const r = play('Minor 0 3 7');
    const per = Array.from({ length: 12 }, (_, f) => reg(r, f, 0) | (reg(r, f, 1) << 8));
    const distinct = Array.from(new Set(per)).sort((a, b) => b - a);       // longest period = root
    expect(distinct.length).toBe(3);
    expect(distinct[0] / distinct[1]).toBeCloseTo(Math.pow(2, 3 / 12), 1);
    expect(distinct[0] / distinct[2]).toBeCloseTo(Math.pow(2, 7 / 12), 1);
  });

  it('blip jumps 19 semitones up for one tick and settles on the note', () => {
    const r = play('Blip 19');
    const p = (f: number) => reg(r, f, 0) | (reg(r, f, 1) << 8);
    expect(p(0) / p(5)).toBeCloseTo(Math.pow(2, -19 / 12), 1);
    expect(p(1)).toBe(p(5));
  });

  it('acid bass: buzzer follows the note while the square sweeps down onto it', () => {
    const r = play('Acid bass (buzzer');
    const tone = (f: number) => reg(r, f, 0) | (reg(r, f, 1) << 8);
    const env = (f: number) => reg(r, f, 11) | (reg(r, f, 12) << 8);
    expect(reg(r, 0, 8) & 0x10).toBe(0x10);                         // envelope-controlled volume
    expect(reg(r, 0, 13)).toBe(8);                                  // saw shape triggered on the first frame
    expect(reg(r, 1, 13)).toBe(0xff);                               // not re-triggered each tick
    expect(env(0)).toBe(env(5));                                    // buzzer period fixed by the note
    expect(tone(0)).toBeLessThan(tone(5));                          // sweep goes down in pitch
    const toneHz = (f: number) => 2_000_000 / (16 * tone(f)), buzzHz = (f: number) => 2_000_000 / (256 * env(f));
    expect(toneHz(0) / buzzHz(0)).toBeCloseTo(Math.pow(2, 40 / 12), 0);   // starts 40 semitones above the buzzer
    expect(toneHz(9) / buzzHz(9)).toBeCloseTo(Math.pow(2, 7 / 12), 1);    // settles a fifth above
    expect(reg(r, 0, 7) & 1).toBe(0);                               // tone enabled on voice A
  });

  it('drum presets are note-off friendly and finish by themselves', () => {
    for (const n of ['Kick', 'Snare', 'Hat closed']) {
      const r = play(n, 25, 4);
      expect(reg(r, 40, 8), n).toBe(0);
    }
  });

  it('presets survive a maxYMiser export', () => {
    for (const p of INSTRUMENT_PRESETS) {
      const s = newSong();
      s.instruments[1] = p.make();
      s.patterns[0].cells[0][0] = { note: 37, instrument: 1, volume: 0, effect: 0, param: 0 };
      const m = songToMaxymiser(s);
      expect(m.mys.length, p.name).toBeGreaterThan(1000);
    }
  });
});

describe('maxYMiser export of buzzer step tables', () => {
  it('acid bass keeps the buzzer on the note and sweeps the tone, also after re-import', () => {
    const s = newSong();
    s.instruments[1] = PRESET('Acid bass (buzzer').make();
    s.patterns[0].cells[0][0] = { note: 37, instrument: 1, volume: 0, effect: 0, param: 0 };
    const direct = renderSong(s);
    const m = songToMaxymiser(s);
    const back = renderSong(maxymiserToSong(m.mys, m.myv, 't').song);
    for (const r of [direct, back]) {
      expect(r.regs[8] & 0x10).toBe(0x10);
      expect(r.regs[13]).toBe(8);
      expect(r.regs[11] | (r.regs[12] << 8)).toBe(direct.regs[11] | (direct.regs[12] << 8));
      expect(r.regs[0] | (r.regs[1] << 8)).toBeLessThan(r.regs[14 * 8] | (r.regs[14 * 8 + 1] << 8));
    }
  });
});

describe('echo', () => {
  it('copies notes later at a lower volume, only into empty cells', () => {
    const ed = new Editor();
    ed.setCell({ note: 37, instrument: 1, volume: 0x50 }, 0, 0);
    ed.setCell({ note: 40, instrument: 1, volume: 0 }, 4, 0);
    ed.setCell({ note: 41, instrument: 1 }, 3, 0);      // blocks the second echo of row 0? row 2, 4 -> row 4 busy
    const n = ed.echo('track', 2, 50, 2);
    const p = ed.song.patterns[0].cells;
    expect(p[2][0].note).toBe(37);
    expect(p[2][0].volume).toBe(0x10 + 32);
    expect(p[4][0].note).toBe(40);                      // untouched
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('does nothing past the end of the pattern', () => {
    const ed = new Editor();
    ed.setCell({ note: 37, instrument: 1 }, 63, 0);
    expect(ed.echo('pattern', 2, 50, 1)).toBe(0);
  });
});
