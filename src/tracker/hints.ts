/** One-line explanations of cell contents for the pattern editor's status line. */
import { type Pattern, NOTE_OFF, EFFECT_LETTERS, noteName, toHex2 } from './types';

const LETTER_HELP: Record<string, string> = {
  '0': 'Arpeggio: x and y are semitones added in turn (0xy)',
  '1': 'Slide up (1xx) per tick',
  '2': 'Slide down (2xx) per tick',
  '3': 'Slide to the note (3xx)',
  '4': 'Vibrato: x speed, y depth (4xy)',
  '5': 'Slide to note + volume slide',
  '6': 'Vibrato + volume slide',
  '7': 'Tremolo: x speed, y depth',
  'A': 'Volume slide: x up, y down',
  'B': 'Jump to song position (Bxx)',
  'C': 'Set volume 00-40',
  'D': 'Pattern break to row (Dxx, decimal digits)',
  'E': 'Extended: E1y fine up, E2y fine down, ECy cut after y ticks, EDy delay y ticks, EAy/EBy fine volume',
  'F': 'Speed (F01-F1F ticks per row) or tempo (F20-FFF BPM)',
  'G': 'Global volume 00-40',
  'H': 'Global volume slide',
  'K': 'Key off (release the note)',
  'L': 'Set envelope position',
  'Q': 'SID voice: the voice volume toggles on/off at a timer rate, 20 Hz * 2^(octave y + pitch x/16). Q00 or a new note ends it',
  'S': 'Sinus-SID: like Q, but the "on" half is a sine wave. S00 or a new note ends it',
  'U': 'Sync-buzzer: the hardware envelope restarts at a timer rate (use an envelope instrument). U00 or a new note ends it',
  'Z': 'Trigger digidrum (Z00 stops)',
};

export function effectHelp(effect: number): string {
  const l = effect ? EFFECT_LETTERS[effect - 1] : '';
  return l ? (LETTER_HELP[l] ?? `Effect ${l} (not played by the YM2149 renderer)`) : '';
}

/** the note that is sounding on `channel` at `row` (walking up to the last trigger) */
function baseNote(p: Pattern, row: number, channel: number): number {
  for (let r = row; r >= 0; r--) {
    const n = p.cells[r][channel].note;
    if (n === NOTE_OFF) return 0;
    if (n) return n;
  }
  return 0;
}

/** status text for the cell under the cursor */
export function cellHint(p: Pattern, row: number, channel: number, speed: number): string {
  const c = p.cells[row][channel];
  if (!c.effect) return '';
  const l = EFFECT_LETTERS[c.effect - 1];
  const code = `${l}${toHex2(c.param)}`;
  if (l === '0' && c.param) {
    const base = baseNote(p, row, channel);
    const x = c.param >> 4, y = c.param & 15;
    if (base) {
      const nn = (n: number) => noteName(Math.min(96, base + n));
      return `${code}  ${noteName(base)} → ${nn(x)} → ${nn(y)}`;
    }
    return `${code}  +${x} / +${y} semitones`;
  }
  if (l === '1' || l === '2') return `${code}  ${l === '1' ? '+' : '−'}${c.param * Math.max(1, speed - 1)} period units per row`;
  if (l === 'F') return c.param < 0x20 ? `${code}  speed ${c.param} ticks/row` : `${code}  tempo ${c.param} BPM`;
  return `${code}  ${effectHelp(c.effect)}`;
}
