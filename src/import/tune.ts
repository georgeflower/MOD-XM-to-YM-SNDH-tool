import type { DrumTrack } from '../core/drums';
import type { FxTrack } from '../core/fx';

/** A register-dump tune (what .ym / .sndh files boil down to): 14 YM2149 registers per 50 Hz frame. */
export interface AyTune {
  title: string;
  author: string;
  comment: string;
  /** nframes * 14 bytes, R0..R13 */
  regs: Uint8Array;
  nframes: number;
  loopFrame: number;
  /** digidrum samples + triggers (YM5/YM6 files) */
  drums?: DrumTrack;
  /** timer effects: SID voice / sinus-SID / sync-buzzer (YM6 files) */
  fx?: FxTrack;
  source: 'ym' | 'sndh';
  warnings: string[];
}
