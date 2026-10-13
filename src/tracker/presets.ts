/**
 * Instrument presets for the AY pattern editor. Everything here is plain 50 Hz register work: it needs
 * no MFP timer, so it plays the same in the SNDH, YM, game-kit and maxYMiser exports.
 *
 * - chord ornaments: the arpeggio shapes AY composers (MmcM/Sage among them) use for a whole chord on one voice
 * - drums: kick / snare / hats / toms built from noise bursts and fast pitch drops (hat "F A" echo included)
 * - sync-square bass: the square wave restarts at each note so every note starts in the same phase (real YM2149, SNDH / game kit)
 * - acid bass: buzzer at the note, a square wave swept down from far above it (gwEm, "Torture Your YM", Alive 9)
 */
import { defaultInstrument, type Instrument, type StepSeq } from './types';
import type { MacroStep } from '../core/convert';

const step = (vol: number, semi = 0, noise = 0, tone = true): MacroStep => ({ vol, semi, noise, tone });
const seqOf = (steps: MacroStep[], loopFrom = -1, release = 0): StepSeq => ({ steps, loopFrom, velocity: true, release });

function chord(name: string, arp: number[]): Instrument {
  return { ...defaultInstrument(name), adsr: { useAdsr: true, attack: 0, decay: 0, sustain: 15, release: 3 }, arpMacro: arp, arpSpeed: 1 };
}
function stepped(name: string, s: StepSeq, patch: Partial<Instrument> = {}): Instrument {
  return { ...defaultInstrument(name), seq: s, ...patch };
}

export interface InstrumentPreset { group: string; name: string; make: () => Instrument }

const P = (group: string, name: string, make: () => Instrument): InstrumentPreset => ({ group, name, make });

/** acid: semitones above the note for the swept square, one entry per 20 ms */
const ACID_SWEEP = [40, 36, 32, 28, 24, 20, 16, 12, 9, 7];

export const INSTRUMENT_PRESETS: InstrumentPreset[] = [
  P('Chord ornaments', 'Minor 0 3 7', () => chord('Minor 0-3-7', [0, 3, 7])),
  P('Chord ornaments', 'Major 0 4 7', () => chord('Major 0-4-7', [0, 4, 7])),
  P('Chord ornaments', 'Minor doubled 0 0 3 3 7 7', () => chord('Minor 003377', [0, 0, 3, 3, 7, 7])),
  P('Chord ornaments', 'Major doubled 0 0 4 4 7 7', () => chord('Major 004477', [0, 0, 4, 4, 7, 7])),
  P('Chord ornaments', 'Minor + octave 0 3 7 12', () => chord('Minor 0-3-7-12', [0, 3, 7, 12])),
  P('Chord ornaments', 'Major + octave 0 4 7 12', () => chord('Major 0-4-7-12', [0, 4, 7, 12])),
  P('Chord ornaments', 'Blip 19 then note', () => stepped('Blip 19', seqOf([step(15, 19), step(15, 0), step(15, 0)], 1, 3))),
  P('Drums', 'Kick', () => stepped('Kick', seqOf([
    step(15, 24, 6), step(15, 14), step(14, 8), step(12, 4), step(10, 0), step(7, -2), step(4, -4), step(2, -6)]))),
  P('Drums', 'Snare', () => stepped('Snare', seqOf([
    step(15, 7, 10), step(14, -5, 9), step(12, 0, 7, false), step(9, 0, 7, false), step(6, 0, 8, false), step(3, 0, 8, false), step(1, 0, 8, false)]))),
  P('Drums', 'Hat closed', () => stepped('Hat closed', seqOf([step(13, 0, 2, false), step(6, 0, 2, false), step(2, 0, 2, false)]))),
  P('Drums', 'Hat open', () => stepped('Hat open', seqOf([11, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((v) => step(v, 0, 3, false))))),
  P('Drums', 'Hat F A echo', () => stepped('Hat F-A', seqOf([14, 8, 14, 8, 14, 8, 9, 5, 3].map((v) => step(v, 0, 2, false))))),
  P('Drums', 'Tom (fast slide)', () => stepped('Tom', seqOf([
    step(15, 12), step(14, 5), step(12, 0), step(10, -4), step(7, -7), step(4, -9), step(2, -11)]))),
  P('Bass', 'Punchy bass (sync-square)', () => stepped('Sync bass', seqOf([
    step(15, 12), step(15, 7), step(14), step(13), step(12), step(11), step(10), step(9), step(8), step(7), step(6), step(5), step(4), step(3), step(2), step(1)], -1, 2),
    { syncSquare: true })),
  P('Bass', 'Acid bass (buzzer + swept square)', () => stepped('Acid bass', seqOf(
    [...ACID_SWEEP.map((s) => step(15, s)), step(15, 7)], ACID_SWEEP.length, 0),
    { useHardEnv: true, hardEnvShape: 8, hardEnvAutoPeriod: true, hardEnvDivisor: 1, syncBuzz: true })),
  P('Bass', 'Acid bass (slow sweep)', () => stepped('Acid slow', seqOf(
    [...ACID_SWEEP.flatMap((s) => [step(15, s), step(15, s)]), step(15, 7)], ACID_SWEEP.length * 2, 0),
    { useHardEnv: true, hardEnvShape: 8, hardEnvAutoPeriod: true, hardEnvDivisor: 1, syncBuzz: true })),
];

export const PRESET_GROUPS = Array.from(new Set(INSTRUMENT_PRESETS.map((p) => p.group)));
