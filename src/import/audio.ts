/**
 * Audio recording (WAV / MP3 / …) -> YM2149 register dump.
 *
 * The chip has three square-wave voices, one noise generator and 16 volume steps, updated 50 times a second, so a
 * recording can only be approximated: per 20 ms frame the spectrum is searched for up to three harmonic series (the
 * strongest first, each one removed before the next is looked for), tracked from frame to frame so every voice keeps
 * its note, and mapped to the chip's tone periods and volume steps. What is left in the high band after the three
 * series are taken out becomes the noise generator (percussion, breath, cymbals). It works best on single
 * instruments, chords of up to three notes, bass lines and chiptune-like music; dense full mixes give a rough sketch.
 *
 * The result is an ordinary AyTune, so the preview, every export and "Edit as AY patterns" work on it.
 */
import { fft } from '../core/fft';
import { DAC, decodeWav } from '../core/drums';
import type { AyTune } from './tune';

export const AUDIO_RATE = 22050;
const N = 2048;                    // analysis window (93 ms)
const FFT_N = 4096;                // zero padded: 5.4 Hz grid
const BIN_HZ = AUDIO_RATE / FFT_N;
const HOP = AUDIO_RATE / 50;       // 441 samples = one chip frame
const YM_CLOCK = 2_000_000;
const F_MIN = 32, F_MAX = 1600;    // pitch search range (chip: period 4095 ≈ 30.5 Hz)
const F_TOP = 7000;                // highest harmonic looked at
const NOISE_LO = 2800, NOISE_HI = 9500;

export interface AudioOptions {
  /** first second to analyse */
  startSeconds?: number;
  /** longest part to analyse (default 300 s) */
  maxSeconds?: number;
  /** quietest voice that is kept, dB below the loudest passage (default -40) */
  gateDb?: number;
  /** pull pitches to the nearest semitone when they are within 35 cents (default true) */
  snap?: boolean;
  /** percussion / breath become the noise generator (default true) */
  noise?: boolean;
  /** how many voices to use, 1..3 (default 3) */
  voices?: number;
  /** extra gain before the volume steps, dB (default 0) */
  gainDb?: number;
  title?: string;
}

export interface AudioStats { seconds: number; frames: number; sourceRate: number; truncated: boolean; voiced: number[]; noiseFrames: number; tuningCents: number }

// ---------------------------------------------------------------- decoding

const asc = (d: Uint8Array, p: number, n: number) => String.fromCharCode(...d.subarray(p, p + n));

/** WAV, MP3, Ogg, FLAC or M4A by content */
export function isAudioFile(d: Uint8Array): boolean {
  if (d.length < 12) return false;
  if (asc(d, 0, 4) === 'RIFF' && asc(d, 8, 4) === 'WAVE') return true;
  if (asc(d, 0, 3) === 'ID3' || asc(d, 0, 4) === 'OggS' || asc(d, 0, 4) === 'fLaC' || asc(d, 4, 4) === 'ftyp') return true;
  // MPEG audio frame sync (11 set bits), layer III / II / I, and not the SNDH / YM / module magics
  return d[0] === 0xff && (d[1] & 0xe0) === 0xe0 && ((d[1] >> 1) & 3) !== 0;
}

export interface Pcm { data: Float32Array; rate: number }

/** mono PCM of any audio file the browser can decode (WAV also without a browser) */
export async function decodeAudio(bytes: Uint8Array): Promise<Pcm> {
  const OAC = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext
    ?? (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (OAC) {
    try {
      const ctx = new OAC(1, 1, AUDIO_RATE);
      const buf = await ctx.decodeAudioData(bytes.slice().buffer);
      const n = buf.length, out = new Float32Array(n);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < n; i++) out[i] += ch[i] / buf.numberOfChannels;
      }
      return { data: out, rate: buf.sampleRate };
    } catch (e) {
      if (asc(bytes, 0, 4) !== 'RIFF') throw new Error(`this browser cannot decode the audio file (${(e as Error)?.message ?? e})`);
    }
  }
  if (asc(bytes, 0, 4) === 'RIFF') { const w = decodeWav(bytes); return { data: w.data, rate: w.rate }; }
  throw new Error('this browser cannot decode MP3 / Ogg / FLAC files; use a WAV file');
}

function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = from / to, n = Math.floor(x.length / ratio), y = new Float32Array(n);
  if (ratio > 1) {                       // box filter when going down
    for (let i = 0; i < n; i++) {
      const s0 = i * ratio, s1 = Math.min(x.length, (i + 1) * ratio);
      let sum = 0, w = 0;
      for (let k = Math.floor(s0); k < Math.ceil(s1); k++) { const wt = Math.min(k + 1, s1) - Math.max(k, s0); if (wt > 0) { sum += x[k] * wt; w += wt; } }
      y[i] = w ? sum / w : 0;
    }
  } else {
    for (let i = 0; i < n; i++) { const p = i * ratio, k = Math.floor(p), f = p - k; y[i] = x[k] * (1 - f) + (x[k + 1] ?? x[k]) * f; }
  }
  return y;
}

// ---------------------------------------------------------------- analysis

const HANN = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
/** candidate fundamentals, quarter-semitone grid */
const CANDS = (() => { const a: number[] = []; for (let f = F_MIN; f <= F_MAX; f *= Math.pow(2, 1 / 48)) a.push(f); return Float64Array.from(a); })();
const HMAX = 14;
const KTOP = Math.floor(F_TOP / BIN_HZ);

interface Found { f: number; amp: number; sal: number }

/** magnitude spectrum of the frame centred on `centre` (sine amplitude units: a sine of amplitude a peaks at a) */
function spectrum(x: Float32Array, centre: number, re: Float64Array, im: Float64Array, A: Float64Array) {
  const s0 = Math.round(centre - N / 2);
  re.fill(0); im.fill(0);
  for (let i = 0; i < N; i++) { const j = s0 + i; re[i] = j >= 0 && j < x.length ? x[j] * HANN[i] : 0; }
  fft(re, im);
  const sc = 4 / N;                       // Hann: |X| of a unit sine = N/4
  for (let k = 0; k <= FFT_N / 2; k++) A[k] = Math.hypot(re[k], im[k]) * sc;
}

/** largest magnitude within the tolerance around frequency f, and where */
function around(A: Float64Array, f: number): { a: number; k: number } {
  const b = f / BIN_HZ, m = Math.max(1.5, (0.009 * f) / BIN_HZ);
  const lo = Math.max(1, Math.ceil(b - m)), hi = Math.min(FFT_N / 2 - 1, Math.floor(b + m));
  let best = 0, bk = Math.round(b);
  for (let k = lo; k <= hi; k++) if (A[k] > best) { best = A[k]; bk = k; }
  return { a: best, k: bk };
}

/** parabolic peak refinement on the log magnitude: bin position and amplitude */
function refine(A: Float64Array, k: number): { f: number; a: number } {
  if (k < 1 || k >= FFT_N / 2 - 1 || A[k] <= 0) return { f: k * BIN_HZ, a: A[k] };
  const l = Math.log(A[k - 1] + 1e-12), c = Math.log(A[k] + 1e-12), r = Math.log(A[k + 1] + 1e-12);
  const d = l - 2 * c + r;
  const p = Math.max(-0.5, Math.min(0.5, d < 0 ? (0.5 * (l - r)) / d : 0));
  return { f: (k + p) * BIN_HZ, a: Math.exp(c - 0.25 * (l - r) * p) };
}

const BINS_PER_LOBE = (AUDIO_RATE / N) / BIN_HZ;      // zero-padded bins per unpadded bin (2)
/** magnitude of the Hann window's transform at an offset of x unpadded bins, relative to its peak */
function hannLobe(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.abs(Math.sin(px) / px / (1 - x * x));
}

/** strongest harmonic series left in A (which is modified: the series is taken out) */
function strongestSeries(A: Float64Array, gate: number): Found | null {
  let bestS = 0, bestI = -1;
  const sal = new Float64Array(CANDS.length);
  for (let i = 0; i < CANDS.length; i++) {
    const f0 = CANDS[i];
    let s = 0;
    const H = Math.min(HMAX, Math.floor(F_TOP / f0));
    const a1 = around(A, f0).a;
    // a harmonic louder than the fundamental belongs to another source (the 2nd harmonic of a square is absent, so a
    // loud peak at 2*f0 is a different voice): it counts at most as much as the fundamental
    let top = a1;
    for (let h = 1; h <= H; h++) { const a = around(A, h * f0).a; top = Math.max(top, a); s += Math.min(a, h === 1 ? Infinity : 1.1 * a1) * Math.pow(h, -0.6); }
    if (a1 < 0.2 * top) s = 0;                // no fundamental: a pile of small partials of something else
    sal[i] = s;
    if (s > bestS) { bestS = s; bestI = i; }
  }
  if (bestI < 0 || bestS < gate) return null;
  // an octave down when its own fundamental is clearly there (the series of f0 are also those of f0/2)
  for (let guard = 0; guard < 2; guard++) {
    const half = CANDS[bestI] / 2;
    if (half < F_MIN) break;
    let j = bestI - 48; if (j < 0) break;
    let sj = sal[j]; for (let t = -2; t <= 2; t++) if (j + t >= 0 && j + t < sal.length) sj = Math.max(sj, sal[j + t]);
    const fund = around(A, half).a, top = around(A, CANDS[bestI]).a;
    if (sj >= 0.8 * bestS && fund >= 0.35 * top) { let bj = j; for (let t = -2; t <= 2; t++) if (j + t >= 0 && j + t < sal.length && sal[j + t] > sal[bj]) bj = j + t; bestI = bj; bestS = sal[bj]; } else break;
  }
  // refine from the matched peaks, weighted by amplitude
  const f0c = CANDS[bestI];
  let num = 0, den = 0, e2 = 0;
  const H = Math.min(HMAX, Math.floor(F_TOP / f0c));
  const hits: { h: number; k: number; a: number }[] = [];
  for (let h = 1; h <= H; h++) {
    const m = around(A, h * f0c);
    if (m.a <= gate * 0.05) continue;
    if (h > 1 && hits.length && m.a > 1.25 * hits[0].a && hits[0].h === 1) continue;     // someone else's partial
    const r = refine(A, m.k);
    num += r.a * (r.f / h); den += r.a; e2 += r.a * r.a;
    hits.push({ h, k: m.k, a: r.a });
  }
  if (!den) return null;
  const f = num / den;
  // take the series out of the spectrum
  // (the skirts of an attack or a vibrato leave look-alike peaks 20-40 Hz away: those are damped too, less hard)
  const a1 = hits.length && hits[0].h === 1 ? hits[0].a : 0;
  for (const t of hits) {
    const kc = t.k;
    // a harmonic is taken out only up to what a natural tone of this fundamental would have (a partial of 1/h or weaker):
    // the rest is somebody else's note sitting on this harmonic (a bass and a lead a fifth-octave apart)
    const own = t.h === 1 || !a1 ? t.a : Math.min(t.a, 1.5 * a1 * Math.pow(t.h, -0.8));
    if (own >= t.a * 0.99) for (let k = Math.max(1, kc - 4); k <= Math.min(FFT_N / 2, kc + 4); k++) A[k] *= 0.04;
    else for (let d = 0; d <= 4; d++) for (const k of d ? [kc - d, kc + d] : [kc]) if (k >= 1 && k <= FFT_N / 2) A[k] = Math.max(0, A[k] - 1.1 * own * hannLobe(d / BINS_PER_LOBE));
    // the Hann window's skirts (a strong partial leaves ~ -30 dB lobes up to 60 Hz away) are subtracted by their known shape
    for (let d = 5; d <= 28; d++) for (const k of [kc - d, kc + d]) if (k >= 1 && k <= FFT_N / 2) A[k] = Math.max(0, A[k] - 1.2 * own * hannLobe(d / BINS_PER_LOBE));
  }
    return { f, amp: Math.sqrt(e2), sal: bestS };
}

interface FrameRes { f: number[]; a: number[]; noiseAmp: number; noiseHz: number }

/** @returns the tune; throws only for an unusable input */
export function audioToTune(input: Float32Array, rate: number, o: AudioOptions = {}): AyTune & { stats: AudioStats } {
  const warnings: string[] = [];
  const voices = Math.max(1, Math.min(3, Math.round(o.voices ?? 3)));
  const snap = o.snap !== false, wantNoise = o.noise !== false;
  const gateDb = o.gateDb ?? -40;
  const start = Math.max(0, Math.floor((o.startSeconds ?? 0) * rate));
  const maxSamples = Math.floor((o.maxSeconds ?? 300) * rate);
  const raw = input.subarray(start, Math.min(input.length, start + maxSamples));
  const truncated = start + maxSamples < input.length;
  if (raw.length < rate * 0.1) throw new Error('the recording is too short');
  if (truncated) warnings.push(`only ${(maxSamples / rate).toFixed(0)} s of the ${(input.length / rate).toFixed(0)} s recording were analysed (raise "Seconds" to analyse more)`);
  let x = resample(raw, rate, AUDIO_RATE);
  // remove DC, normalise the very quiet recordings so the gate works on the music
  let mean = 0; for (let i = 0; i < x.length; i++) mean += x[i]; mean /= x.length;
  let peak = 0; for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i] - mean));
  if (peak < 1e-4) throw new Error('the recording is silent');
  const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = (x[i] - mean) / peak;
  x = y;

  const nframes = Math.max(1, Math.floor(x.length / HOP));
  const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N), A = new Float64Array(FFT_N / 2 + 1);
  const frames: FrameRes[] = new Array(nframes);
  const bandLo = Math.round(NOISE_LO / BIN_HZ), bandHi = Math.min(FFT_N / 2, Math.round(NOISE_HI / BIN_HZ));
  const absGate = Math.pow(10, -52 / 20);                // below this nothing is a note
  let loud = 0;                                        // loudest voice amplitude seen (for the gate)
  const mean0: number[] = [];
  for (let fr = 0; fr < nframes; fr++) {
    spectrum(x, fr * HOP + HOP / 2, re, im, A);
    const res: FrameRes = { f: [], a: [], noiseAmp: 0, noiseHz: 0 };
    const found: Found[] = [];
    for (let v = 0; v < voices; v++) {
      const sr = strongestSeries(A, absGate * 0.6);
      if (!sr) break;
      found.push(sr);
    }
    found.sort((p, q) => q.amp - p.amp);
    const first = found.length ? found[0].amp : 0;
    for (const sr of found) {
      if (sr.amp < absGate || sr.amp < 0.15 * first) continue;
      res.f.push(sr.f); res.a.push(sr.amp);
    }
    if (first > loud) loud = first;
    // what is left in the high band is noise-like: the residual power as a sine-equivalent amplitude, and its centroid
    if (wantNoise) {
      let p = 0, cw = 0, logSum = 0;
      for (let k = bandLo; k <= bandHi; k++) { const q = A[k] * A[k]; p += q; cw += q * k * BIN_HZ; logSum += Math.log(A[k] + 1e-9); }
      const bins = bandHi - bandLo + 1;
      const flat = Math.exp(logSum / bins) / (Math.sqrt(p / bins) + 1e-12);        // 1 = flat (noise), small = peaky (left-over partials)
      // sine-equivalent amplitude of the band's power (Parseval for the Hann window, zero padded to FFT_N)
      res.noiseAmp = flat >= 0.3 ? Math.sqrt(((2 * N) / (3 * FFT_N)) * p) : 0;
      res.noiseHz = p > 0 ? cw / p : 5000;
    }
    frames[fr] = res;
    mean0.push(first);
  }
  if (loud <= 0 && !frames.some((f) => f.noiseAmp > 0)) throw new Error('no pitched sound was found in the recording');

  // ---------------------------------------------------------------- reference level and gate
  const sortedFirst = mean0.filter((v) => v > 0).sort((a, b) => a - b);
  const ref = Math.max(1e-6, (sortedFirst[Math.floor(sortedFirst.length * 0.97)] ?? loud) * Math.pow(10, (o.gainDb ?? 0) / 20));
  const gate = ref * Math.pow(10, gateDb / 20);
  // ---------------------------------------------------------------- tuning offset (cents) from the loud, steady pitches
  const cents: number[] = [];
  for (const f of frames) for (let i = 0; i < f.f.length; i++) if (f.a[i] > gate * 3) { const m = 69 + 12 * Math.log2(f.f[i] / 440); cents.push((m - Math.round(m)) * 100); }
  cents.sort((a, b) => a - b);
  let tuning = cents.length ? cents[Math.floor(cents.length / 2)] : 0;
  if (Math.abs(tuning) < 6) tuning = 0;

  // ---------------------------------------------------------------- voice tracking
  const pitch: Float64Array[] = Array.from({ length: 3 }, () => new Float64Array(nframes));    // semitones (MIDI, fractional); 0 = not tonal
  const level: Uint8Array[] = Array.from({ length: 3 }, () => new Uint8Array(nframes));
  const noiseOn = new Uint8Array(nframes);                       // 1 = the noise generator is audible in this frame
  const noiseLevel = new Uint8Array(nframes);
  const noisePer = new Uint8Array(nframes);
  const noiseVoice = new Int8Array(nframes).fill(-1);
  const toLevel = (a: number, r: number): number => {
    const t = a / r;
    if (t < DAC[1] * 0.7) return 0;
    let best = 1, bd = Infinity;
    for (let k = 1; k < 16; k++) { const d = Math.abs(Math.log(DAC[k]) - Math.log(Math.min(1, t))); if (d < bd) { bd = d; best = k; } }
    return best;
  };
  const perms: number[][] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const last = [0, 0, 0], lastAge = [99, 99, 99];                // previous MIDI pitch of each voice, frames since it sounded
  for (let fr = 0; fr < nframes; fr++) {
    const f = frames[fr];
    const det: { m: number; a: number }[] = [];
    for (let i = 0; i < f.f.length; i++) if (f.a[i] >= gate) det.push({ m: 69 + 12 * Math.log2(f.f[i] / 440) - tuning / 100, a: f.a[i] });
    const assign: number[] = new Array(det.length).fill(-1);      // detection -> voice
    if (det.length) {
      let bestCost = Infinity, bestP = perms[0];
      for (const p of perms) {
        let c = 0;
        for (let i = 0; i < det.length; i++) {
          const v = p[i];
          const cont = lastAge[v] <= 3 && last[v] > 0;
          c += cont ? Math.min(24, Math.abs(det[i].m - last[v])) : 7 + (v === 0 ? 0 : v === 1 ? 0.1 : 0.2);
        }
        // detections are listed by strength; keep the register order of low notes on voice A when nothing else decides
        if (c < bestCost - 1e-9) { bestCost = c; bestP = p; }
      }
      for (let i = 0; i < det.length; i++) assign[i] = bestP[i];
    }
    const used = [false, false, false];
    for (let i = 0; i < det.length; i++) {
      const v = assign[i];
      used[v] = true;
      pitch[v][fr] = det[i].m;
      level[v][fr] = toLevel(det[i].a, ref);
      last[v] = det[i].m; lastAge[v] = 0;
    }
    for (let v = 0; v < 3; v++) if (!used[v]) lastAge[v]++;
    // noise: on a free voice, or instead of the weakest one when it is louder
    if (wantNoise && f.noiseAmp > 0) {
      const nl = toLevel(f.noiseAmp, ref);
      if (nl > 0) {
        let v = used.findIndex((u, k) => !u && k < voices);
        if (v < 0) {
          let weakest = 0; for (let k = 1; k < voices; k++) if (level[k][fr] < level[weakest][fr]) weakest = k;
          if (nl > level[weakest][fr]) v = weakest;
        }
        if (v >= 0) {
          noiseVoice[fr] = v; noiseOn[fr] = 1; noiseLevel[fr] = nl;
          noisePer[fr] = Math.max(1, Math.min(31, Math.round(125000 / (2 * Math.max(1500, f.noiseHz)))));
        }
      }
    }
  }

  // ---------------------------------------------------------------- smoothing: median pitch, drop 1-frame notes, fill 1-frame gaps
  const med3 = (a: number, b: number, c: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  for (let v = 0; v < 3; v++) {
    const p = pitch[v], l = level[v];
    for (let pass = 0; pass < 2; pass++) {
      for (let fr = 1; fr < nframes - 1; fr++) {      // gap fill
        if (!p[fr] && p[fr - 1] && p[fr + 1] && Math.abs(p[fr - 1] - p[fr + 1]) < 1) { p[fr] = (p[fr - 1] + p[fr + 1]) / 2; l[fr] = Math.min(l[fr - 1], l[fr + 1]); }
      }
    }
    // single frames are clicks and transients, not notes
    for (let fr = 0; fr < nframes;) {
      if (!p[fr]) { fr++; continue; }
      let e = fr + 1;
      while (e < nframes && p[e] && Math.abs(p[e] - p[e - 1]) < 1.5) e++;
      if (e - fr < 2) for (let k = fr; k < e; k++) { p[k] = 0; l[k] = 0; }
      fr = e;
    }
    const q = p.slice();
    for (let fr = 1; fr < nframes - 1; fr++) if (q[fr - 1] && q[fr] && q[fr + 1] && Math.abs(q[fr] - q[fr - 1]) < 2.5 && Math.abs(q[fr] - q[fr + 1]) < 2.5) p[fr] = med3(q[fr - 1], q[fr], q[fr + 1]);
  }

  // ---------------------------------------------------------------- semitone snapping
  if (snap) {
    for (let v = 0; v < 3; v++) for (let fr = 0; fr < nframes; fr++) {
      const m = pitch[v][fr];
      if (m) { const r = Math.round(m); if (Math.abs(m - r) < 0.35) pitch[v][fr] = r; }
    }
  }

  // ---------------------------------------------------------------- registers
  const regs = new Uint8Array(nframes * 14);
  const per = [0x100, 0x100, 0x100];
  let nper = 8;
  let tonalFrames = [0, 0, 0], noiseFrames = 0;
  for (let fr = 0; fr < nframes; fr++) {
    const o14 = fr * 14;
    let mixer = 0xc0;
    for (let v = 0; v < 3; v++) {
      const isNoise = noiseOn[fr] && noiseVoice[fr] === v && !(pitch[v][fr] && level[v][fr] >= noiseLevel[fr]);
      const tonal = pitch[v][fr] > 0 && !isNoise;
      if (tonal) {
        const hz = 440 * Math.pow(2, (pitch[v][fr] - 69) / 12);
        per[v] = Math.max(1, Math.min(4095, Math.round(YM_CLOCK / (16 * hz))));
        tonalFrames[v]++;
      }
      regs[o14 + 2 * v] = per[v] & 255; regs[o14 + 2 * v + 1] = per[v] >> 8;
      if (!tonal) mixer |= 1 << v;                       // tone off
      if (isNoise) { mixer |= 0; } else mixer |= 8 << v;  // noise on only for the voice that carries it
      regs[o14 + 8 + v] = isNoise ? noiseLevel[fr] : tonal ? level[v][fr] : 0;
    }
    if (noiseOn[fr]) { nper = noisePer[fr]; noiseFrames++; }
    regs[o14 + 6] = nper;
    regs[o14 + 7] = mixer;
    regs[o14 + 13] = 0xff;
  }
  warnings.unshift('audio import is an approximation: three square-wave voices and one noise generator at 50 Hz cannot hold a full recording; single instruments, chords of up to three notes and chiptune-like music come out best');
  const stats: AudioStats = { seconds: nframes / 50, frames: nframes, sourceRate: rate, truncated, voiced: tonalFrames, noiseFrames, tuningCents: Math.round(tuning) };
  if (!tonalFrames.some((n) => n > 0) && !noiseFrames) warnings.push('nothing was loud enough to keep; lower the gate');
  return { title: o.title ?? '', author: '', comment: `audio recording, ${(input.length / rate).toFixed(1)} s at ${rate} Hz`, regs, nframes, loopFrame: 0, source: 'audio', warnings, stats };
}
