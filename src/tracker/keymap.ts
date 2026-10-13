// FastTracker 2 keyboard layout for note entry (same as the YM Tracker).
//   lower row  Z S X D C V G B H N J M , L .      -> C-n .. D-(n+1)
//   upper row  Q 2 W 3 E R 5 T 6 Y 7 U I 9 O      -> C-(n+1) .. D-(n+2)
const LOW: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7,
  KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13, Period: 14,
};
const HIGH: Record<string, number> = {
  KeyQ: 0, Digit2: 1, KeyW: 2, Digit3: 3, KeyE: 4, KeyR: 5, Digit5: 6, KeyT: 7,
  Digit6: 8, KeyY: 9, Digit7: 10, KeyU: 11, KeyI: 12, Digit9: 13, KeyO: 14,
};

/** `octave` is 1-based like the displayed note names: octave 4, Z = C-4 */
export function keyToNote(code: string, octave: number): number | null {
  const semi = code in LOW ? LOW[code] : code in HIGH ? HIGH[code] + 12 : -1;
  if (semi < 0) return null;
  const n = (octave - 1) * 12 + semi + 1;
  return n >= 1 && n <= 96 ? n : null;
}

/** hex digit typed in the instrument / volume / parameter columns */
export function keyToHex(code: string): number | null {
  if (/^Digit[0-9]$/.test(code)) return +code.slice(5);
  if (/^Key[A-F]$/.test(code)) return code.charCodeAt(3) - 55;
  return null;
}
