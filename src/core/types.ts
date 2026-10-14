/** Common in-memory module model shared by the XM and MOD loaders and the replayer. */

export interface Sample {
  name: string;
  /** normalised -1..1 */
  data: Float64Array;
  /** loop start / length in sample frames (16-bit data already converted to frames) */
  ls: number;
  ll: number;
  /** 0 none, 1 forward, 2 ping-pong */
  loop: 0 | 1 | 2;
  /** default volume 0..64 */
  vol: number;
  /** XM: 1/128 semitone steps. MOD: finetune -8..7 (kept separately in `modFine`). */
  fine: number;
  /** XM relative note (semitones) */
  rel: number;
  /** MOD finetune nibble 0..15 (signed -8..7) */
  modFine?: number;
}

export interface Instrument {
  name: string;
  samples: Sample[];
  /** note (0-based) -> sample index */
  keymap: number[];
  venv: [number, number][];
  vflags: number; // bit0 on, bit1 sustain, bit2 loop
  vsus: number;
  vls: number;
  vle: number;
  fade: number;
  /** auto vibrato: type, sweep, depth, rate */
  vib: [number, number, number, number];
}

/** one pattern cell. note 0 none, 1..96, 97 key off. vol is the XM volume column byte. */
export interface Cell {
  note: number;
  inst: number;
  vol: number;
  eff: number;
  par: number;
}

export interface Module {
  kind: 'xm' | 'mod';
  title: string;
  nch: number;
  order: number[];
  restart: number;
  /** patterns[p][row][channel] */
  patterns: Cell[][][];
  /** 1-based; index 0 is null */
  instruments: (Instrument | null)[];
  speed: number;
  bpm: number;
  /** MOD only: periods are Amiga periods (non-linear) */
  amiga: boolean;
  /** XM saved with the Amiga frequency table: slides and vibrato work on periods (see pitch.ts), notes and samples as in a linear XM */
  xmAmiga?: boolean;
}

export const emptyCell = (): Cell => ({ note: 0, inst: 0, vol: 0, eff: 0, par: 0 });
