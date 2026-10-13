// Packed delta register stream (shared by the game replayer and the SNDH player).
//
// Per frame:  A = bit7 "B follows" | mask of R0..R6 (bits 0-6)
//             B = mask of R7..R13 (bits 0-6)            [only when bit7 of A is set]
//             then one data byte per set mask bit, in register order.
// The loop frame always starts with a full refresh so the loop point is self-contained.
//
// R13 (envelope shape) follows the YM convention: 0xFF = "do not write this frame". When no voice
// ever uses the hardware envelope (volume bit 4) R13 is never written at all; otherwise every
// frame whose R13 != 0xFF writes it (a rewrite of the same shape retriggers the envelope).

export const NREGS = 14;

export interface PackedStream {
  data: Uint8Array;
  loopOffset: number;
}

export function usesEnvelope(regs: Uint8Array, nframes: number): boolean {
  for (let f = 0; f < nframes; f++) {
    const r = regs.subarray(f * NREGS, f * NREGS + NREGS);
    if ((r[8] | r[9] | r[10]) & 16) return true;
  }
  return false;
}

export function packStream(regs: Uint8Array, nframes: number, loopFrame: number): PackedStream {
  const env = usesEnvelope(regs, nframes);
  const out: number[] = [];
  let cur: Uint8Array | null = null;
  let loopOffset = 0;
  for (let f = 0; f < nframes; f++) {
    if (f === loopFrame) {
      loopOffset = out.length;
      cur = null;
    }
    const r = regs.subarray(f * NREGS, f * NREGS + NREGS);
    let mask = 0;
    for (let k = 0; k < NREGS - 1; k++) if (cur === null || r[k] !== cur[k]) mask |= 1 << k;
    if (env && r[13] !== 0xff) mask |= 1 << 13;
    let a = mask & 0x7f;
    const b = (mask >> 7) & 0x7f;
    if (b) a |= 0x80;
    out.push(a);
    if (b) out.push(b);
    for (let k = 0; k < NREGS; k++) if (mask & (1 << k)) out.push(r[k]);
    cur = r;
  }
  return { data: Uint8Array.from(out), loopOffset };
}

export function unpackStream(data: Uint8Array, nframes: number): Uint8Array {
  const regs = new Uint8Array(nframes * NREGS);
  const cur = new Uint8Array(NREGS);
  let p = 0;
  for (let f = 0; f < nframes; f++) {
    cur[13] = 0xff;
    const a = data[p++];
    let mask = a & 0x7f;
    if (a & 0x80) mask |= (data[p++] & 0x7f) << 7;
    for (let k = 0; k < NREGS; k++) if (mask & (1 << k)) cur[k] = data[p++];
    regs.set(cur, f * NREGS);
  }
  return regs;
}
