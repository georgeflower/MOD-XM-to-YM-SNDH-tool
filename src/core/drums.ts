/**
 * Digidrums: 4-bit samples played by writing a voice's volume register from an MFP timer interrupt
 * (the Atari ST way, as in YM5/YM6 files and the YM Tracker).
 *
 * A register dump alone cannot carry them (the timer runs at kHz, the dump at 50 Hz), so a dump
 * travels with a DrumTrack: the sample table plus one trigger code per 50 Hz frame.
 */

export const MFP_CLOCK = 2_457_600;
/** MFP timer prescaler for control-register code 0..7 (0 = timer stopped) */
export const MFP_PREDIV = [0, 4, 10, 16, 50, 64, 100, 200] as const;
/** fastest rate a game / SNDH can sensibly afford on an 8 MHz 68000 */
export const MAX_DRUM_HZ = 24_000;
export const MAX_DRUMS = 63;
export const MAX_DRUM_BYTES = 16_000;

export interface DrumSample {
  name: string;
  /** one byte per sample, YM volume step 0..15 (the DAC: written straight to the volume register) */
  pcm: Uint8Array;
  rateHz: number;
}

export interface MfpRate { code: number; count: number; hz: number }

/** nearest rate the MFP can generate (prescaler code 1..7, data register 1..255) */
export function mfpRate(target: number): MfpRate {
  let best: MfpRate = { code: 1, count: 255, hz: MFP_CLOCK / (4 * 255) };
  let bestErr = Infinity;
  const t = Math.max(300, Math.min(MAX_DRUM_HZ, target));
  for (let code = 1; code <= 7; code++) {
    const div = MFP_PREDIV[code];
    const count = Math.max(1, Math.min(255, Math.round(MFP_CLOCK / (div * t))));
    const hz = MFP_CLOCK / (div * count);
    const err = Math.abs(Math.log(hz / t));
    if (err < bestErr - 1e-12) { bestErr = err; best = { code, count, hz }; }
  }
  return best;
}

/** a drum's length in 50 Hz frames at its (quantised) play rate */
export function drumFrames(d: DrumSample): number {
  return Math.max(1, Math.ceil((d.pcm.length / mfpRate(d.rateHz).hz) * 50));
}
export const drumSeconds = (d: DrumSample) => d.pcm.length / mfpRate(d.rateHz).hz;

// ---- trigger codes (one byte per frame, 0 = none)
export const TRIG_STOP = 63;
export const trigCode = (voice: number, drum: number) => ((voice + 1) << 6) | (drum & 63);
export const trigVoice = (t: number) => (t >> 6) - 1;
export const trigDrum = (t: number) => t & 63;

export interface DrumTrack {
  drums: DrumSample[];
  /** one trigger code per frame */
  trig: Uint8Array;
}

export const hasDrums = (d?: DrumTrack | null): d is DrumTrack => !!d && d.drums.length > 0 && d.trig.some((t) => t !== 0);

/** drop unused drums and renumber, so exports only carry what is played */
export function compactDrums(d: DrumTrack): DrumTrack {
  const used = new Map<number, number>();
  const drums: DrumSample[] = [];
  const trig = new Uint8Array(d.trig.length);
  for (let f = 0; f < d.trig.length; f++) {
    const t = d.trig[f];
    if (!t) continue;
    const idx = trigDrum(t);
    if (idx === TRIG_STOP) { trig[f] = t; continue; }
    if (!used.has(idx)) { used.set(idx, drums.length); drums.push(d.drums[idx]); }
    trig[f] = trigCode(trigVoice(t), used.get(idx)!);
  }
  return { drums, trig };
}

// ---------------------------------------------------------------- sample preparation

/** YM2149 DAC levels (relative amplitude of volume steps 0..15) */
export const DAC = [0.0, 0.00465, 0.00772, 0.01095, 0.01625, 0.02359, 0.03317, 0.04658, 0.06655,
  0.09396, 0.13264, 0.18732, 0.26407, 0.37316, 0.5, 1.0];

export interface PrepareOptions {
  /** target play rate (will be rounded to what the MFP can do) */
  rateHz: number;
  /** extra gain before quantising, dB */
  gainDb?: number;
  /** scale the loudest peak to full range */
  normalize?: boolean;
  /** cut leading / trailing silence (|x| below 2 % of the peak) */
  trim?: boolean;
  /** longest result, ms (0 = limited only by MAX_DRUM_BYTES) */
  maxMs?: number;
  /** 1st-order error feedback when quantising to the 16 DAC levels */
  noiseShape?: boolean;
  /** fade the last 5 ms so the drum doesn't end on a click */
  fadeOut?: boolean;
}

/** float samples (-1..1) -> 4-bit DAC drum */
export function prepareDrum(name: string, x: Float32Array, srcRate: number, o: PrepareOptions): DrumSample {
  const rate = mfpRate(o.rateHz).hz;
  let data = x;
  if (o.trim) {
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    const thr = peak * 0.02;
    let a = 0, b = data.length;
    while (a < b && Math.abs(data[a]) < thr) a++;
    while (b > a && Math.abs(data[b - 1]) < thr) b--;
    data = data.subarray(a, b);
  }
  // resample: box-filter average when going down (anti-alias), linear when going up
  const ratio = srcRate / rate;
  let n = Math.max(1, Math.floor(data.length / ratio));
  const maxN = Math.min(MAX_DRUM_BYTES, o.maxMs ? Math.floor((o.maxMs / 1000) * rate) : MAX_DRUM_BYTES);
  n = Math.min(n, maxN);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s0 = i * ratio, s1 = Math.min(data.length, (i + 1) * ratio);
    if (ratio > 1) {
      let sum = 0, w = 0;
      for (let k = Math.floor(s0); k < Math.ceil(s1); k++) {
        const wt = Math.min(k + 1, s1) - Math.max(k, s0);
        if (wt > 0 && k < data.length) { sum += data[k] * wt; w += wt; }
      }
      y[i] = w ? sum / w : 0;
    } else {
      const p = s0, k = Math.floor(p), fr = p - k;
      y[i] = (data[k] ?? 0) * (1 - fr) + (data[k + 1] ?? data[k] ?? 0) * fr;
    }
  }
  // gain / normalise (signed -> unipolar around the middle of the DAC range)
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(y[i]));
  let g = Math.pow(10, (o.gainDb ?? 0) / 20);
  if (o.normalize && peak > 0) g *= 1 / peak;
  if (o.fadeOut) {
    const f = Math.min(n, Math.round(rate * 0.005));
    for (let i = 0; i < f; i++) y[n - 1 - i] *= i / f;
  }
  // The DAC is nonlinear (about 3 dB per step), so pick the level whose *amplitude* is nearest.
  const pcm = new Uint8Array(n);
  let err = 0;
  for (let i = 0; i < n; i++) {
    const target = Math.max(0, Math.min(1, 0.5 + 0.5 * y[i] * g + (o.noiseShape ? err : 0)));
    let best = 0, bd = Infinity;
    for (let k = 0; k < 16; k++) { const d = Math.abs(DAC[k] - target); if (d < bd) { bd = d; best = k; } }
    pcm[i] = best;
    err = o.noiseShape ? (target - DAC[best]) * 0.5 : 0;
  }
  return { name, pcm, rateHz: rate };
}

/** a drum as audio at `sr` (sample-and-hold like the hardware), for auditioning */
export function drumToAudio(d: DrumSample, sr = 44100): Float32Array {
  const hz = mfpRate(d.rateHz).hz;
  const n = Math.max(1, Math.round((d.pcm.length / hz) * sr));
  const out = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) { out[i] = DAC[d.pcm[Math.min(d.pcm.length - 1, Math.floor((i / sr) * hz))] & 15]; mean += out[i]; }
  mean /= n;
  for (let i = 0; i < n; i++) out[i] = (out[i] - mean) * 0.9;
  return out;
}

// ---------------------------------------------------------------- WAV reading

export interface PcmAudio { rate: number; data: Float32Array }

/** minimal RIFF/WAVE reader (PCM 8/16/24/32 bit, float32; any channel count mixed to mono) */
export function decodeWav(b: Uint8Array): PcmAudio {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (p: number) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt: { format: number; ch: number; rate: number; bits: number } | null = null;
  let p = 12;
  while (p + 8 <= b.length) {
    const id = tag(p), size = dv.getUint32(p + 4, true), body = p + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      const ch = dv.getUint16(body + 2, true), rate = dv.getUint32(body + 4, true), bits = dv.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true);
      fmt = { format, ch, rate, bits };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV: data before fmt');
      if (fmt.format !== 1 && fmt.format !== 3) throw new Error(`WAV: unsupported encoding ${fmt.format} (use PCM)`);
      const bytes = fmt.bits >> 3, frames = Math.floor(Math.min(size, b.length - body) / (bytes * fmt.ch));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < fmt.ch; c++) {
          const q = body + (i * fmt.ch + c) * bytes;
          if (fmt.format === 3) s += fmt.bits === 64 ? dv.getFloat64(q, true) : dv.getFloat32(q, true);
          else if (fmt.bits === 8) s += (b[q] - 128) / 128;
          else if (fmt.bits === 16) s += dv.getInt16(q, true) / 32768;
          else if (fmt.bits === 24) s += (((b[q + 2] << 24) | (b[q + 1] << 16) | (b[q] << 8)) >> 8) / 8388608;
          else if (fmt.bits === 32) s += dv.getInt32(q, true) / 2147483648;
          else throw new Error(`WAV: unsupported bit depth ${fmt.bits}`);
        }
        out[i] = s / fmt.ch;
      }
      return { rate: fmt.rate, data: out };
    }
    p = body + size + (size & 1);
  }
  throw new Error('WAV: no data chunk');
}

// ---------------------------------------------------------------- built-in starter drums

function lcg(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2147483648 - 1; }; }

const SYNTH: Record<string, (sr: number) => Float32Array> = {
  'Kick': (sr) => {
    const n = Math.round(sr * 0.22), o = new Float32Array(n); let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / sr, f = 45 + 150 * Math.exp(-t * 28); ph += (2 * Math.PI * f) / sr; o[i] = Math.sin(ph) * Math.exp(-t * 11); }
    return o;
  },
  'Snare': (sr) => {
    const n = Math.round(sr * 0.18), o = new Float32Array(n), r = lcg(7); let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / sr; ph += (2 * Math.PI * (190 - 60 * t)) / sr; o[i] = (0.6 * r() * Math.exp(-t * 20) + 0.5 * Math.sin(ph) * Math.exp(-t * 35)); }
    return o;
  },
  'Hi-hat': (sr) => {
    const n = Math.round(sr * 0.06), o = new Float32Array(n), r = lcg(11); let prev = 0;
    for (let i = 0; i < n; i++) { const x = r(); o[i] = (x - prev * 0.6) * Math.exp(-(i / sr) * 70); prev = x; }
    return o;
  },
  'Open hat': (sr) => {
    const n = Math.round(sr * 0.2), o = new Float32Array(n), r = lcg(23); let prev = 0;
    for (let i = 0; i < n; i++) { const x = r(); o[i] = (x - prev * 0.6) * Math.exp(-(i / sr) * 16); prev = x; }
    return o;
  },
  'Tom': (sr) => {
    const n = Math.round(sr * 0.25), o = new Float32Array(n); let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / sr; ph += (2 * Math.PI * (95 + 60 * Math.exp(-t * 14))) / sr; o[i] = Math.sin(ph) * Math.exp(-t * 9); }
    return o;
  },
  'Clap': (sr) => {
    const n = Math.round(sr * 0.2), o = new Float32Array(n), r = lcg(5);
    for (let i = 0; i < n; i++) { const t = i / sr; const burst = (t % 0.012) < 0.006 && t < 0.036 ? 1 : 0.35 * Math.exp(-(t - 0.036) * 25); o[i] = r() * burst * Math.exp(-t * 14); }
    return o;
  },
};
export const SYNTH_DRUM_NAMES = Object.keys(SYNTH);

/** a ready-made 4-bit drum (kick, snare, hi-hat, ...) at the given rate */
export function synthDrum(name: string, rateHz = 8000): DrumSample {
  const make = SYNTH[name] ?? SYNTH['Kick'];
  const sr = 32000;
  return prepareDrum(name, make(sr), sr, { rateHz, normalize: true, noiseShape: true, fadeOut: true });
}
export const starterKit = (rateHz = 8000): DrumSample[] => ['Kick', 'Snare', 'Hi-hat', 'Open hat', 'Tom', 'Clap'].map((n) => synthDrum(n, rateHz));

/** nearest DAC step for a relative amplitude 0..1 */
export function nearestDac(a: number): number {
  let best = 0, bd = Infinity;
  for (let k = 0; k < 16; k++) { const d = Math.abs(DAC[k] - a); if (d < bd) { bd = d; best = k; } }
  return best;
}

/**
 * Make a register dump consistent with its drum triggers: while a drum plays, its voice has volume 0 and
 * tone + noise off (the sample owns the voice). A new drum cuts the previous one, a stop code ends it.
 * Works in place; returns the frame each drum ended at (for tests / reports).
 */
export function silenceDrumVoices(regs: Uint8Array, nframes: number, d: DrumTrack, nregs = 14): void {
  let live: { voice: number; end: number } | null = null;
  for (let f = 0; f < nframes; f++) {
    const t = d.trig[f] ?? 0;
    if (t) {
      const idx = trigDrum(t), v = trigVoice(t);
      if (idx === TRIG_STOP) live = null;
      else if (d.drums[idx]) live = { voice: v, end: f + drumFrames(d.drums[idx]) };
    }
    if (live && f >= live.end) live = null;
    if (live) { regs[f * nregs + 8 + live.voice] = 0; regs[f * nregs + 7] |= (1 << live.voice) | (8 << live.voice); }
  }
}
