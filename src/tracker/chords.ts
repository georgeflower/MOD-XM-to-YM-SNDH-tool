/**
 * Chord names for arpeggios (0xy effects, instrument arpeggio macros) and the major <-> minor switch.
 * Offsets are semitones above the written note; octave copies (12, 24 ...) do not change the chord.
 */

interface ChordDef { name: string; set: number[]; flip?: Record<number, number> }

/** pitch classes of each chord; `flip` moves pitch classes to turn major into minor and back (same inversion) */
const CHORDS: ChordDef[] = [
  { name: 'Major', set: [0, 4, 7], flip: { 4: 3 } },
  { name: 'Minor', set: [0, 3, 7], flip: { 3: 4 } },
  { name: 'Major (1st inversion)', set: [0, 3, 8], flip: { 3: 4, 8: 9 } },
  { name: 'Minor (1st inversion)', set: [0, 4, 9], flip: { 4: 3, 9: 8 } },
  { name: 'Major (2nd inversion)', set: [0, 5, 9], flip: { 9: 8 } },
  { name: 'Minor (2nd inversion)', set: [0, 5, 8], flip: { 8: 9 } },
  { name: 'Major third', set: [0, 4], flip: { 4: 3 } },
  { name: 'Minor third', set: [0, 3], flip: { 3: 4 } },
  { name: 'Diminished', set: [0, 3, 6] },
  { name: 'Augmented', set: [0, 4, 8] },
  { name: 'Sus4', set: [0, 5, 7] },
  { name: 'Sus2', set: [0, 2, 7] },
  { name: 'Power (fifth)', set: [0, 7] },
  { name: 'Fourth', set: [0, 5] },
  { name: 'Minor sixth', set: [0, 8], flip: { 8: 9 } },
  { name: 'Major sixth', set: [0, 9], flip: { 9: 8 } },
  { name: 'Minor seventh', set: [0, 10], flip: { 10: 11 } },
  { name: 'Major seventh', set: [0, 11], flip: { 11: 10 } },
  { name: 'Minor second', set: [0, 1], flip: { 1: 2 } },
  { name: 'Major second', set: [0, 2], flip: { 2: 1 } },
  { name: 'Tritone', set: [0, 6] },
  { name: 'Minor 7th chord', set: [0, 3, 10], flip: { 3: 4 } },
  { name: 'Dominant 7th chord', set: [0, 4, 10], flip: { 4: 3 } },
  { name: 'Octave', set: [0] },
];

const pc = (v: number) => ((v % 12) + 12) % 12;
const classes = (offs: number[]) => [...new Set([0, ...offs].map(pc))].sort((a, b) => a - b);
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function chordOf(offs: number[]): ChordDef | null {
  const c = classes(offs);
  return CHORDS.find((d) => same(d.set, c)) ?? null;
}

/** name of the chord an arpeggio plays ('' when it is not a known chord) */
export function chordName(offs: number[]): string {
  return chordOf(offs)?.name ?? '';
}

/** the same arpeggio as major instead of minor (or the other way round); null when it is neither */
export function flipMajorMinor(offs: number[]): number[] | null {
  const d = chordOf(offs);
  if (!d?.flip) return null;
  return offs.map((v) => { const t = d.flip![pc(v)]; return t === undefined ? v : v + (t - pc(v)); });
}

export const isMajor = (offs: number[]) => /^Major/.test(chordName(offs));
export const isMinor = (offs: number[]) => /^Minor/.test(chordName(offs));

/** 0xy parameter <-> offsets */
export const arpOffsets = (param: number) => [(param >> 4) & 15, param & 15];
export const arpParam = (offs: number[]) => ((offs[0] & 15) << 4) | (offs[1] & 15);
