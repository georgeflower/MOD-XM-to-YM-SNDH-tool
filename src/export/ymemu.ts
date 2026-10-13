// Small YM2149 emulator -> PCM, for in-browser preview. Tone / noise / mixer / volume / hardware envelope.
import { NREGS } from './stream';
import { type DrumTrack, mfpRate, trigVoice, trigDrum, TRIG_STOP } from '../core/drums';
import { type FxTrack, FX_SID, FX_SINUS, FX_SYNC, fxKindOf, fxVoiceOf, fxHzOf, fxVoiceVol, sinusLevel, SINUS_STEPS } from '../core/fx';

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

/** hardware envelope level 0..15 after `step` steps since the shape register was written */
export function envLevel(shape: number, step: number): number {
  const A = shape & 4, AL = shape & 2, H = shape & 1, C = shape & 8;
  const ramp = Math.floor(step / 16), pos = step % 16;
  const ramped = (up: boolean) => (up ? pos : 15 - pos);
  if (!C) return ramp === 0 ? ramped(!!A) : 0;
  if (H) return ramp === 0 ? ramped(!!A) : AL ? (A ? 0 : 15) : (A ? 15 : 0);
  const up = AL ? (A ? (ramp & 1) === 0 : (ramp & 1) === 1) : !!A;
  return ramped(up);
}

export function renderYm(regs: Uint8Array, nframes: number, sr = 44100, fps = 50, over = 4, drums?: DrumTrack | null, fx?: FxTrack | null): Float32Array {
  const spf = Math.floor((sr * over) / fps);
  const tStep = CLK / 16 / (sr * over);
  const toneStep = 2 * tStep;
  const noise = noiseSeq(1 << 17);
  const ph = [0, 0, 0];
  let nph = 0;
  const outFrames = Math.floor(spf / over);
  const out = new Float32Array(nframes * outFrames);
  const acc = new Float64Array(spf);
  let envShape = 0, envStep = 0;          // envStep counts hardware-envelope steps (16 per ramp)
  // digidrums: a voice's volume register is driven by the sample (tone and noise held "on") until it ends
  const dr: ({ pcm: Uint8Array; pos: number; step: number } | null)[] = [null, null, null];
  // timer effect state (one at a time): the timer phase and what the ISR has done so far
  let fxPh = 0, fxTog = 0, fxPos = 0, fxPrev = 0;
  const fxLevel = new Float64Array(spf);          // per oversampled sample: volume step 0..15 of the fx voice
  const envStepAt = new Float64Array(spf);        // sync-buzzer: envelope step at each sample
  for (let f = 0; f < nframes; f++) {
    const r = regs.subarray(f * NREGS, f * NREGS + NREGS);
    const tg = drums ? drums.trig[f] ?? 0 : 0;
    if (tg) {
      const v = trigVoice(tg), idx = trigDrum(tg);
      if (v >= 0 && v < 3) {
        const d = idx === TRIG_STOP ? null : drums!.drums[idx];
        dr[v] = d && d.pcm.length ? { pcm: d.pcm, pos: 0, step: mfpRate(d.rateHz).hz / (sr * over) } : null;
      }
    }
    if (r[13] !== 0xff) { envShape = r[13] & 15; envStep = 0; }
    const fxs = fx ? fx[f] ?? 0 : 0;
    const fxKind = fxKindOf(fxs), fxV = fxVoiceOf(fxs);
    if (fxs !== fxPrev) { fxPh = 0; fxTog = 0; fxPos = 0; fxPrev = fxs; }   // the engine is (re)started by an event
    const envPer = Math.max(1, r[11] | (r[12] << 8));
    const envRate = CLK / (16 * envPer) / (sr * over);       // envelope steps per oversampled sample
    const envAt = new Float64Array(0);
    void envAt;
    let syncOn = false;
    if (fxs && (fxKind === FX_SID || fxKind === FX_SINUS)) {
      // the interrupt (Timer A) fires `tick` times a second; every tick the ISR rewrites the voice's volume register
      const tick = fxHzOf(fxs) * (fxKind === FX_SINUS ? SINUS_STEPS : 1), inc = tick / (sr * over);
      const V = fxVoiceVol(r[8 + fxV]);
      for (let n = 0; n < spf; n++) {
        fxPh += inc;
        const t = Math.floor(fxPh);
        if (t > 0) { fxPh -= t; if (fxKind === FX_SID) fxTog = (fxTog + t) & 1; else fxPos = (fxPos + t) & 63; }
        fxLevel[n] = fxKind === FX_SID ? (fxTog ? V : 0) : sinusLevel(fxPos, V);
      }
    } else if (fxs && fxKind === FX_SYNC) {
      syncOn = true;
      const inc = fxHzOf(fxs) / (sr * over);
      let base = envStep, from = 0;
      for (let n = 0; n < spf; n++) {
        fxPh += inc;
        if (fxPh >= 1) { fxPh -= Math.floor(fxPh); base = 0; from = n + 1; }   // the ISR rewrote R13: envelope restarts
        envStepAt[n] = base + (n + 1 - from) * envRate;
      }
      envStep = base + (spf - from) * envRate;
    }
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
      const useEnv = (r[8 + v] & 16) !== 0;
      const vol = useEnv ? 1 : VOL[r[8 + v] & 15];
      const fxHere = fxs && v === fxV && fxKind !== FX_SYNC;
      const start = ph[v];
      for (let n = 0; n < spf; n++) {
        const cur = dr[v];
        if (cur) {
          const i = Math.floor(cur.pos);
          if (i < cur.pcm.length) { acc[n] += VOL[cur.pcm[i] & 15]; cur.pos += cur.step; continue; }
          dr[v] = null;                      // finished: the registers take over for the rest of the frame
        }
        const pos = start + ((n + 1) * toneStep) / per;
        let sig = 1;
        if (toneOn) sig = Math.floor(pos) & 1;
        if (noiseOn) sig = toneOn ? sig * nbit[n] : nbit[n];
        const lv = fxHere ? VOL[fxLevel[n]] : useEnv ? VOL[envLevel(envShape, Math.floor(syncOn ? envStepAt[n] : envStep + (n + 1) * envRate))] : vol;
        acc[n] += sig * lv;
      }
      ph[v] = (start + (spf * toneStep) / per) % 4294967296;
    }
    if (!syncOn) envStep += spf * envRate;
    if (envStep > 1e9) envStep = 64 + (envStep % 32);
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
