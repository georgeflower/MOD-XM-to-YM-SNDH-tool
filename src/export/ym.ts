// YM5! writer (uncompressed, interleaved) - loads in ST-Sound, Atari-oriented players.
import { NREGS, usesEnvelope } from './stream';

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
