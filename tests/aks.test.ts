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
    p[0][0] = cell(37, 1, '4', 0x46);
    p[4][0] = cell(37, 2);
    p[8][0] = cell(37, 1, 'F', 0x90);
    const r = songToAks(s);
    const w = r.warnings.join('\n');
    expect(w).toMatch(/vibrato/);
    expect(w).toMatch(/sync-square/);
    expect(w).toMatch(/release/);
    expect(w).toMatch(/BPM/i);
  });

  it('is a stored zip holding the XML', () => {
    const r = songToAks(base());
    const z = aksFile(r.xml, 'my song');
    expect(Array.from(z.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(new TextDecoder().decode(z)).toContain('<formatVersion>3.0</formatVersion>');
    expect(new TextDecoder().decode(z)).toContain('my song.aks');
  });
});
