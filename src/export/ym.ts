// YM5! writer (uncompressed, interleaved) - loads in ST-Sound, Atari-oriented players.
import { NREGS, usesEnvelope } from './stream';
import { type DrumTrack, compactDrums, hasDrums, mfpRate, trigVoice, trigDrum, TRIG_STOP } from '../core/drums';
import { type FxTrack, hasFx, fxKindOf, fxVoiceOf, fxCodeOf, fxCountOf, fxHzOf, FX_SINUS, FX_SID, FX_SYNC, fxRate } from '../core/fx';

export const YM_CLOCK = 2_000_000;

function latin1(s: string): number[] {
  const o: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    o.push(c < 256 ? c : 63);
  }
  o.push(0);
  return o;
}

export function writeYm5(
  regs: Uint8Array, nframes: number, loopFrame: number,
  title: string, author: string, comment: string, fps = 50,
): Uint8Array {
  const head: number[] = [];
  const push32 = (v: number) => head.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const push16 = (v: number) => head.push((v >>> 8) & 255, v & 255);
  for (const c of 'YM5!LeOnArD!') head.push(c.charCodeAt(0));
  push32(nframes); push32(1); push16(0); push32(YM_CLOCK); push16(fps); push32(loopFrame); push16(0);
  head.push(...latin1(title), ...latin1(author), ...latin1(comment));
  const env = usesEnvelope(regs, nframes);
  const body = new Uint8Array(nframes * 16);
  for (let r = 0; r < 16; r++) {
    for (let f = 0; f < nframes; f++) {
      let v = 0;
      if (r < NREGS) v = regs[f * NREGS + r];
      if (r >= 8 && r <= 10) v &= 0x1f;       // bit 5 = this tool's sync-square flag, not part of the YM format
      if (r === 13 && !env) v = 0xff; // envelope unused: never restart it (0xFF = no write)
      body[r * nframes + f] = v;
    }
  }
  const tail = [0x45, 0x6e, 0x64, 0x21]; // "End!"
  const out = new Uint8Array(head.length + body.length + 4);
  out.set(head, 0); out.set(body, head.length); out.set(tail, head.length + body.length);
  return out;
}

/**
 * YM6! writer with digidrums (ST-Sound / YM6 conventions): the drum samples go into the header (4-bit values,
 * attribute bit 2), a trigger is "effect 1" in that frame: R1 high nibble = 0x40 | (voice+1) << 4,
 * R6 bits 5-7 = MFP prescaler, R14 = MFP data register, R(8+voice) = drum number (0..31).
 * YM6 has no 'stop' code and ST-Sound lets drums on different voices overlap, so those two things are approximated.
 *
 * Timer effects (Q / S / U) use the same two effect slots: R1 / R3 high nibble = (voice + 1) << 4 | type
 * (0x00 SID voice, 0x80 sinus-SID, 0xC0 sync-buzzer), prescaler in R6 / R8 bits 5-7, data register in R14 / R15.
 * ST-Sound effects last one frame, so they are repeated in every frame the effect runs.  The rate stored is the
 * musical rate (for sinus-SID the 68000 engine runs 32x faster).  A frame with a drum uses slot 1 for the drum
 * and slot 2 for the effect.  Sync-buzzer frames carry the envelope shape in R13.
 */
export function writeYm6(
  regs: Uint8Array, nframes: number, loopFrame: number, drumTrack: DrumTrack | null | undefined,
  title: string, author: string, comment: string, fps = 50, fx?: FxTrack | null,
): { data: Uint8Array; warnings: string[] } {
  const warnings: string[] = [];
  const dt = hasDrums(drumTrack) ? compactDrums(drumTrack) : { drums: [], trig: new Uint8Array(nframes) };
  if (dt.drums.length > 32) { warnings.push(`YM6 addresses only 32 digidrums; ${dt.drums.length - 32} extra ones are left out`); dt.drums.length = 32; }
  const head: number[] = [];
  const push32 = (v: number) => head.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const push16 = (v: number) => head.push((v >>> 8) & 255, v & 255);
  for (const c of 'YM6!LeOnArD!') head.push(c.charCodeAt(0));
  push32(nframes); push32(1 | 4); push16(dt.drums.length); push32(YM_CLOCK); push16(fps); push32(loopFrame); push16(0);
  for (const d of dt.drums) { push32(d.pcm.length); for (const v of d.pcm) head.push(v & 15); }
  head.push(...latin1(title), ...latin1(author), ...latin1(comment));
  const env = usesEnvelope(regs, nframes);
  const body = new Uint8Array(nframes * 16);
  let shape = 0;                                    // envelope shape last written (sync-buzzer frames repeat it)
  for (let f = 0; f < nframes; f++) {
    const fr = new Uint8Array(16);
    for (let r = 0; r < NREGS; r++) fr[r] = regs[f * NREGS + r];
    for (let v = 8; v <= 10; v++) fr[v] &= 0x1f;                 // bit 5 = sync-square flag of this tool, not part of the YM format
    if (!env) fr[13] = 0xff;
    const t = dt.trig[f] ?? 0;
    if (t && trigDrum(t) !== TRIG_STOP && trigDrum(t) < dt.drums.length) {
      const v = trigVoice(t), m = mfpRate(dt.drums[trigDrum(t)].rateHz);
      fr[1] = (fr[1] & 0x0f) | 0x40 | ((v + 1) << 4);
      fr[6] = (fr[6] & 0x1f) | (m.code << 5);
      fr[14] = m.count & 255;
      fr[8 + v] = trigDrum(t);
    }
    if (regs[f * NREGS + 13] !== 0xff) shape = regs[f * NREGS + 13] & 15;
    const fs = fx && hasFx(fx) ? fx[f] ?? 0 : 0;
    if (fs) {
      const k = fxKindOf(fs), v = fxVoiceOf(fs);
      const m = fxRate(fxHzOf(fs));                          // musical rate -> prescaler / data register
      const type = k === FX_SID ? 0x00 : k === FX_SINUS ? 0x80 : 0xc0;
      const nib = ((v + 1) << 4) | type;
      if (t && trigDrum(t) !== TRIG_STOP) {                    // slot 1 holds the drum
        fr[3] = (fr[3] & 0x0f) | nib; fr[8] = (fr[8] & 0x1f) | (m.code << 5); fr[15] = m.count & 255;
      } else {
        fr[1] = (fr[1] & 0x0f) | nib; fr[6] = (fr[6] & 0x1f) | (m.code << 5); fr[14] = m.count & 255;
      }
      if (k === FX_SYNC) fr[13] = shape;
    }
    for (let r = 0; r < 16; r++) body[r * nframes + f] = fr[r];
  }
  const out = new Uint8Array(head.length + body.length + 4);
  out.set(head, 0); out.set(body, head.length); out.set([0x45, 0x6e, 0x64, 0x21], head.length + body.length);
  if (hasFx(fx)) warnings.push('YM6 timer effects (SID / sinus-SID / sync-buzzer) are written in the YM6 effect slots; players differ in how exactly they render them');
  return { data: out, warnings };
}
