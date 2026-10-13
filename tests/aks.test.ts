import { describe, it, expect } from 'vitest';
import { newSong, defaultInstrument, parseEffectChar } from '../src/tracker/types';
import { songToAks, aksFile } from '../src/arkos/aks';
import { INSTRUMENT_PRESETS } from '../src/tracker/presets';

const cell = (note: number, instrument = 0, effect = '', param = 0, volume = 0) =>
  ({ note, instrument, volume, effect: effect ? parseEffectChar(effect) : 0, param });
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

function base() {
  const s = newSong();
  s.instruments[1] = { ...defaultInstrument('lead'), adsr: { useAdsr: true, attack: 0, decay: 0, sustain: 15, release: 0 } };
  return s;
}

describe('Arkos Tracker .aks export', () => {
  it('writes an Arkos song XML with one instrument, one subsong and the note shifted to Arkos numbering', () => {
    const s = base();
    s.patterns[0].cells[0][0] = cell(37, 1);
    const r = songToAks(s, { title: 'T & <x>', author: 'me' });
    expect(r.xml.startsWith('<?xml')).toBe(true);
    expect(r.xml).toContain('<formatVersion>3.0</formatVersion>');
    expect(r.xml).toContain('<title>T &amp; &lt;x&gt;</title>');
    expect(count(r.xml, /<subsong>/g)).toBe(1);
    expect(r.stats.instruments).toBe(1);
    expect(r.xml).toContain('<replayFrequencyHz>50</replayFrequencyHz>');
    expect(r.xml).toMatch(/<note>36<\/note>/);                    // editor note 37 = Arkos note 36
    // tags are balanced
    for (const t of ['instrument', 'cell', 'track', 'pattern', 'position', 'effect']) {
      expect(count(r.xml, new RegExp(`<${t}>`, 'g'))).toBe(count(r.xml, new RegExp(`</${t}>`, 'g')));
    }
  });

  it('replay frequency follows the BPM; Fxx < 0x20 becomes a speed track', () => {
    const s = base(); s.bpm = 150;
    s.patterns[0].cells[0][0] = cell(37, 1, 'F', 3);
    const r = songToAks(s);
    expect(r.xml).toContain('<replayFrequencyHz>60</replayFrequencyHz>');
    expect(r.xml).toMatch(/<value>3<\/value>/);
  });

  it('volume column, arpeggio and slides become Arkos effects; the arpeggio is stopped again', () => {
    const s = base();
    const p = s.patterns[0].cells;
    p[0][0] = cell(37, 1, '0', 0x37);
    p[4][0] = cell(0, 0, '', 0, 0x30);
    p[8][0] = cell(0, 0, '1', 0x04);
    p[12][0] = cell(0, 0, '', 0);
    const r = songToAks(s);
    expect(r.xml).toContain('<name>arpeggio3Notes</name>');
    expect(r.xml).toContain('<logicalValue>55</logicalValue>');                  // 0x37
    expect(r.xml).toContain('<name>volume</name>');
    expect(r.xml).toContain('<name>pitchUp</name>');
    expect(count(r.xml, /<name>arpeggio3Notes<\/name>/g)).toBeGreaterThanOrEqual(2);
  });

  it('note-off plays the silent instrument 0; tracks are shared when patterns repeat', () => {
    const s = base();
    s.patterns[0].cells[0][0] = cell(37, 1);
    s.patterns[0].cells[4][0] = cell(97, 0);
    s.patterns.push(JSON.parse(JSON.stringify(s.patterns[0])));
    s.order = [0, 1];
    const r = songToAks(s);
    expect(r.stats.positions).toBe(2);
    expect(r.stats.patterns).toBe(2);
    expect(r.stats.tracks).toBeLessThan(2 * 3 + 1);                // identical tracks are written once
  });

  it('step-table presets keep their levels; the buzzer presets use a software + hardware link', () => {
    const drum = INSTRUMENT_PRESETS.find((p) => p.name === 'Kick')!.make();
    const acid = INSTRUMENT_PRESETS.find((p) => p.name.startsWith('Acid bass (buzzer'))!.make();
    const s = newSong();
    s.instruments[1] = drum; s.instruments[2] = acid;
    s.patterns[0].cells[0][0] = cell(37, 1);
    s.patterns[0].cells[8][0] = cell(25, 2);
    const r = songToAks(s);
    expect(r.stats.instruments).toBe(2);
    expect(r.xml).toContain('<link>softwareAndHardware</link>');
    expect(r.xml).toContain('<hardwareEnvelope>8</hardwareEnvelope>');
    expect(r.xml).toContain('<isRetrig>true</isRetrig>');
  });

  it('lists what Arkos cannot play instead of dropping it silently', () => {
    const s = base();
    s.instruments[2] = INSTRUMENT_PRESETS.find((p) => p.name.startsWith('Punchy bass'))!.make();
    s.instruments[1].adsr.release = 3;
    const p = s.patterns[0].cells;
    p[0][0] = cell(37, 1, '7', 0x46);
    p[4][0] = cell(37, 2);
    p[8][0] = cell(37, 1, 'F', 0x90);
    const r = songToAks(s);
    const w = r.warnings.join('\n');
    expect(w).toMatch(/tremolo/);
    expect(w).toMatch(/sync-square/);
    expect(w).toMatch(/BPM/i);
    expect(w).not.toMatch(/release|vibrato|fractional/);          // these are exported now
  });

  it('a release tail becomes a second instrument that the note-off plays', () => {
    const s = base();
    s.instruments[1].adsr = { useAdsr: true, attack: 0, decay: 0, sustain: 12, release: 4 };
    s.patterns[0].cells[0][0] = cell(37, 1);
    s.patterns[0].cells[4][0] = cell(97, 0);
    const r = songToAks(s);
    expect(r.stats.instruments).toBe(2);                           // the instrument and its release
    expect(r.xml).toContain('(release)');
    // the tail steps down to silence (12 * (1 - k / 4) -> 9, 6, 3, then 0)
    const rel = r.xml.slice(r.xml.indexOf('(release)'));
    const vols = [...rel.slice(0, rel.indexOf('</instrument>')).matchAll(/<volume>(\d+)<\/volume>/g)].map((m) => +m[1]);
    expect(vols.at(-1)).toBe(0);
    expect(vols.length).toBe(4);
    // the note-off cell plays that instrument (not the empty one)
    expect(r.xml).toMatch(/<note>36<\/note>\s*<instrument>2<\/instrument>/);
  });

  it('K (key off) plays the release too; instruments without a tail keep the silent instrument', () => {
    const s = base();
    s.instruments[1].adsr = { useAdsr: true, attack: 0, decay: 0, sustain: 12, release: 3 };
    s.instruments[2] = { ...s.instruments[1], adsr: { useAdsr: true, attack: 0, decay: 0, sustain: 12, release: 0 } };
    s.patterns[0].cells[0][0] = cell(37, 1);
    s.patterns[0].cells[4][0] = cell(0, 0, 'K');
    s.patterns[0].cells[0][1] = cell(37, 2);
    s.patterns[0].cells[4][1] = cell(97, 0);
    const r = songToAks(s);
    expect(r.xml.match(/<instrument>2<\/instrument>/g)?.length).toBe(1);   // only channel 0's note-off uses a release instrument
    expect(r.warnings.join()).not.toMatch(/key off/);
  });

  it('the release keeps the arpeggio phase the note had reached', () => {
    const mk = (offRow: number) => {
      const s = base();
      s.instruments[1].arpMacro = [0, 4, 7, 12];
      s.instruments[1].adsr = { useAdsr: true, attack: 0, decay: 0, sustain: 12, release: 3 };
      s.patterns[0].cells[0][0] = cell(37, 1);
      s.patterns[0].cells[offRow][0] = cell(97, 0);
      return songToAks(s).xml;
    };
    // a note-off after 4 rows and after 5 rows land on different phases of the 4-step arpeggio: different tails
    const a = mk(4), b = mk(5);
    expect(a.match(/\(release\)/g)?.length).toBe(1);
    expect(a).not.toBe(b);
  });

  it('fractional-semitone step tables get one instrument copy per note with the period correction', () => {
    const s = base();
    const acid = INSTRUMENT_PRESETS.find((p) => p.name.startsWith('Acid bass (buzzer'))!.make();
    s.instruments[1] = { ...s.instruments[1], adsr: { useAdsr: false, attack: 0, decay: 0, sustain: 15, release: 0 }, seq: { steps: [{ vol: 15, semi: -0.18, noise: 0, tone: true }, { vol: 15, semi: -0.18, noise: 0, tone: true }], loopFrom: 1, release: 0, velocity: false } };
    s.instruments[2] = acid;
    s.patterns[0].cells[0][0] = cell(37, 1);
    s.patterns[0].cells[4][0] = cell(61, 1);
    s.patterns[0].cells[8][0] = cell(37, 1);
    const r = songToAks(s);
    expect(r.warnings.join()).not.toMatch(/fractional/);
    // the plain instrument plus one copy per different note (the repeated note reuses its copy)
    expect(r.stats.instruments).toBe(3);
    const pitches = [...r.xml.matchAll(/<primaryPitch>(-?\d+)<\/primaryPitch>/g)].map((m) => +m[1]);
    expect(new Set(pitches).size).toBeGreaterThan(1);
  });

  it('4xy vibrato becomes a pitch table that the cell selects; a new note switches it off again', () => {
    const s = base();
    s.patterns[0].cells[0][0] = cell(37, 1);
    s.patterns[0].cells[2][0] = cell(0, 0, '4', 0x46);
    s.patterns[0].cells[8][0] = cell(41, 1);
    const r = songToAks(s);
    expect(r.warnings.join()).not.toMatch(/vibrato/);
    expect(count(r.xml, /<isArpeggio>false<\/isArpeggio>/g)).toBe(2);        // the empty table and the vibrato
    expect(r.xml).toMatch(/<name>pitchTable<\/name>\s*<logicalValue>1<\/logicalValue>/);
    expect(r.xml).toMatch(/<name>pitchTable<\/name>\s*<logicalValue>0<\/logicalValue>/);
    const tab = r.xml.slice(r.xml.indexOf('Vibrato 1'));
    const vals = [...tab.slice(0, tab.indexOf('</values>')).matchAll(/<value>(-?\d+)<\/value>/g)].map((m) => +m[1]);
    expect(Math.max(...vals.map(Math.abs))).toBe(3);                         // depth 6 -> amplitude 3 period units
  });

  it('is a stored zip holding the XML', () => {
    const r = songToAks(base());
    const z = aksFile(r.xml, 'my song');
    expect(Array.from(z.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(new TextDecoder().decode(z)).toContain('<formatVersion>3.0</formatVersion>');
    expect(new TextDecoder().decode(z)).toContain('my song.aks');
  });
});
