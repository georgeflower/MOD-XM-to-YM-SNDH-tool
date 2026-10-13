// Packed delta register stream (shared by the game replayer and the SNDH player).
//
// Per frame:  A = bit7 "B follows" | mask of R0..R6 (bits 0-6)
//             B = bit7 "event bytes follow" | mask of R7..R13 (bits 0-6)   [only when bit7 of A is set]
//             events [only when bit7 of B is set]:
//               timer effect (at most one per frame):  X = kind<<4 | voice<<2 | cont      (top two bits 00)
//                   kind 0 = stop; kinds 1..3 (SID, sinus, sync) are followed by  prescaler code, data register
//                   cont = 1: a drum byte follows
//               digidrum trigger:  T = (voice+1)<<6 | drum index, drum 63 = stop           (top two bits != 00)
//             then one data byte per set mask bit, in register order.
// Streams without digidrums / timer effects never set bit7 of B, so they stay readable by players that predate it.
// The loop frame always starts with a full refresh so the loop point is self-contained.
//
// R13 (envelope shape) follows the YM convention: 0xFF = "do not write this frame". When no voice
// ever uses the hardware envelope (volume bit 4) R13 is never written at all; otherwise every
// frame whose R13 != 0xFF writes it (a rewrite of the same shape retriggers the envelope).

import type { DrumTrack } from '../core/drums';
import { type FxTrack, fxEvents, fxKindOf, fxVoiceOf, fxCodeOf, fxCountOf } from '../core/fx';

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

export function packStream(regs: Uint8Array, nframes: number, loopFrame: number, drums?: DrumTrack | null, fx?: FxTrack | null): PackedStream {
  const fxAt = new Map<number, number>();
  if (fx) for (const e of fxEvents(fx, nframes, loopFrame)) fxAt.set(e.frame, e.state);
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
    const trig = drums?.trig[f] ?? 0;
    const fxe = fxAt.get(f);
    const b = (mask >> 7) & 0x7f;
    const ev = trig || fxe !== undefined;
    if (b || ev) a |= 0x80;
    out.push(a);
    if (b || ev) out.push(b | (ev ? 0x80 : 0));
    if (fxe !== undefined) {
      const k = fxKindOf(fxe);
      out.push((k << 4) | (k ? fxVoiceOf(fxe) << 2 : 0) | (trig ? 1 : 0));
      if (k) out.push(fxCodeOf(fxe), fxCountOf(fxe));
    }
    if (trig) out.push(trig);
    for (let k = 0; k < NREGS; k++) if (mask & (1 << k)) out.push(r[k]);
    cur = r;
  }
  return { data: Uint8Array.from(out), loopOffset };
}

export function unpackStream(data: Uint8Array, nframes: number, trigOut?: Uint8Array, fxOut?: Uint32Array): Uint8Array {
  const regs = new Uint8Array(nframes * NREGS);
  const cur = new Uint8Array(NREGS);
  let p = 0, fxCur = 0;
  for (let f = 0; f < nframes; f++) {
    cur[13] = 0xff;
    const a = data[p++];
    let mask = a & 0x7f;
    if (a & 0x80) {
      const b = data[p++];
      mask |= (b & 0x7f) << 7;
      if (b & 0x80) {
        let t = data[p++];
        if ((t & 0xc0) === 0) {                         // timer effect header
          const kind = (t >> 4) & 3, voice = (t >> 2) & 3;
          if (kind) { const code = data[p++], count = data[p++]; fxCur = ((kind << 16) | (voice << 12) | (code << 8) | count) >>> 0; } else fxCur = 0;
          t = t & 1 ? data[p++] : 0;
        }
        if (t && trigOut) trigOut[f] = t;
      }
    }
    for (let k = 0; k < NREGS; k++) if (mask & (1 << k)) cur[k] = data[p++];
    regs.set(cur, f * NREGS);
    if (fxOut) fxOut[f] = fxCur;
  }
  return regs;
}
