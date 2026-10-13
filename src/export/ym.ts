// YM5! writer (uncompressed, interleaved) - loads in ST-Sound, Atari-oriented players.
import { NREGS, usesEnvelope } from './stream';
import { type DrumTrack, compactDrums, hasDrums, mfpRate, trigVoice, trigDrum, TRIG_STOP } from '../core/drums';

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
 */
export function writeYm6(
  regs: Uint8Array, nframes: number, loopFrame: number, drumTrack: DrumTrack | null | undefined,
  title: string, author: string, comment: string, fps = 50,
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
  for (let f = 0; f < nframes; f++) {
    const fr = new Uint8Array(16);
    for (let r = 0; r < NREGS; r++) fr[r] = regs[f * NREGS + r];
    if (!env) fr[13] = 0xff;
    const t = dt.trig[f] ?? 0;
    if (t && trigDrum(t) !== TRIG_STOP && trigDrum(t) < dt.drums.length) {
      const v = trigVoice(t), m = mfpRate(dt.drums[trigDrum(t)].rateHz);
      fr[1] = (fr[1] & 0x0f) | 0x40 | ((v + 1) << 4);
      fr[6] = (fr[6] & 0x1f) | (m.code << 5);
      fr[14] = m.count & 255;
      fr[8 + v] = trigDrum(t);
    }
    for (let r = 0; r < 16; r++) body[r * nframes + f] = fr[r];
  }
  const out = new Uint8Array(head.length + body.length + 4);
  out.set(head, 0); out.set(body, head.length); out.set([0x45, 0x6e, 0x64, 0x21], head.length + body.length);
  return { data: out, warnings };
}
