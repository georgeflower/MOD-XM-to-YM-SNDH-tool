import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { newSong, defaultInstrument, parseEffectChar, EFFECT_LETTERS, NOTE_OFF } from '../src/tracker/types';
import { songToAks, aksFile } from '../src/arkos/aks';
import { aksToSong } from '../src/arkos/import';
import { renderSong } from '../src/tracker/render';
import { crc32 } from '../src/export/zip';

const cell = (note: number, instrument = 0, effect = '', param = 0, volume = 0) =>
  ({ note, instrument, volume, effect: effect ? parseEffectChar(effect) : 0, param });

// ---- a small AT3 song writer for the tests
interface TC { i: number; note?: number; inst?: number; fx?: [string, number][] }
interface IC { v?: number; noise?: number; link?: string; arp?: number; pitch?: number; period?: number; ratio?: number; env?: number }
interface Opt {
  instruments?: { name?: string; speed?: number; loop?: boolean; loopStart?: number; end?: number; cells: IC[] }[];
  arps?: { values: number[]; speed?: number; loop?: number }[];
  pits?: { values: number[]; speed?: number; loop?: number }[];
  tracks: TC[][];
  height?: number;
  speed?: number;
  speedTrack?: [number, number][];
  hz?: number; chipHz?: number;
  version?: string;
}
function at3(o: Opt): string {
  const ins = (o.instruments ?? [{ cells: [{ v: 15 }] }]).map((x) => `<instrument><name>${x.name ?? 'I'}</name><type>psg</type><speed>${x.speed ?? 0}</speed><isRetrig>false</isRetrig><loopStartIndex>${x.loopStart ?? 0}</loopStartIndex><endIndex>${x.end ?? x.cells.length - 1}</endIndex><isLooping>${x.loop ?? true}</isLooping><cells>${x.cells.map((c) => `<cell><volume>${c.v ?? 15}</volume><noise>${c.noise ?? 0}</noise><primaryPeriod>${c.period ?? 0}</primaryPeriod><primaryArpeggioNoteInOctave>${(c.arp ?? 0) % 12}</primaryArpeggioNoteInOctave><primaryArpeggioOctave>${Math.floor((c.arp ?? 0) / 12)}</primaryArpeggioOctave><primaryPitch>${c.pitch ?? 0}</primaryPitch><link>${c.link ?? 'softwareOnly'}</link><ratio>${c.ratio ?? 4}</ratio><hardwareEnvelope>${c.env ?? 8}</hardwareEnvelope><secondaryPeriod>0</secondaryPeriod><secondaryArpeggioNoteInOctave>0</secondaryArpeggioNoteInOctave><secondaryArpeggioOctave>0</secondaryArpeggioOctave><secondaryPitch>0</secondaryPitch></cell>`).join('')}</cells></instrument>`);
  ins.unshift('<instrument><name>Empty</name><type>psg</type><speed>255</speed><isRetrig>false</isRetrig><loopStartIndex>0</loopStartIndex><endIndex>0</endIndex><isLooping>true</isLooping><cells><cell><volume>0</volume><link>noSoftwareNoHardware</link></cell></cells></instrument>');
  const expr = (e: { values: number[]; speed?: number; loop?: number }) => `<expression><name>E</name><speed>${e.speed ?? 0}</speed><shift>0</shift><loopStartIndex>${e.loop ?? 0}</loopStartIndex><endIndex>${e.values.length - 1}</endIndex><values>${e.values.map((v) => `<value>${v}</value>`).join('')}</values></expression>`;
  const empty = '<expression><name>Empty</name><speed>0</speed><shift>0</shift><loopStartIndex>0</loopStartIndex><endIndex>0</endIndex><values><value>0</value></values></expression>';
  const tracks = o.tracks.map((t, n) => `<track><index>${n}</index>${t.map((c) => `<cell><index>${c.i}</index>${c.note !== undefined ? `<note>${c.note}</note>` : ''}${c.inst !== undefined ? `<instrument>${c.inst}</instrument>` : ''}${(c.fx ?? []).map(([nm, v], k) => `<effect><index>${k}</index><name>${nm}</name><logicalValue>${v}</logicalValue></effect>`).join('')}</cell>`).join('')}</track>`).join('');
  const nt = o.tracks.length;
  return `<?xml version="1.0"?><song><formatVersion>${o.version ?? '3.0'}</formatVersion><title>T</title><author>A</author><instruments>${ins.join('')}</instruments>
<arpeggios>${[empty, ...(o.arps ?? []).map(expr)].join('')}</arpeggios><pitches>${[empty, ...(o.pits ?? []).map(expr)].join('')}</pitches>
<subsongs><subsong><title>S</title><initialSpeed>${o.speed ?? 6}</initialSpeed><loopStartPosition>0</loopStartPosition><endPosition>0</endPosition><replayFrequencyHz>${o.hz ?? 50}</replayFrequencyHz>
<psgs><psg><type>ym</type><frequencyHz>${o.chipHz ?? 2000000}</frequencyHz></psg></psgs>
<tracks>${tracks}</tracks>
<speedTracks><speedTrack><index>0</index>${(o.speedTrack ?? []).map(([i, v]) => `<cell><index>${i}</index><value>${v}</value></cell>`).join('')}</speedTrack></speedTracks>
<positions><position><patternIndex>0</patternIndex><height>${o.height ?? 16}</height><transpositions/></position></positions>
<patterns><pattern>${[0, 1, 2].map((c) => `<trackIndexes><trackIndex>${Math.min(c, nt - 1)}</trackIndex></trackIndexes>`).join('')}<speedTrackIndex><trackIndex>0</trackIndex></speedTrackIndex></pattern></patterns>
</subsong></subsongs></song>`;
}
const enc = (s: string) => new TextEncoder().encode(s);
const effLetter = (e: number) => (e ? EFFECT_LETTERS[e - 1] : '');

/** a ZIP with one deflated entry, like the files Arkos Tracker 3 writes */
function deflatedZip(name: string, content: string): Uint8Array {
  const raw = enc(content), comp = deflateRawSync(raw), nm = enc(name), crc = crc32(raw);
  const lh = new Uint8Array(30 + nm.length), lv = new DataView(lh.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, 8, true); lv.setUint32(14, crc, true); lv.setUint32(18, comp.length, true); lv.setUint32(22, raw.length, true); lv.setUint16(26, nm.length, true); lh.set(nm, 30);
  const ch = new Uint8Array(46 + nm.length), cv = new DataView(ch.buffer);
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(10, 8, true); cv.setUint32(16, crc, true); cv.setUint32(20, comp.length, true); cv.setUint32(24, raw.length, true); cv.setUint16(28, nm.length, true); cv.setUint32(42, 0, true); ch.set(nm, 46);
  const eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, ch.length, true); ev.setUint32(16, lh.length + comp.length, true);
  const out = new Uint8Array(lh.length + comp.length + ch.length + eocd.length);
  out.set(lh, 0); out.set(comp, lh.length); out.set(ch, lh.length + comp.length); out.set(eocd, lh.length + comp.length + ch.length);
  return out;
}

describe('Arkos Tracker .aks import', () => {
  it('reads a deflated archive and a plain XML file, and turns an instrument into a step table', async () => {
    const xml = at3({ instruments: [{ name: 'Pluck', cells: [{ v: 15 }, { v: 10 }, { v: 5, noise: 8 }], loop: false }], tracks: [[{ i: 0, note: 57, inst: 1 }]] });
    for (const bytes of [deflatedZip('x.aks', xml), enc(xml)]) {
      const r = await aksToSong(bytes, 'x.aks');
      expect(r.song.name).toBe('T');
      expect(r.song.bpm).toBe(125);
      expect(r.song.patterns[0].rows).toBe(16);
      const c = r.song.patterns[0].cells[0][0];
      expect(c.note).toBe(58);                                     // Arkos note 57 = editor note 58 (A-4)
      expect(c.instrument).toBe(1);
      const seq = r.song.instruments[1].seq!;
      expect(seq.velocity).toBe(true);
      expect(seq.steps.slice(0, 3).map((s) => s.vol)).toEqual([15, 10, 5]);
      expect(seq.steps[2].noise).toBe(8);
      expect(seq.steps[3].vol).toBe(0);                            // a one-shot instrument ends silent
    }
  });

  it('honours the instrument speed (a cell lasts speed + 1 ticks) and loops back to the loop start', async () => {
    const xml = at3({ instruments: [{ speed: 1, cells: [{ v: 15 }, { v: 9 }, { v: 6 }], loopStart: 1 }], tracks: [[{ i: 0, note: 40, inst: 1 }]] });
    const seq = (await aksToSong(enc(xml))).song.instruments[1].seq!;
    expect(seq.steps.map((s) => s.vol)).toEqual([15, 15, 9, 9, 6, 6]);
    expect(seq.loopFrom).toBe(2);
  });

  it('an arpeggio table or an inline arpeggio is baked into a copy of the instrument', async () => {
    const xml = at3({
      arps: [{ values: [0, 4, 7] }],
      tracks: [[{ i: 0, note: 40, inst: 1, fx: [['arpeggioTable', 1]] }, { i: 8, note: 40, inst: 1, fx: [['arpeggio3Notes', 0x37]] }, { i: 12, note: 40, inst: 1, fx: [['reset', 0]] }]],
    });
    const r = await aksToSong(enc(xml));
    const p = r.song.patterns[0].cells;
    expect(p[0][0].instrument).not.toBe(1);                         // a copy
    expect(r.song.instruments[p[0][0].instrument].seq!.steps.map((s) => s.semi).slice(0, 3)).toEqual([0, 4, 7]);
    expect(r.song.instruments[p[8][0].instrument].seq!.steps.map((s) => s.semi).slice(0, 3)).toEqual([0, 3, 7]);
    expect(p[12][0].instrument).toBe(1);                            // reset: the plain instrument again
    // the copy loops after the three arpeggio steps
    expect(r.song.instruments[p[0][0].instrument].seq!.steps.length).toBe(3);
    expect(r.song.instruments[p[0][0].instrument].seq!.loopFrom).toBe(0);
  });

  it('a pitch table becomes a fractional pitch offset for that note', async () => {
    const xml = at3({ pits: [{ values: [0, 10, 0, -10] }], tracks: [[{ i: 0, note: 57, inst: 1, fx: [['pitchTable', 1]] }]] });
    const r = await aksToSong(enc(xml));
    const steps = r.song.instruments[r.song.patterns[0].cells[0][0].instrument].seq!.steps;
    expect(steps.length).toBe(4);
    expect(steps[0].semi).toBeCloseTo(0, 6);
    // A-4 is period 284 at 2 MHz; a table value of 10 lowers the pitch (period 274 -> raises it): 284 / 274 is 0.62 semitones up
    expect(steps[1].semi).toBeCloseTo(12 * Math.log2(284 / 274), 2);
    expect(steps[3].semi).toBeCloseTo(12 * Math.log2(284 / 294), 2);
  });

  it('a volume slide that starts with a note is baked into the instrument; the volume column carries plain changes', async () => {
    const xml = at3({
      tracks: [[{ i: 0, note: 40, inst: 1, fx: [['volume', 15], ['volumeOut', 0x0100]] }, { i: 8, note: 44, inst: 1, fx: [['volume', 11]] }]],
    });
    const r = await aksToSong(enc(xml));
    const p = r.song.patterns[0].cells;
    const faded = r.song.instruments[p[0][0].instrument].seq!;
    expect(faded.velocity).toBe(false);
    expect(faded.steps.slice(0, 4).map((s) => s.vol)).toEqual([14, 13, 12, 11]);      // -1 per tick, the slide is applied on the first tick
    expect(p[0][0].volume).toBe(0);                                                      // full editor volume
    expect(p[8][0].instrument).toBe(1);
    expect(p[8][0].volume).toBe(0x10 + 16);                                              // volume 11 -> 16/64
  });

  it('glides, pitch slides, speed changes, transposition, note off and the replay frequency', async () => {
    const xml = at3({
      hz: 60, speed: 5, speedTrack: [[4, 3]],
      tracks: [[
        { i: 0, note: 40, inst: 1 },
        { i: 2, note: 47, fx: [['pitchGlide', 0x0800]] },
        { i: 6, fx: [['pitchUp', 0x0400]] },
        { i: 10, note: 40, inst: 0 },
      ]],
    });
    const r = await aksToSong(enc(xml));
    expect(r.song.bpm).toBe(150);
    expect(r.song.speed).toBe(5);
    const p = r.song.patterns[0].cells;
    expect(p[2][0].note).toBe(48);
    expect(effLetter(p[2][0].effect)).toBe('3');
    expect(p[2][0].param).toBe(10);                                                      // 8 units/tick over 5 ticks per row, 4 effective: 8 * 5/4 at 2 MHz
    expect(effLetter(p[6][0].effect)).toBe('1');                                         // a pitch slide repeats on every following row
    expect(effLetter(p[7][0].effect)).toBe('1');
    expect(p[10][0].note).toBe(NOTE_OFF);
    expect(effLetter(p[4][1].effect) + effLetter(p[4][0].effect) + effLetter(p[4][2].effect)).toContain('F');     // speed track -> Fxx
    const f = p[4].find((c) => effLetter(c.effect) === 'F')!;
    expect(f.param).toBe(3);
  });

  it('envelope cells make a buzzer instrument; plain-tone cells in it keep their own sound', async () => {
    const xml = at3({
      instruments: [{ name: 'Kick', cells: [{ link: 'softwareToHardware', ratio: 4, env: 10, v: 16 }, { link: 'softwareOnly', v: 9 }] }],
      tracks: [[{ i: 0, note: 40, inst: 1 }]],
    });
    const ins = (await aksToSong(enc(xml))).song.instruments[1];
    expect(ins.useHardEnv).toBe(true);
    expect(ins.hardEnvShape).toBe(10);
    expect(ins.hardEnvDivisor).toBe(1);
    expect(ins.seq!.steps[0].plain).toBeFalsy();
    expect(ins.seq!.steps[1].plain).toBe(true);
    expect(ins.seq!.steps[1].vol).toBe(9);
  });

  it('rejects Arkos Tracker 2 files with a clear message and warns about samples and extra PSGs', async () => {
    await expect(aksToSong(enc('<?xml version="1.0"?><aks:song xmlns:aks="x"><aks:formatVersion>1.0</aks:formatVersion></aks:song>'))).rejects.toThrow(/Arkos Tracker 2/);
    const xml = at3({ tracks: [[{ i: 0, note: 40, inst: 1 }]] }).replace('<type>psg</type><speed>0', '<type>sample</type><speed>0');
    const r = await aksToSong(enc(xml));
    expect(r.warnings.join()).toMatch(/sample/);
  });

  it('plays what our own .aks export plays', async () => {
    const s = newSong();
    s.instruments[1] = { ...defaultInstrument('lead'), adsr: { useAdsr: true, attack: 0, decay: 5, sustain: 9, release: 4 } };
    s.patterns[0].cells[0][0] = cell(49, 1);
    s.patterns[0].cells[10][0] = cell(97, 0);
    s.patterns[0].cells[12][0] = cell(53, 1, '0', 0x37);
    s.patterns[0].cells[13][0] = cell(55, 1);
    s.patterns[0].cells[16][1] = cell(37, 1, '', 0, 0x30);
    s.patterns[0].cells[24][1] = cell(97, 0);
    const a = songToAks(s);
    const back = await aksToSong(aksFile(a.xml, 'rt'), 'rt.aks');
    const A = renderSong(s), B = renderSong(back.song);
    let compared = 0, bad = 0;
    for (let f = 1; f < Math.min(A.nframes, B.nframes, 96); f++) for (let c = 0; c < 3; c++) {
      const x = A.regs.subarray(f * 14, f * 14 + 14), y = B.regs.subarray(f * 14, f * 14 + 14);
      const va = x[8 + c] & 31, vb = y[8 + c] & 31;
      if (!va && !vb) continue;
      compared++;
      const pa = x[2 * c] | ((x[2 * c + 1] & 15) << 8), pb = y[2 * c] | ((y[2 * c + 1] & 15) << 8);
      if (Math.abs(va - vb) > 1 || Math.abs(pa - pb) > Math.max(2, pa * 0.01)) bad++;
    }
    expect(compared).toBeGreaterThan(40);
    expect(bad / compared).toBeLessThan(0.05);
  });
});
