import { describe, it, expect } from 'vitest';
import { newSong, emptyPattern, parseEffectChar, NOTE_OFF } from '../src/tracker/types';
import { maxymiserToSong } from '../src/maxymiser/import';
import { timerFrequency, timerPeriodFor } from '../src/maxymiser/timers';
import { fxParamHz } from '../src/core/fx';
import { songToMaxymiser, instrumentToMyi, mymNote } from '../src/maxymiser/convert';
import { LINEAR_TO_YM_VOL } from '../src/tracker/render';
import { mfpRate } from '../src/core/drums';
import {
  newMymSong, newMymBank, encodeSong, decodeSong, encodeBank, decodeBank, encodeInstrument, decodeInstrument,
  emptyMymCell, INST, SONG_HEADER,
} from '../src/maxymiser/format';

const cell = (note: number, instrument = 0, effect = '', param = 0, volume = 0) => ({ note, instrument, volume, effect: effect ? parseEffectChar(effect) : 0, param });
const mkSong = () => { const s = newSong(3); s.patterns[0] = emptyPattern(64, 3); s.bpm = 125; s.speed = 6; return s; };

describe('maxYMiser file formats', () => {
  it('writes the song header and run-length codes empty rows', () => {
    const s = newMymSong();
    s.length = 2; s.repeat = 1;
    s.orders = [[0, 0xff, 0xff, 0xff], [0xff, 0xfe, 0xff, 0xff]];
    const pat = Array.from({ length: 64 }, emptyMymCell);
    pat[0] = { note: 60, inst: 1, vol: 0x10, fx1: 'S'.charCodeAt(0), p1: 3, fx2: 0, p2: 0 };
    pat[40] = { note: 1, inst: 0, vol: 0, fx1: 0, p1: 0, fx2: 0, p2: 0 };
    s.patterns = [pat];
    const d = encodeSong(s);
    expect(new TextDecoder().decode(d.subarray(0, 8))).toBe('MYM0TRAK');
    expect(d[1096]).toBe(2); expect(d[1097]).toBe(1);
    expect(d.length).toBe(SONG_HEADER + 2 * 8);                 // row 0 (+39 empty), row 40 (+23 empty)
    expect(Array.from(d.subarray(SONG_HEADER, SONG_HEADER + 8))).toEqual([60, 1, 0x10, 0x53, 3, 0, 0, 39]);
    expect(Array.from(d.subarray(SONG_HEADER + 8, SONG_HEADER + 16))).toEqual([1, 0, 0, 0, 0, 0, 0, 23]);
    const back = decodeSong(d);
    expect(back.patterns).toEqual(s.patterns);
    expect(back.orders.slice(0, 2)).toEqual(s.orders);
    expect(back.state[14]).toBe(50);
  });

  it('lays out the voice bank like the editor does', () => {
    const b = newMymBank();
    b.sequences = [{ values: [0], length: 1, repeat: 0 }, { values: [15, 14, 9], length: 3, repeat: 2 }];
    b.instruments[0][INST.volSeq] = 1;
    b.samples[0] = { pcm: Uint8Array.from([1, 2, 3, 4, 5]), params: new Uint8Array(4) };
    const d = encodeBank(b);
    expect(new TextDecoder().decode(d.subarray(32, 40))).toBe('MYM0INST');
    const seqAt = 2120 + 64;                                      // after the header, sequence 1
    expect(d[seqAt + 62]).toBe(3); expect(d[seqAt + 63]).toBe(2);
    expect((d[seqAt] << 8) | d[seqAt + 1]).toBe(15);
    const end = 2120 + 2 * 64;
    expect(new TextDecoder().decode(d.subarray(end, end + 8))).toBe('MYM1DIGI');
    // pointers are relative to their own position
    const p0 = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
    expect(p0).toBe(end + 8);
    expect(Array.from(d.subarray(p0, p0 + 5))).toEqual([1, 2, 3, 4, 5]);
    const back = decodeBank(d);
    expect(back.sequences).toEqual(b.sequences);
    expect(Array.from(back.samples[0].pcm)).toEqual([1, 2, 3, 4, 5]);
    expect(back.instruments[0][INST.volSeq]).toBe(1);
  });

  it('writes a single instrument with its seven sequences', () => {
    const inst = new Uint8Array(48); inst[16 + 16] = 2;
    const d = encodeInstrument({ version: 0, inst, sequences: [{ values: [15, 10], length: 2, repeat: 1 }] });
    expect(new TextDecoder().decode(d.subarray(0, 8))).toBe('MYM0.MYI');
    expect(d.length).toBe(8 + 48 + 7 * 64);
    const back = decodeInstrument(d);
    expect(back.sequences[0]).toEqual({ values: [15, 10], length: 2, repeat: 1 });
    expect(back.inst[INST.seqSpeed]).toBe(2);
  });

  it('rejects other data', () => {
    expect(() => decodeSong(new Uint8Array(1200))).toThrow();
    expect(() => decodeBank(new Uint8Array(3000))).toThrow();
    expect(() => decodeInstrument(new Uint8Array(600))).toThrow();
  });
});

describe('song -> maxYMiser', () => {
  it('maps notes, instruments, tempo and the volume sequence', () => {
    const s = mkSong();
    s.instruments[1].adsr = { useAdsr: true, attack: 0, decay: 8, sustain: 6, release: 0 };
    s.patterns[0].cells[0][0] = cell(49, 1);
    s.patterns[0].cells[8][0] = cell(NOTE_OFF);
    s.patterns[0].cells[4][1] = cell(53, 1);
    const r = songToMaxymiser(s);
    const song = decodeSong(r.mys), bank = decodeBank(r.myv);
    expect(song.state[13]).toBe(6);                                   // calls per row
    expect(song.state[14]).toBe(50);                                  // 125 BPM = 50 Hz
    expect(song.length).toBe(1);
    const p0 = song.patterns[song.orders[0][0]];
    expect(p0[0].note).toBe(mymNote(49)); expect(p0[0].inst).toBe(1);
    expect(p0[8].note).toBe(1);                                       // note-off
    expect(song.orders[0][3]).toBe(0xff);                             // no DMA track
    const rec = bank.instruments[0];
    expect(rec[INST.seqSpeed]).toBe(1);
    expect(rec[INST.mixSeq]).not.toBe(0);
    const vol = bank.sequences[rec[INST.volSeq]];
    expect(vol.values[0]).toBe(LINEAR_TO_YM_VOL[64]);                 // full level on the first tick
    expect(vol.values[vol.length - 1]).toBe(LINEAR_TO_YM_VOL[Math.round((6 / 15) * 64)]);   // sustain level held
    expect(vol.repeat).toBe(vol.length - 1);
    expect(r.stats.instruments).toBe(1);
  });

  it('follows tempo: 150 BPM = 60 Hz, below 125 BPM is clamped with a warning', () => {
    const s = mkSong(); s.bpm = 150; s.patterns[0].cells[0][0] = cell(49, 1);
    expect(decodeSong(songToMaxymiser(s).mys).state[14]).toBe(60);
    s.bpm = 100;
    const r = songToMaxymiser(s);
    expect(decodeSong(r.mys).state[14]).toBe(50);
    expect(r.warnings.some((w) => /tempo/.test(w))).toBe(true);
  });

  it('ends short patterns with a pattern break and keeps the loop point', () => {
    const s = mkSong();
    s.patterns[0] = emptyPattern(16, 3);
    s.patterns[0].cells[0][0] = cell(49, 1);
    const r = songToMaxymiser(s);
    const song = decodeSong(r.mys);
    const rows = song.patterns[song.orders[0][0]];
    const brk = [rows[15].fx1, rows[15].fx2].includes('B'.charCodeAt(0));
    expect(brk).toBe(true);
    expect(song.repeat).toBe(0);
  });

  it('uses volume column attenuation and keeps effects in two slots', () => {
    const s = mkSong();
    s.patterns[0].cells[0][0] = cell(49, 1, 'C', 32);                 // half volume
    s.patterns[0].cells[2][0] = cell(52, 1, '0', 0x47);               // arpeggio
    s.patterns[0].cells[4][0] = cell(52, 1, '1', 4);                  // slide up
    const r = songToMaxymiser(s);
    const song = decodeSong(r.mys);
    const p = song.patterns[song.orders[0][0]];
    expect(p[0].vol).toBe(0x10 | (15 - LINEAR_TO_YM_VOL[32]));
    expect(String.fromCharCode(p[2].fx1)).toBe('X'); expect(p[2].p1).toBe(0x47);
    expect(String.fromCharCode(p[4].fx1)).toBe('H');
    // the arpeggio is switched off again on the next row without one
    const q = song.patterns[song.orders[0][0]];
    expect(String.fromCharCode(q[3].fx1)).toBe('X'); expect(q[3].p1).toBe(0);
  });

  it('plays a release as a fade instrument and does not run past 32 instruments', () => {
    const s = mkSong();
    s.instruments[1].adsr = { useAdsr: true, attack: 0, decay: 0, sustain: 12, release: 4 };
    s.patterns[0].cells[0][0] = cell(49, 1);
    s.patterns[0].cells[16][0] = cell(NOTE_OFF);
    const r = songToMaxymiser(s);
    const song = decodeSong(r.mys), bank = decodeBank(r.myv);
    const off = song.patterns[song.orders[0][0]][16];
    expect(off.note).toBe(mymNote(49));                               // re-triggered, not a plain note-off
    expect(off.inst).toBe(2);
    const fade = bank.sequences[bank.instruments[1][INST.volSeq]].values;
    expect(fade[0]).toBeGreaterThan(fade[1]); expect(fade[fade.length - 1]).toBe(0);

    const big = mkSong();
    for (let i = 1; i <= 40; i++) { big.instruments[i] = { ...big.instruments[1], name: `i${i}` }; }
    for (let r2 = 0; r2 < 40; r2++) big.patterns[0].cells[r2][r2 % 3] = cell(49, r2 + 1);
    const rr = songToMaxymiser(big);
    expect(rr.stats.instruments).toBe(32);
    expect(rr.warnings.some((w) => /instruments are used/.test(w))).toBe(true);
  });

  it('reports what it leaves out', () => {
    const s = mkSong();
    s.patterns[0].cells[0][0] = cell(49, 1, '7', 0x24);
    s.patterns[0].cells[2][0] = cell(49, 1, 'A', 0x04);
    const r = songToMaxymiser(s);
    expect(r.warnings.some((w) => /tremolo/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /volume slides/.test(w))).toBe(true);
  });

  it('exports a single instrument as .myi', () => {
    const s = mkSong();
    s.instruments[2].useHardEnv = true; s.instruments[2].hardEnvShape = 12;
    const { data } = instrumentToMyi(s.instruments[2]);
    const f = decodeInstrument(data);
    expect(f.inst[INST.wave]).toBe(12);
    expect(f.sequences[3].values[0] & 0xf0).not.toBe(0);              // buzzer bit in the mixer sequence
  });
});

describe('song -> maxYMiser: digidrums', () => {
  const kick = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 16);
  const snare = Uint8Array.from({ length: 500 }, (_, i) => (i * 5 + 3) % 16);
  const withDrums = () => {
    const s = mkSong();
    s.instruments[2].digiDrums = [{ name: 'kick', pcm: kick, rateHz: 9452 }, { name: 'snare', pcm: snare, rateHz: 12000 }];
    return s;
  };
  it('writes samples through the DAC table and plays them with digi instruments', () => {
    const s = withDrums();
    s.patterns[0].cells[0][1] = cell(49, 2, 'Z', 1);
    s.patterns[0].cells[8][1] = cell(49, 2, 'Z', 2);
    s.patterns[0].cells[16][1] = cell(49, 2, 'Z', 1);
    const r = songToMaxymiser(s);
    const song = decodeSong(r.mys), bank = decodeBank(r.myv);
    expect(r.stats.samples).toBe(2);
    expect(bank.samples[0].pcm.length).toBe(300);
    expect(bank.samples[0].pcm[1]).toBe(142);                           // level 7 -> DAC byte
    expect(bank.samples[0].pcm[0]).toBe(128);                           // level 0
    const t1 = song.patterns[song.orders[0][1]];
    const k = bank.instruments[t1[0].inst - 1];
    expect(bank.sequences[k[INST.mixSeq]].values[0]).toBe(0x000d);
    expect(k[INST.sample]).toBe(1);
    expect(k[INST.sampleRate]).toBe(Math.round(2457600 / (4 * mfpRate(9452).hz)));
    expect(bank.instruments[t1[8].inst - 1][INST.sample]).toBe(2);
    expect(t1[16].inst).toBe(t1[0].inst);                               // same drum, same instrument
    expect(r.warnings.some((w) => /digidrum/i.test(w))).toBe(false);
  });
  it('plays the drum channel on voice C and comes back through the importer unchanged', () => {
    const s = withDrums();
    s.channelCount = 4; s.drumChannel = 3; s.patterns[0] = emptyPattern(64, 4);
    s.patterns[0].cells[0][3] = cell(1, 2);
    s.patterns[0].cells[4][3] = cell(2);
    s.patterns[0].cells[8][0] = cell(49, 1);
    const r = songToMaxymiser(s);
    const song = decodeSong(r.mys);
    const t2 = song.patterns[song.orders[0][2]];
    expect(t2[0].inst).toBeGreaterThan(0); expect(t2[4].inst).toBeGreaterThan(0); expect(t2[4].inst).not.toBe(t2[0].inst);
    const back = maxymiserToSong(r.mys, r.myv, 'd.mys').song;
    const drums = back.instruments.flatMap((i) => i.digiDrums ?? []);
    expect(drums.length).toBe(2);
    expect(Array.from(drums[0].pcm)).toEqual(Array.from(kick));
    expect(Array.from(drums[1].pcm)).toEqual(Array.from(snare));
  });
  it('says so when the samples do not fit', () => {
    const s = mkSong();
    s.instruments[2].digiDrums = Array.from({ length: 10 }, (_, i) => ({ name: `d${i}`, pcm: Uint8Array.from({ length: 50 }, (_, k) => (k + i) % 16), rateHz: 9000 }));
    for (let i = 0; i < 10; i++) s.patterns[0].cells[i * 2][1] = cell(49, 2, 'Z', i + 1);
    const r = songToMaxymiser(s);
    expect(r.stats.samples).toBe(8);
    expect(r.warnings.some((w) => /more than 8 different digidrum/.test(w))).toBe(true);
  });
});

describe('song -> maxYMiser: timer effects', () => {
  const sidSong = (eff: string, param: number, inst = 1) => {
    const s = mkSong();
    s.instruments[2].useHardEnv = true; s.instruments[2].hardEnvShape = 12; s.instruments[2].adsr.useAdsr = false; s.instruments[2].volEnv = [15]; s.instruments[2].syncBuzz = true;
    s.patterns[0].cells[0][0] = cell(49, inst, eff, param);
    return s;
  };
  it('Q: a SID instrument with a pinned timer rate', () => {
    const r = songToMaxymiser(sidSong('Q', 0x6a));
    const song = decodeSong(r.mys), bank = decodeBank(r.myv);
    const inst = bank.instruments[song.patterns[song.orders[0][0]][0].inst - 1];
    expect(bank.sequences[inst[INST.mixSeq]].values[0] & 15).toBe(5);
    expect(bank.sequences[inst[INST.timSeq]].values).toEqual([15, 0]);
    expect(inst[INST.fixMask] & 1).toBe(1);
    const period = bank.sequences[inst[INST.fixSeq]].values[0];
    const want = 20 * Math.pow(2, 10 + 6 / 16);                           // clamped by the MFP: nearest it can do
    const hz = timerFrequency(period, 5, 2);
    expect(hz / Math.min(want, 19819)).toBeGreaterThan(0.93); expect(hz / Math.min(want, 19819)).toBeLessThan(1.07);
    expect(song.state[36]).toBe(7);                                       // timers enabled
  });
  it('S: a sixteen-step waveform; U: a buzzer shape at the timer rate', () => {
    const rs = songToMaxymiser(sidSong('S', 0x04));
    const bs = decodeBank(rs.myv), ss = decodeSong(rs.mys);
    const i1 = bs.instruments[ss.patterns[ss.orders[0][0]][0].inst - 1];
    const wave = bs.sequences[i1[INST.timSeq]];
    expect(wave.length).toBe(16);
    expect(Math.min(...wave.values)).toBeLessThan(5); expect(Math.max(...wave.values)).toBe(15);     // some peak, some silence
    expect(timerFrequency(bs.sequences[i1[INST.fixSeq]].values[0], 5, 16)).toBeGreaterThan(0.9 * 16 * fxParamHz(0x04) / 2);

    const ru = songToMaxymiser(sidSong('U', 0x20, 2));
    const bu = decodeBank(ru.myv), su = decodeSong(ru.mys);
    const i2 = bu.instruments[su.patterns[su.orders[0][0]][0].inst - 1];
    expect(bu.sequences[i2[INST.mixSeq]].values[0] & 15).toBe(11);
    expect(bu.sequences[i2[INST.timSeq]].values).toEqual([12]);
    expect(timerFrequency(bu.sequences[i2[INST.fixSeq]].values[0], 11, 1) / fxParamHz(0x20)).toBeGreaterThan(0.94);
  });
  it('re-triggers a sounding note and warns about it; the result reads back as a Q effect', () => {
    const s = mkSong();
    s.patterns[0].cells[0][0] = cell(49, 1);
    s.patterns[0].cells[8][0] = cell(0, 0, 'Q', 0x50);
    const r = songToMaxymiser(s);
    expect(r.warnings.some((w) => /already sounding/.test(w))).toBe(true);
    const back = maxymiserToSong(r.mys, r.myv, 'q.mys').song;
    const row8 = back.patterns[back.order[0]].cells[8][0];
    expect(row8.effect).toBe(parseEffectChar('Q'));
  });
  it('finds a fixed period for a wanted interrupt rate', () => {
    for (const hz of [800, 3000, 9000]) {
      const f = timerPeriodFor(5, 2, hz)!;
      expect(f).not.toBeNull();
      expect(Math.abs(Math.log(f.hz / hz))).toBeLessThan(0.06);
    }
    expect(timerPeriodFor(5, 2, 90000)).toBeNull();
  });
});
