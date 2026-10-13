import { describe, it, expect } from 'vitest';
import { newSong, emptyPattern, parseEffectChar, NOTE_OFF, EFFECT_LETTERS } from '../src/tracker/types';
import { renderSong } from '../src/tracker/render';
import { songToMaxymiser, instrumentToMyi } from '../src/maxymiser/convert';
import { maxymiserToSong, convertSong, myiToInstrument, dacLevel } from '../src/maxymiser/import';
import { newMymSong, newMymBank, emptyMymCell, INST, type MymBank, type MymSong, type MymCell } from '../src/maxymiser/format';
import { fxParamHz, fxParamForHz } from '../src/core/fx';

const cell = (note: number, instrument = 0, effect = '', param = 0, volume = 0) => ({ note, instrument, volume, effect: effect ? parseEffectChar(effect) : 0, param });
const mkSong = () => { const s = newSong(3); s.patterns[0] = emptyPattern(64, 3); s.bpm = 125; s.speed = 6; return s; };

/** audible voices of two renders must agree (volume exact, period within 1 unit) */
function sameSound(a: ReturnType<typeof renderSong>, b: ReturnType<typeof renderSong>, frames: number, tol = 1, volTol = 0) {
  const bad: string[] = [];
  for (let f = 0; f < Math.min(frames, a.nframes, b.nframes); f++) {
    const x = a.regs.subarray(f * 14, f * 14 + 14), y = b.regs.subarray(f * 14, f * 14 + 14);
    for (let c = 0; c < 3; c++) {
      const va = x[8 + c] & 31, vb = y[8 + c] & 31;
      if (Math.abs(va - vb) > volTol) { bad.push(`vol${c}@${f}`); continue; }
      if (va !== vb && (!va || !vb)) { bad.push(`vol${c}@${f}`); continue; }
      if (!va) continue;
      const ta = !(x[7] & (1 << c)), tb = !(y[7] & (1 << c));
      if (ta !== tb) bad.push(`tone${c}@${f}`);
      const pa = x[2 * c] | ((x[2 * c + 1] & 15) << 8), pb = y[2 * c] | ((y[2 * c + 1] & 15) << 8);
      if (ta && tb && Math.abs(pa - pb) > tol) bad.push(`per${c}@${f}`);
    }
  }
  return bad;
}

/** hand-made instrument record + sequences */
function bankWith(insts: { name?: string; rec?: Partial<Record<keyof typeof INST, number>>; seqs?: Partial<Record<'vol' | 'arp' | 'vib' | 'mix' | 'noise' | 'fix' | 'tim', { values: number[]; repeat?: number }>> }[]): MymBank {
  const b = newMymBank();
  const add = (v: number[], repeat?: number) => { b.sequences.push({ values: v, length: v.length, repeat: repeat ?? v.length - 1 }); return b.sequences.length - 1; };
  insts.forEach((d, i) => {
    const r = b.instruments[i];
    for (let k = 0; k < (d.name ?? '').length; k++) r[k] = d.name!.charCodeAt(k);
    r[INST.seqSpeed] = 1; r[INST.sampleRate] = 0x20;
    r[INST.portaMask] = r[INST.arpMask] = r[INST.vibMask] = r[INST.transMask] = 4;
    for (const [k, v] of Object.entries(d.rec ?? {})) r[INST[k as keyof typeof INST]] = v!;
    const q = d.seqs ?? {};
    if (q.vol) r[INST.volSeq] = add(q.vol.values, q.vol.repeat);
    if (q.arp) r[INST.arpSeq] = add(q.arp.values, q.arp.repeat);
    if (q.vib) r[INST.vibSeq] = add(q.vib.values, q.vib.repeat);
    if (q.mix) r[INST.mixSeq] = add(q.mix.values, q.mix.repeat);
    if (q.noise) r[INST.noiseSeq] = add(q.noise.values, q.noise.repeat);
    if (q.fix) r[INST.fixSeq] = add(q.fix.values, q.fix.repeat);
    if (q.tim) r[INST.timSeq] = add(q.tim.values, q.tim.repeat);
  });
  return b;
}
function songWith(rows: Partial<MymCell>[][], opts: { speed?: number; tc?: number; length?: number; repeat?: number } = {}): MymSong {
  const s = newMymSong();
  s.state[13] = opts.speed ?? 6; s.state[14] = opts.tc ?? 50;
  const mk = (r: Partial<MymCell>[] ): MymCell[] => Array.from({ length: 64 }, (_, i) => ({ ...emptyMymCell(), ...(r[i] ?? {}) }));
  s.patterns = rows.map(mk);
  s.orders = [rows.map((_, i) => i).concat([0xff, 0xff, 0xff, 0xff]).slice(0, 3).concat([0xff])];
  s.length = opts.length ?? 1; s.repeat = opts.repeat ?? 0;
  return s;
}
const L = (c: string) => c.charCodeAt(0);

describe('maxYMiser import: round trip through the exporter', () => {
  it('plays the same notes, volumes, arpeggios and slides', () => {
    const s = mkSong();
    s.instruments[1].adsr = { useAdsr: true, attack: 0, decay: 6, sustain: 7, release: 0 };
    s.instruments[2].adsr = { useAdsr: true, attack: 2, decay: 0, sustain: 15, release: 0 };
    s.instruments[2].noiseEnabled = true; s.instruments[2].toneEnabled = false; s.instruments[2].noisePeriod = 9;
    const P = s.patterns[0];
    P.cells[0][0] = cell(49, 1);
    P.cells[8][0] = cell(52, 1, '0', 0x47);
    P.cells[16][0] = cell(56, 1, '1', 4);
    P.cells[24][0] = cell(NOTE_OFF);
    P.cells[4][1] = cell(37, 2);
    P.cells[12][1] = cell(40, 1, 'C', 32);
    P.cells[20][2] = cell(61, 1);
    P.cells[28][2] = cell(63, 1, 'F', 3);
    P.cells[32][2] = cell(60, 1);
    const r = songToMaxymiser(s);
    const back = maxymiserToSong(r.mys, r.myv, 'rt.mys');
    expect(back.song.bpm).toBe(125);
    expect(back.song.speed).toBe(6);
    const a = renderSong(s), b = renderSong(back.song);
    expect(sameSound(a, b, 64 * 6, 1, 1)).toEqual([]);
  });

  it('keeps a short pattern, the loop point and the instrument names', () => {
    const s = mkSong();
    s.patterns[0] = emptyPattern(16, 3);
    s.patterns.push(emptyPattern(32, 3));
    s.order = [0, 1]; s.restartPos = 1;
    s.instruments[1].name = 'Lead one';
    s.patterns[0].cells[0][0] = cell(49, 1);
    s.patterns[1].cells[0][1] = cell(51, 1);
    const r = songToMaxymiser(s);
    const back = maxymiserToSong(r.mys, r.myv).song;
    expect(back.order.length).toBe(2);
    expect(back.patterns[back.order[0]].rows).toBe(16);
    expect(back.patterns[back.order[1]].rows).toBe(32);
    expect(back.restartPos).toBe(1);
    expect(back.instruments[1].name).toBe('Lead one');
  });

  it('turns fractional step-table tuning (E) into tuned copies of the instrument', () => {
    const s = mkSong();
    s.instruments[1].seq = { steps: [{ vol: 15, semi: 0.3, noise: 0, tone: true }, { vol: 12, semi: 0.3, noise: 0, tone: true }], loopFrom: 1, velocity: true, release: 0 };
    s.patterns[0].cells[0][0] = cell(49, 1);
    s.patterns[0].cells[8][0] = cell(61, 1);
    const r = songToMaxymiser(s);
    const back = maxymiserToSong(r.mys, r.myv).song;
    expect(sameSound(renderSong(s), renderSong(back), 16 * 6, 3)).toEqual([]);
  });

  it('reads a single .myi', () => {
    const s = mkSong();
    s.instruments[2].useHardEnv = true; s.instruments[2].hardEnvShape = 12; s.instruments[2].adsr.useAdsr = false; s.instruments[2].volEnv = [15];
    const { data } = instrumentToMyi(s.instruments[2]);
    const { inst } = myiToInstrument(data);
    expect(inst.useHardEnv).toBe(true);
    expect(inst.hardEnvShape).toBe(12);
  });
});

describe('maxYMiser import: reading a hand-made song', () => {
  it('maps notes, volume column, speed, pattern break and note-off patterns', () => {
    const bank = bankWith([{ name: 'saw', seqs: { vol: { values: [15, 12, 9], repeat: 2 }, mix: { values: [0x0100] } } }]);
    const song = songWith([[
      { note: 60, inst: 1, vol: 0x13, fx1: L('S'), p1: 4 },
      { note: 1 },
      { note: 62, inst: 1, fx1: L('B') },
    ]], { tc: 60 });
    const r = convertSong(song, bank, 'x.mys');
    const s = r.song;
    expect(s.bpm).toBe(150);
    const p = s.patterns[s.order[0]];
    expect(p.rows).toBe(3);
    expect(p.cells[0][0].note).toBe(49);
    expect(p.cells[0][0].volume).toBe(0x10 + Math.round(64 * Math.pow(2, -1.5)));      // attenuation 3
    expect(EFFECT_LETTERS[p.cells[0][0].effect - 1]).toBe('F');
    expect(p.cells[0][0].param).toBe(4);
    expect(p.cells[1][0].note).toBe(NOTE_OFF);
    const steps = s.instruments[1].seq!.steps;
    expect(steps.map((x) => x.vol)).toEqual([15, 12, 9]);
    expect(s.instruments[1].seq!.loopFrom).toBe(2);
  });

  it('skips jam patterns, restarts at the right position and says what it leaves out', () => {
    const bank = bankWith([{ name: 'a', seqs: { vol: { values: [15] }, mix: { values: [0x0100] } } }]);
    const song = songWith([[{ note: 60, inst: 1 }]], { length: 3, repeat: 2 });
    song.orders = [[0, 0xff, 0xff, 0xff], [0xfd, 0xff, 0xff, 0xff], [0, 0xff, 0xff, 0]];
    const r = convertSong(song, bank);
    expect(r.song.order.length).toBe(2);
    expect(r.song.restartPos).toBe(1);
    expect(r.warnings.some((w) => /jam/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /DMA/.test(w))).toBe(true);
  });

  it('honours the instrument masks for arpeggio and portamento', () => {
    const bank = bankWith([
      { name: 'on', seqs: { vol: { values: [15] }, mix: { values: [0x0100] } } },
      { name: 'off', rec: { arpMask: 0, portaMask: 0 }, seqs: { vol: { values: [15] }, mix: { values: [0x0100] } } },
    ]);
    const song = songWith([[{ note: 60, inst: 1, fx1: L('X'), p1: 0x47 }], [{ note: 60, inst: 2, fx1: L('X'), p1: 0x47 }]]);
    const r = convertSong(song, bank);
    const on = r.song.patterns[r.song.order[0]].cells[0][0], off = r.song.patterns[r.song.order[0]].cells[0][1];
    expect(on.effect).toBe(parseEffectChar('0')); expect(on.param).toBe(0x47);
    expect(off.effect).toBe(0);
  });

  it('applies the arpeggio sequence and the vibrato sequence to a step table', () => {
    const bank = bankWith([{ seqs: { vol: { values: [15] }, mix: { values: [0x0100] }, arp: { values: [0, 12, 0xfffe], repeat: 0 } } }]);
    const r = convertSong(songWith([[{ note: 60, inst: 1 }]]), bank);
    const steps = r.song.instruments[1].seq!.steps;
    expect(steps.map((x) => x.semi)).toEqual([0, 12, -2]);
    expect(r.song.instruments[1].seq!.loopFrom).toBe(0);
  });

  it('reads a digidrum instrument with its sample and plays it with Z', () => {
    const bank = bankWith([{ name: 'snare', rec: { sample: 1, sampleRate: 100 }, seqs: { vol: { values: [15] }, mix: { values: [0x000d] } } }]);
    bank.samples[0] = { pcm: Uint8Array.from([128, 129, 7, 82, 127, 216]), params: new Uint8Array(4) };
    const r = convertSong(songWith([[{ note: 60, inst: 1 }, ...Array(5).fill({}), { note: 62, inst: 1, vol: 0x14 }]]), bank);
    const d = r.song.instruments[1].digiDrums!;
    expect(d.length).toBe(2);                                                   // plain hit and the attenuated one
    expect(Array.from(d[0].pcm)).toEqual([0, 1, 13, 14, 15, 12]);
    expect(Array.from(d[1].pcm)).toEqual([0, 0, 9, 10, 11, 8]);
    expect(Math.round(d[0].rateHz)).toBe(Math.round(2457600 / 400));
    const row0 = r.song.patterns[r.song.order[0]].cells[0][0];
    expect(row0.effect).toBe(parseEffectChar('Z')); expect(row0.param).toBe(1);
    expect(r.song.patterns[r.song.order[0]].cells[6][0].param).toBe(2);
    expect(renderSong(r.song).drums).toBeDefined();
  });

  it('puts a Q / S / U effect next to notes of SID and sync-buzzer instruments', () => {
    const bank = bankWith([
      { name: 'sid', seqs: { vol: { values: [15] }, mix: { values: [0x0005] }, tim: { values: [15, 0] } } },
      { name: 'sine', seqs: { vol: { values: [15] }, mix: { values: [0x0005] }, tim: { values: [15, 12, 8, 5, 3, 1, 0, 0, 3, 8, 12, 15, 15, 15, 15, 15] } } },
      { name: 'sync', rec: { wave: 12, sync: 1 }, seqs: { vol: { values: [15] }, mix: { values: [0x011b] }, tim: { values: [12] } } },
    ]);
    const r = convertSong(songWith([[{ note: 60, inst: 1 }, { note: 60, inst: 2 }, { note: 60, inst: 3 }]]), bank);
    const cs = r.song.patterns[r.song.order[0]].cells;
    const q = cs[0][0], sn = cs[1][0], u = cs[2][0];
    const hz = 440 * Math.pow(2, (60 - 11 - 1 + 12 - 69) / 12);              // the note's frequency
    expect(q.effect).toBe(parseEffectChar('Q'));
    expect(fxParamHz(q.param) / (2 * hz)).toBeGreaterThan(0.97); expect(fxParamHz(q.param) / (2 * hz)).toBeLessThan(1.03);
    expect(sn.effect).toBe(parseEffectChar('S'));
    expect(fxParamHz(sn.param) / (2 * hz)).toBeGreaterThan(0.97); expect(fxParamHz(sn.param) / (2 * hz)).toBeLessThan(1.03);
    expect(u.effect).toBe(parseEffectChar('U'));
    expect(r.song.instruments[3].useHardEnv).toBe(true);
    expect(r.song.instruments[3].hardEnvShape).toBe(12);
    expect(renderSong(r.song).fx).toBeDefined();
  });

  it('refuses data that is not a song', () => {
    expect(() => maxymiserToSong(new Uint8Array(1200), null)).toThrow();
  });
});

describe('digidrum sample conversion', () => {
  it('maps every YM DAC level to its signed byte and back', () => {
    const PCM = [128, 129, 130, 132, 133, 135, 138, 142, 148, 157, 170, 189, 216, 7, 82, 127];
    PCM.forEach((b, lvl) => expect(dacLevel(b)).toBe(lvl));
  });
  it('picks the Q/S/U parameter nearest to a rate', () => {
    for (const hz of [60, 200, 1000, 4000, 12000]) {
      const p = fxParamForHz(hz);
      expect(Math.abs(Math.log(fxParamHz(p) / hz))).toBeLessThan(0.03);
    }
  });
});
