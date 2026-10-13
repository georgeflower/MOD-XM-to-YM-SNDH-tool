// Small YM2149 emulator -> PCM, for in-browser preview. Tone/noise/mixer/volume (no envelope).
import { NREGS } from './stream';

const CLK = 2_000_000;
export const VOL = [0.0, 0.00465, 0.00772, 0.01095, 0.01625, 0.02359, 0.03317, 0.04658, 0.06655,
  0.09396, 0.13264, 0.18732, 0.26407, 0.37316, 0.5, 1.0];

function noiseSeq(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let lfsr = 1;
  for (let i = 0; i < n; i++) {
    out[i] = lfsr & 1;
    const bit = (lfsr ^ (lfsr >> 3)) & 1;
    lfsr = (lfsr >> 1) | (bit << 16);
  }
  return out;
}

export function renderYm(regs: Uint8Array, nframes: number, sr = 44100, fps = 50, over = 4): Float32Array {
  const spf = Math.floor((sr * over) / fps);
  const tStep = CLK / 16 / (sr * over);
  const toneStep = 2 * tStep;
  const noise = noiseSeq(1 << 17);
  const ph = [0, 0, 0];
  let nph = 0;
  const outFrames = Math.floor(spf / over);
  const out = new Float32Array(nframes * outFrames);
  const acc = new Float64Array(spf);
  for (let f = 0; f < nframes; f++) {
    const r = regs.subarray(f * NREGS, f * NREGS + NREGS);
    const mix = r[7];
    const nper = Math.max(1, r[6] & 31);
    acc.fill(0);
    const nbit = new Float64Array(spf);
    for (let n = 0; n < spf; n++) nbit[n] = noise[Math.floor(nph + ((n + 1) * tStep) / nper) & 0x1ffff];
    nph = nph + (spf * tStep) / nper;
    nph %= 1 << 17;
    for (let v = 0; v < 3; v++) {
      const per = Math.max(1, r[2 * v] | ((r[2 * v + 1] & 15) << 8));
      const toneOn = !(mix & (1 << v));
      const noiseOn = !(mix & (8 << v));
      const vol = VOL[r[8 + v] & 15];
      const start = ph[v];
      for (let n = 0; n < spf; n++) {
        const pos = start + ((n + 1) * toneStep) / per;
        let sig = 1;
        if (toneOn) sig = Math.floor(pos) & 1;
        if (noiseOn) sig = toneOn ? sig * nbit[n] : nbit[n];
        acc[n] += sig * vol;
      }
      ph[v] = (start + (spf * toneStep) / per) % 4294967296;
    }
    for (let i = 0; i < outFrames; i++) {
      let s = 0;
      for (let k = 0; k < over; k++) s += acc[i * over + k];
      out[f * outFrames + i] = s / over;
    }
  }
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i];
  mean /= out.length || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mean) / 3;
  return out;
}
