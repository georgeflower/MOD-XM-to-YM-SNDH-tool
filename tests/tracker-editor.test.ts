import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Editor } from '../src/tracker/editor';
import { encodeYmt, decodeYmt, isYmt } from '../src/tracker/ymt';
import { loadModule } from '../src/core/load';
import { moduleToSong } from '../src/tracker/fromModule';
import { renderSong } from '../src/tracker/render';
import { NOTE_OFF } from '../src/tracker/types';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${n}`, import.meta.url)));

describe('editor', () => {
  it('enters notes with step advance, delete and undo / redo', () => {
    const ed = new Editor();
    ed.instrument = 2; ed.step = 2;
    ed.setStep(2);
    ed.insertNote(49);
    expect(ed.pattern.cells[0][0]).toMatchObject({ note: 49, instrument: 2 });
    expect(ed.row).toBe(2);
    ed.insertNote(NOTE_OFF);
    expect(ed.pattern.cells[2][0]).toMatchObject({ note: NOTE_OFF, instrument: 0 });
    ed.undo();
    expect(ed.pattern.cells[2][0].note).toBe(0);
    ed.redo();
    expect(ed.pattern.cells[2][0].note).toBe(NOTE_OFF);
    ed.setCursor(0, 0, 0);
    ed.deleteNoteVol();
    expect(ed.pattern.cells[0][0].note).toBe(0);
  });

  it('hex entry fills instrument, volume and effect columns', () => {
    const ed = new Editor();
    ed.setCursor(3, 1, 1);
    ed.typeHex(0x0); ed.typeHex(0x7);               // instrument 07, cursor moves on to the next row
    expect(ed.pattern.cells[3][1].instrument).toBe(7);
    ed.setCursor(4, 1, 6);
    ed.typeHex(4); ed.typeHex(7);                   // bare param digits imply the arpeggio effect
    expect(ed.pattern.cells[4][1]).toMatchObject({ effect: 1, param: 0x47 });
  });

  it('insert / backspace shift one channel, cut / paste a block, copy a track', () => {
    const ed = new Editor();
    for (let r = 0; r < 4; r++) ed.setCell({ note: 40 + r, instrument: 1 }, r, 0);
    ed.setCursor(1, 0, 0);
    ed.insertCell();
    expect(ed.pattern.cells.slice(0, 5).map((r) => r[0].note)).toEqual([40, 0, 41, 42, 43]);
    ed.backspaceCell();                             // pulls the rows below the cursor up and moves up
    expect(ed.pattern.cells.slice(0, 4).map((r) => r[0].note)).toEqual([0, 41, 42, 43]);
    ed.setCursor(1, 0, 0);
    ed.selectRange({ row: 1, channel: 0 }, { row: 2, channel: 0 });
    ed.cutBlock();
    expect(ed.pattern.cells[1][0].note).toBe(0);
    ed.setCursor(10, 2, 0);
    ed.pasteBlock();
    expect(ed.pattern.cells[10][2].note).toBe(41);
    expect(ed.pattern.cells[11][2].note).toBe(42);
    ed.copyTrack(); ed.setCursor(0, 1, 0); ed.pasteTrack();
    expect(ed.pattern.cells[10][1].note).toBe(41);
  });

  it('transposes by scope and filters by instrument; scales volume', () => {
    const ed = new Editor();
    ed.setCell({ note: 49, instrument: 1, volume: 0x50 }, 0, 0);
    ed.setCell({ note: 50, instrument: 2, volume: 0x30 }, 1, 0);
    expect(ed.transpose('pattern', 12, 1)).toBe(1);
    expect(ed.pattern.cells[0][0].note).toBe(61);
    expect(ed.pattern.cells[1][0].note).toBe(50);
    ed.scaleVolume('track', 50, 50);
    expect(ed.pattern.cells[0][0].volume).toBe(0x10 + 32);
    expect(ed.pattern.cells[1][0].volume).toBe(0x10 + 16);
  });

  it('order list and patterns: add, clone, move, remove, length', () => {
    const ed = new Editor();
    ed.setCell({ note: 49, instrument: 1 }, 0, 0);
    ed.clonePattern();
    expect(ed.song.order).toEqual([0, 1]);
    expect(ed.pattern.cells[0][0].note).toBe(49);
    ed.addPattern();
    expect(ed.song.order).toEqual([0, 1, 2]);
    ed.moveOrderEntry(2, 0);
    expect(ed.song.order).toEqual([2, 0, 1]);
    ed.removeOrderEntry();
    expect(ed.song.order).toEqual([0, 1]);
    ed.setPatternLength(32);
    expect(ed.pattern.rows).toBe(32);
    expect(ed.pattern.cells.length).toBe(32);
    ed.setOrderEntry(0, 5);                         // a pattern that does not exist yet is created
    expect(ed.song.patterns.length).toBeGreaterThanOrEqual(6);
  });

  it('renders what it holds, including mute', () => {
    const ed = new Editor();
    ed.setCell({ note: 49, instrument: 1 }, 0, 0);
    const a = ed.currentRender();
    expect(a.nframes).toBe(64 * 6);
    expect(a.regs[8]).toBe(15);
    ed.toggleMute(0);
    expect(ed.currentRender().regs[8]).toBe(0);
  });
});

describe('.ymt', () => {
  it('round-trips a converted song, step tables included', async () => {
    const { song } = moduleToSong(loadModule(fx('back_in_town_again.mod')), { arpFill: 3 });
    const bytes = await encodeYmt(song);
    expect(isYmt(bytes)).toBe(true);
    const back = await decodeYmt(bytes);
    expect(back.name).toBe(song.name);
    expect(back.order).toEqual(song.order);
    expect(back.patterns).toEqual(song.patterns);
    expect(back.instruments.map((i) => i.seq)).toEqual(song.instruments.map((i) => i.seq));
    const a = renderSong(song), b = renderSong(back);
    expect(b.nframes).toBe(a.nframes);
    expect(Buffer.from(b.regs).equals(Buffer.from(a.regs))).toBe(true);
  });
  it('uncompressed output decodes too', async () => {
    const ed = new Editor();
    ed.setCell({ note: 60, instrument: 1 }, 0, 0);
    const back = await decodeYmt(await encodeYmt(ed.song, { gzip: false }));
    expect(back.patterns[0].cells[0][0].note).toBe(60);
  });
});
