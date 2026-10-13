/**
 * Pattern-song model. Field names and numbering follow the YM Tracker (st-tune-master) so that
 * .ymt files go both ways: XM-style cells, FT2 effect letters, ADSR / hardware-envelope instruments.
 *
 * Differences: a song here drives ONE YM2149 (3 voices at 50 Hz). Channels >= 3 are kept in files
 * (so a 2-chip YM Tracker song survives a load/save) but are not rendered.
 * Instruments may carry an optional per-tick step table (`seq`) — the same thing the converter's
 * macro editor edits — which the YM Tracker ignores.
 */
import type { MacroStep } from '../core/convert';
import type { DrumSample } from '../core/drums';

export type Note = number;                 // 0 none, 1..96 (C-1..B-8), 97 key-off
export const NOTE_NONE = 0;
export const NOTE_OFF = 97;

export interface Cell {
  note: Note;
  instrument: number;                      // 0 = none, 1..255
  volume: number;                          // 0 = none, 0x10..0x50 = set volume 0..64
  effect: number;                          // 0 = none, 1-based index into EFFECT_LETTERS
  param: number;                           // 0..255
}

export interface Pattern { rows: number; cells: Cell[][] }   // cells[row][channel]

export const NUM_CHANNELS = 3;
export const MAX_CHANNELS = 7;
export const VOICES = 3;

export function channelsOf(song: { channelCount?: number }): number {
  return song.channelCount && song.channelCount > 0 ? song.channelCount : NUM_CHANNELS;
}
export function drumChannelOf(song: { drumChannel?: number; channelCount?: number }): number {
  return typeof song.drumChannel === 'number' ? song.drumChannel : -1;
}

export const emptyCell = (): Cell => ({ note: 0, instrument: 0, volume: 0, effect: 0, param: 0 });
export function emptyPattern(rows = 64, channelCount = NUM_CHANNELS): Pattern {
  const cells: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < channelCount; c++) row.push(emptyCell());
    cells.push(row);
  }
  return { rows, cells };
}
export const isEmptyCell = (c: Cell) => !c.note && !c.instrument && !c.volume && !c.effect && !c.param;

export interface ADSR { useAdsr: boolean; attack: number; decay: number; sustain: number; release: number }

/** 4-bit digidrum (pcm bytes are YM volume steps 0..15) */
export type DigiDrumSample = DrumSample;

/** Step table instrument (this tool's extension). One step = one tick. */
export interface StepSeq {
  steps: MacroStep[];
  /** step to jump back to after the last; -1 = play once then silent */
  loopFrom: number;
  /** scale by note volume / global volume in the log domain (3 dB per AY step) */
  velocity: boolean;
  /** ticks of fade-out after a key-off (0 = cut) */
  release: number;
}

export interface Instrument {
  name: string;
  adsr: ADSR;
  volEnv: number[];
  volSustain: number;
  volRelease: number[];
  useHardEnv: boolean;
  hardEnvShape: number;
  hardEnvPeriod: number;
  hardEnvAutoPeriod: boolean;
  hardEnvDivisor: number;
  syncBuzz: boolean;
  noiseEnabled: boolean;
  noisePeriod: number;
  toneEnabled: boolean;
  arpMacro: number[];
  pitchMacro: number[];
  arpSpeed: number;
  vibratoSpeed: number;
  vibratoDepth: number;
  phase?: number;
  dutyPercent?: number;
  noiseAnd?: number;
  noiseOr?: number;
  channelMode?: number;
  wavetableMacro?: number[];
  digiDrums?: DigiDrumSample[];
  /** extension: when present the step table drives volume / pitch offset / noise / tone */
  seq?: StepSeq;
}

export function defaultInstrument(name = ''): Instrument {
  return {
    name,
    adsr: { useAdsr: true, attack: 0, decay: 0, sustain: 15, release: 8 },
    volEnv: [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
    volSustain: -1, volRelease: [],
    useHardEnv: false, hardEnvShape: 10, hardEnvPeriod: 0, hardEnvAutoPeriod: true, hardEnvDivisor: 1, syncBuzz: false,
    noiseEnabled: false, noisePeriod: 16, toneEnabled: true,
    arpMacro: [0], pitchMacro: [0], arpSpeed: 1, vibratoSpeed: 0, vibratoDepth: 0, phase: 0,
    digiDrums: [],
  };
}

export interface Song {
  name: string;
  author?: string;
  bpm: number;
  speed: number;
  step: number;
  order: number[];
  patterns: Pattern[];
  instruments: Instrument[];            // [0] unused
  restartPos: number;
  channelNames?: string[];
  channelCount?: number;
  drumChannel?: number;
}

export const defaultChannelNames = (count = NUM_CHANNELS) => Array.from({ length: count }, (_, i) => ['A', 'B', 'C'][i] ?? `Ch ${i + 1}`);

export function newSong(channelCount = NUM_CHANNELS): Song {
  const instruments: Instrument[] = [defaultInstrument('--')];
  for (let i = 1; i <= 16; i++) instruments.push(defaultInstrument(`Instrument ${i}`));
  return {
    name: 'Untitled', author: '', bpm: 125, speed: 6, step: 1, order: [0],
    patterns: [emptyPattern(64, channelCount)], instruments, restartPos: 0,
    channelNames: defaultChannelNames(channelCount), channelCount, drumChannel: -1,
  };
}

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
export function noteName(n: Note): string {
  if (n === 0) return '...';
  if (n === NOTE_OFF) return '===';
  const idx = n - 1;
  return NOTE_NAMES[idx % 12] + (Math.floor(idx / 12) + 1);
}
/** Same convention as the YM Tracker: the sounding pitch is one octave below the displayed name. */
export function noteToFreq(n: Note): number {
  if (n <= 0 || n >= NOTE_OFF) return 0;
  const midi = n - 1 + 24 - 12;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export const EFFECT_LETTERS = '0123456789ABCDEFGHKLMPRTXYQSUZ';
export const effectChar = (e: number) => (!e ? '.' : EFFECT_LETTERS[e - 1] ?? '.');
export function parseEffectChar(ch: string): number {
  const i = EFFECT_LETTERS.indexOf(ch.toUpperCase());
  return i < 0 ? 0 : i + 1;
}
export const FX = (letter: string) => EFFECT_LETTERS.indexOf(letter) + 1;

export const toHex2 = (n: number) => (Math.trunc(n) & 0xff).toString(16).toUpperCase().padStart(2, '0');
export const clampVolume = (n: number) => Math.max(0, Math.min(0x40, Math.trunc(n)));
