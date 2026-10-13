// A small MFP 68901 model for the SNDH runner: the four timers in delay mode, their interrupt enables and vectors.
// Time is counted in MFP clocks (2 457 600 Hz); one 50 Hz frame is MFP_FRAME clocks.  The runner delivers the
// timer interrupts itself (see sndh.ts), so this class only says *when* a timer underflows and *whether* it may interrupt.

export const MFP_CLOCK = 2_457_600;
export const MFP_FRAME = MFP_CLOCK / 50;
const PREDIV = [0, 4, 10, 16, 50, 64, 100, 200];

/** timer index: 0 = A, 1 = B, 2 = C, 3 = D */
interface TimerDef { ier: number; ierBit: number; imr: number; vec: number; data: number }
const DEF: TimerDef[] = [
  { ier: 0x07, ierBit: 0x20, imr: 0x13, vec: 13, data: 0x1f },
  { ier: 0x07, ierBit: 0x01, imr: 0x13, vec: 8, data: 0x21 },
  { ier: 0x09, ierBit: 0x20, imr: 0x15, vec: 5, data: 0x23 },
  { ier: 0x09, ierBit: 0x10, imr: 0x15, vec: 4, data: 0x25 },
];

export class Mfp {
  reg = new Uint8Array(0x30);
  now = 0;
  /** prescaler code 0 = stopped (event-count / pulse modes are not modelled) */
  mode = [0, 0, 0, 0];
  reload = [256, 256, 256, 256];
  next = [Infinity, Infinity, Infinity, Infinity];
  /** timers that must never interrupt (the one the host uses to call the player) */
  disabled = [false, false, false, false];

  constructor() { this.reg[0x17] = 0x40; }

  read(a: number): number { return this.reg[a & 0x3f] ?? 0xff; }

  write(a: number, v: number) {
    const o = a & 0x3f;
    if (o >= this.reg.length) return;
    this.reg[o] = v;
    switch (o) {
      case 0x19: this.setMode(0, v & 15); break;
      case 0x1b: this.setMode(1, v & 15); break;
      case 0x1d: this.setMode(2, (v >> 4) & 7); this.setMode(3, v & 7); break;
      case 0x1f: this.reload[0] = v || 256; break;
      case 0x21: this.reload[1] = v || 256; break;
      case 0x23: this.reload[2] = v || 256; break;
      case 0x25: this.reload[3] = v || 256; break;
    }
  }

  private setMode(i: number, m: number) {
    const mode = m >= 1 && m <= 7 ? m : 0;
    if (mode === this.mode[i]) return;
    this.mode[i] = mode;
    this.next[i] = mode ? this.now + PREDIV[mode] * this.reload[i] : Infinity;
  }

  period(i: number): number { return PREDIV[this.mode[i]] * this.reload[i]; }

  /** the interrupt may reach the CPU: enabled (IER) and unmasked (IMR) */
  enabled(i: number): boolean {
    const d = DEF[i];
    return !this.disabled[i] && (this.reg[d.ier] & d.ierBit) !== 0 && (this.reg[d.imr] & d.ierBit) !== 0;
  }
  /** address of the exception vector */
  vectorAddr(i: number): number { return (((this.reg[0x17] & 0xf0) + DEF[i].vec) * 4) >>> 0; }

  /** the earliest timer event before `limit`, or null */
  earliest(limit: number): number {
    let best = -1, bt = limit;
    for (let i = 0; i < 4; i++) if (this.mode[i] && this.next[i] < bt) { bt = this.next[i]; best = i; }
    return best;
  }
  /** the timer underflowed at next[i]: schedule the following one */
  advance(i: number) { this.next[i] += this.period(i); }
}
