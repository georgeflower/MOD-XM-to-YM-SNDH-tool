/**
 * SPC (SNES sound) -> tracker module. The SPC file is played in the emulator; for every 50 Hz frame the 8 DSP voices are
 * read (key-on, sample, pitch, envelope, volume). The BRR samples that were keyed on become instruments (decoded to PCM,
 * pitch measured), every voice becomes a channel, and the result is an ordinary module that goes through the normal
 * converter, import dialog, previews and exports.
 *
 * Loop: the key-on events (voice, sample, pitch) are searched for a period; once the music has repeated itself for a whole
 * period the recording stops, the module ends at the loop end and restarts at the loop start.
 *
 * Echo: the DSP echo (delay EDL x 16 ms, volume EVOL, FIR, on for the EON voices) is turned into extra "echo" channels: a
 * delayed copy of each echoed voice at the level of the first repeat. They get the Low priority, so the converter only
 * gives them voices the dry channels do not need.
 *
 * Rows, two layouts:
 *  - frame: one row per 50 Hz frame, speed 2 at 250 BPM (10 ms ticks). The 50 Hz frame snapshots then fall on tick 1 of a
 *    row, after that tick's slides, so pitch changes (1xx / 2xx, 1/16 semitone steps) and volume changes (volume column)
 *    show up in the same frame. Exact, but the patterns are long.
 *  - step: the note grid of the song is measured from the key-on times; one row per step at 125 BPM (one tick per 50 Hz
 *    frame), the speed of each row is the number of frames until the next grid point (Fxx where it changes). Notes off the
 *    grid get a note delay (EDx), changes inside a row become slides (1xx / 2xx, volume column 6x / 7x, Axy) that reach the
 *    value at the end of the row. Readable patterns for the editor; vibrato faster than a row is smoothed away.
 */
import type { Cell, Instrument, Module, Sample } from '../core/types';
import { emptyCell } from '../core/types';
import { SpcPlayer, SPC_RATE, type KonEvent } from './spc';

export const SPC_FRAME = SPC_RATE / 50;      // 640 DSP samples per 50 Hz frame
const MAX_SECONDS = 300;

export type SpcRows = 'frame' | 'step';

export interface SpcOptions {
  /** where to start / how much to read, seconds (default 0 / the song length from the tags, else 120, max 300). With loop
   *  detection on and a loop found, the song ends at the loop end instead. */
  startSeconds?: number;
  seconds?: number;
  /** a voice is muted (left out of the module and of the original preview) when its number is true (index 0..7) */
  voiceOff?: boolean[];
  /** noise voices (NON) become noise instruments */
  noise?: boolean;
  /** the echo/reverb in the "original" preview (default on) */
  echo?: boolean;
  /** echo channels in the module (default on) */
  echoNotes?: boolean;
  /** look for the loop point (default on) */
  loop?: boolean;
  /** row layout (default 'frame'; 'step' falls back to 'frame' when no steady note grid is found) */
  rows?: SpcRows;
}

export interface SpcInfo {
  title: string; game: string; artist: string; dumper: string; comment: string;
  seconds: number; frames: number; instruments: number; notes: number[];
  /** from the file's tags, 0 = unknown */
  tagSeconds: number;
  droppedInstruments: number;
  outOfRange: number;
  echo: boolean;
  /** loop found: start and end in seconds from the Start point */
  loop: { start: number; end: number } | null;
  /** the measured note grid in ms (null = none found) and the layout that was used */
  stepMs: number | null;
  rows: SpcRows;
  /** source voice of each echo channel (channel 8 + i) */
  echoVoices: number[];
  /** voices that played at least one note */
  voicesUsed: boolean[];
  warnings: string[];
}

export interface SpcResult {
  module: Module;
  info: SpcInfo;
  /** the song as the SNES plays it, 32 kHz stereo (interleaved), for the "original" preview */
  pcm: Int16Array;
  /** where the original preview loops back to, seconds (0 = the beginning) */
  pcmLoop: number;
  /** default channel priorities (the echo channels are Low) */
  prio: Record<number, number>;
}

// ---------------------------------------------------------------------------------------------------------------------
// BRR

interface Brr { data: Float64Array; ls: number; ll: number; loop: 0 | 1; blocks: number; peak: number }

function decodeBrr(ram: Uint8Array, addr: number, loopAddr: number): Brr {
  const out: number[] = [];
  let p1 = 0, p2 = 0;
  let a = addr, blocks = 0, loops = false, loopBlock = -1;
  const seen = new Set<number>();
  for (; blocks < 8192; blocks++) {
    if (a === loopAddr && loopBlock < 0) loopBlock = blocks;
    if (seen.has(a)) break;
    seen.add(a);
    const h = ram[a & 0xffff];
    const shift = h >> 4, filter = h & 0x0c;
    for (let k = 0; k < 16; k++) {
      const byte = ram[(a + 1 + (k >> 1)) & 0xffff];
      let s = k & 1 ? byte & 15 : byte >> 4;
      if (s > 7) s -= 16;
      s = (s << shift) >> 1;
      if (shift >= 0xd) s = s < 0 ? -0x800 : 0;
      if (filter >= 8) {
        s += p1; s -= p2 >> 1;
        if (filter === 8) { s += (p2 >> 1) >> 4; s += (p1 * -3) >> 6; }
        else { s += (p1 * -13) >> 7; s += ((p2 >> 1) * 3) >> 4; }
      } else if (filter) { s += p1 >> 1; s += (-p1) >> 5; }
      if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
      s = ((s * 2) << 16) >> 16;
      p2 = p1; p1 = s;
      out.push(s);
    }
    a = (a + 9) & 0xffff;
    if (h & 1) { loops = !!(h & 2); break; }
  }
  const data = new Float64Array(out.length);
  let peak = 0;
  for (let i = 0; i < out.length; i++) { data[i] = out[i] / 32768; if (Math.abs(data[i]) > peak) peak = Math.abs(data[i]); }
  const hasLoop = loops && loopBlock >= 0;
  const ls = hasLoop ? loopBlock * 16 : 0;
  return { data, ls, ll: hasLoop ? Math.max(0, out.length - ls) : 0, loop: hasLoop ? 1 : 0, blocks, peak };
}

/** samples per cycle of a (possibly looped) sample and how clear the pitch is (0..1); null when there is no usable pitch */
export function samplePeriod(b: Brr): { period: number; clarity: number } | null {
  const d = b.data;
  let x: Float64Array, circular = false;
  if (b.loop && b.ll >= 8) {
    x = d.subarray(b.ls, b.ls + b.ll);
    circular = true;
    if (b.ll <= 2048) {
      // a short loop is a single (or a few) cycle(s) of the waveform
      const r = autocorr(x, true, 8, x.length >> 1);
      if (r && r.clarity > 0.9) return r;
      return { period: x.length, clarity: 1 };
    }
  } else {
    const start = Math.min(Math.max(0, d.length - 2048) >> 1, 1024);
    x = d.subarray(start, Math.min(d.length, start + 4096));
    if (x.length < 128) return null;
  }
  return autocorr(x, circular, 8, Math.min(x.length >> 1, 2048));
}

function autocorr(x: Float64Array, circular: boolean, minLag: number, maxLag: number): { period: number; clarity: number } | null {
  const n = x.length;
  if (maxLag <= minLag + 2) return null;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  const r = new Float64Array(maxLag + 2);
  for (let t = minLag - 1; t <= maxLag + 1; t++) {
    let c = 0, a = 0, bb = 0;
    const m = circular ? n : n - t;
    for (let i = 0; i < m; i++) {
      const u = x[i] - mean, v = x[circular ? (i + t) % n : i + t] - mean;
      c += u * v; a += u * u; bb += v * v;
    }
    r[t] = a > 0 && bb > 0 ? c / Math.sqrt(a * bb) : 0;
  }
  // a smooth waveform correlates with itself at tiny lags: only look for a peak after the correlation has dropped away
  let t0 = minLag;
  while (t0 <= maxLag && r[t0] > 0.2) t0++;
  if (t0 > maxLag) return null;
  let best = 0;
  for (let t = t0; t <= maxLag; t++) if (r[t] > best) best = r[t];
  if (best < 0.6) return null;
  for (let t = t0; t <= maxLag; t++) {
    if (r[t] >= 0.9 * best && r[t] >= r[t - 1] && r[t] >= r[t + 1]) {
      const den = r[t - 1] - 2 * r[t] + r[t + 1];
      const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (r[t - 1] - r[t + 1])) / den)) : 0;
      return { period: t + off, clarity: r[t] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// loop and note grid

export interface LoopEvent { t: number; key: string }

/**
 * The loop of a song from its key-on events (t in DSP samples, key = voice + sample + pitch): the shortest period L, with
 * the earliest start S, such that every event from S + L to the end has a twin L earlier (within a timer tick), and the
 * recording covers S + 2L (the whole loop has been heard twice) and at least `minSpan` after S. null when the music has
 * not repeated yet.
 */
export function findLoop(evs: LoopEvent[], endT: number, minLen = 2 * SPC_RATE, minSpan = 30 * SPC_RATE): { start: number; len: number } | null {
  const n = evs.length;
  if (n < 8) return null;
  // drivers keep fractional tempo counters, so a note can land one timer tick (a few ms) off from one pass to the next
  const TOL = 200;
  const byKey = new Map<string, number[]>();
  for (const e of evs) { let a = byKey.get(e.key); if (!a) byKey.set(e.key, (a = [])); a.push(e.t); }
  const has = (key: string, t: number): boolean => {
    const a = byKey.get(key)!;
    let lo = 0, hi = a.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] < t - TOL) lo = mid + 1; else if (a[mid] > t + TOL) hi = mid - 1; else return true;
    }
    return false;
  };
  const first = evs[0].t, last = evs[n - 1];
  const cands = byKey.get(last.key)!.map((t) => last.t - t).filter((L) => L >= minLen).sort((a, b) => a - b);
  let best: { start: number; len: number } | null = null;
  for (const L of cands) {
    if (endT - first < 2 * L) break;
    let bad = -Infinity;
    for (let i = n - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.t - L < first - TOL) break;
      if (!has(e.key, e.t - L)) { bad = e.t; break; }
    }
    // the repeating part starts with the first event after (bad - L)
    let start = first;
    if (bad > -Infinity) {
      const after = evs.find((e) => e.t > bad - L + TOL);
      if (!after) continue;
      start = after.t;
    }
    // the whole loop heard twice, and the music periodic for at least half a minute (a repeated bar is not a loop)
    if (endT < start + Math.max(2 * L, minSpan)) continue;
    let inLoop = 0;
    for (const e of evs) if (e.t >= start && e.t < start + L) inLoop++;
    if (inLoop < 4) continue;
    if (!best || start < best.start - SPC_RATE) best = { start, len: L };
  }
  return best;
}

/**
 * The note grid of a song: the longest step T (64..250 ms) that 92 % of the key-on times (DSP samples, sorted) fall on,
 * with its phase. The step and phase are refined by a least-squares fit over a growing window, so a song of several minutes
 * stays on the grid.
 */
export function findStep(times: number[]): { T: number; phase: number; fit: number } | null {
  const on: number[] = [];
  for (const t of times) if (!on.length || t - on[on.length - 1] > 32) on.push(t);
  if (on.length < 12) return null;
  const MIN = 0.064 * SPC_RATE, MAX = 0.25 * SPC_RATE;
  const votes = new Map<number, number>();
  for (let i = 0; i + 1 < on.length; i++) {
    const d = on[i + 1] - on[i];
    if (d < MIN || d > 8 * MAX) continue;
    for (let k = 1; k <= 8; k++) {
      const T = d / k;
      if (T < MIN) break;
      if (T > MAX) continue;
      const key = Math.round(T / 16);
      votes.set(key, (votes.get(key) ?? 0) + 1);
    }
  }
  const tolOf = (T: number) => Math.max(160, T * 0.05);
  const fitGrid = (T0: number): { T: number; phase: number; fit: number } => {
    let T = T0, phase = on[0], span = 16 * T0;
    const lastT = on[on.length - 1];
    for (let iter = 0; iter < 24; iter++) {
      const tol = tolOf(T);
      let sk = 0, st = 0, skk = 0, skt = 0, m = 0;
      for (const t of on) {
        if (t - on[0] > span) break;
        const k = Math.round((t - phase) / T);
        if (Math.abs(t - (phase + k * T)) > tol) continue;
        sk += k; st += t; skk += k * k; skt += k * t; m++;
      }
      const den = m * skk - sk * sk;
      if (m >= 3 && den > 0) {
        const nT = (m * skt - sk * st) / den;
        if (nT > MIN * 0.9 && nT < MAX * 1.1) { T = nT; phase = (st - T * sk) / m; }
      }
      if (span >= lastT - on[0]) break;
      span *= 2;
    }
    const tol = tolOf(T);
    let ok = 0;
    for (const t of on) { const k = Math.round((t - phase) / T); if (Math.abs(t - (phase + k * T)) <= tol) ok++; }
    phase = ((phase % T) + T) % T;
    return { T, phase, fit: ok / on.length };
  };
  const tried = [...votes].sort((a, b) => b[1] - a[1]).slice(0, 48).map(([k]) => k * 16);
  // the longest step that fits (almost) as well as the best one
  const fits = tried.map(fitGrid);
  const top = Math.max(0, ...fits.map((g) => g.fit));
  let best: { T: number; phase: number; fit: number } | null = null;
  for (const g of fits) {
    if (g.fit < Math.max(0.92, top - 0.02)) continue;
    if (!best || g.T > best.T * 1.02 || (Math.abs(g.T - best.T) <= best.T * 0.02 && g.fit > best.fit)) best = g;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------------

const MIDDLE_C_PERIOD = 8363 / 261.6256;     // samples per cycle of an XM sample tuned to C-4
const PRIO_LOW = -3;

interface Inst { id: number; key: string; srcn: number; addr: number; sample: Sample; noise: boolean; uses: number; pitched: boolean; pitches: number[] }

/** a voice in one 50 Hz frame, as collected from the emulator (gain: extra level, for the echo channels) */
interface FrameVoice { kon: KonEvent | null; env: number; volL: number; volR: number; pitch: number; noise: boolean; gain: number; rel: boolean }
const SILENT: FrameVoice = { kon: null, env: 0, volL: 0, volR: 0, pitch: 0, noise: false, gain: 0, rel: true };
interface KonAt { e: KonEvent; inst: Inst; t: number }

const s8 = (v: number) => (v << 24) >> 24;

export function spcToModule(file: Uint8Array, o: SpcOptions = {}): SpcResult {
  const player = new SpcPlayer(file);
  const tags = player.tags;
  const warnings: string[] = [];
  const dsp = player.dsp;
  const ram = player.ram;
  const startS = Math.max(0, o.startSeconds ?? 0);
  const loopOn = o.loop !== false;
  const wantFrames = Math.floor(Math.min(MAX_SECONDS, Math.max(1, o.seconds ?? (tags.seconds ? Math.min(tags.seconds, 240) : 120))) * 50);
  const maxFrames = loopOn ? MAX_SECONDS * 50 : wantFrames;
  const skipFrames = Math.floor(startS * 50);
  const muted = (n: number) => !!o.voiceOff?.[n];
  let muteMask = 0;
  for (let n = 0; n < 8; n++) if (muted(n)) muteMask |= 1 << n;
  dsp.mixMute = muteMask;
  dsp.echoOff = o.echo === false;
  const pcmAll = new Int16Array(maxFrames * SPC_FRAME * 2);

  // skip ahead (no output kept)
  for (let f = 0; f < skipFrames; f++) player.run(SPC_FRAME);
  const t0 = dsp.sample;

  const insts = new Map<string, Inst>();
  const noiseInst: { v: Inst | null } = { v: null };
  const list: Inst[] = [];
  const timeline: FrameVoice[][] = [];
  const konLog: KonEvent[] = [];
  const loopEvents: LoopEvent[] = [];
  const echoG = new Float32Array(maxFrames), echoD = new Uint8Array(maxFrames), echoEon = new Uint8Array(maxFrames);
  dsp.onKon = (e) => { konLog.push(e); };

  // the instrument table has to be read when the voice is keyed on (the driver may rewrite sample memory later)
  const instOf = (e: KonEvent, noise: boolean): Inst => {
    if (noise) {
      if (!noiseInst.v) {
        const n = 4096, data = new Float64Array(n);
        let seed = 0x1234567;
        for (let i = 0; i < n; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; data[i] = (seed / 2147483648 - 1); }
        const s: Sample = { name: 'SNES noise', data, ls: 0, ll: n, loop: 1, vol: 64, fine: 0, rel: 0 };
        const inst: Inst = { id: 0, key: 'noise', srcn: -1, addr: 0, sample: s, noise: true, uses: 0, pitched: false, pitches: [] };
        list.push(inst); noiseInst.v = inst;
      }
      return noiseInst.v;
    }
    const key = `${e.srcn}:${e.addr}:${e.loop}`;
    let inst = insts.get(key);
    if (!inst) {
      const brr = decodeBrr(ram, e.addr, e.loop);
      const per = samplePeriod(brr);
      const peak = brr.peak || 1;
      const data = new Float64Array(brr.data.length);
      for (let i = 0; i < data.length; i++) data[i] = brr.data[i] / peak;
      let rel = 0, fine = 0;
      const pitched = !!per && per.clarity >= 0.6;
      if (per && pitched) {
        const st = 12 * Math.log2(per.period / MIDDLE_C_PERIOD);
        rel = Math.round(st); fine = Math.round((st - rel) * 128);
        if (fine > 127) { fine = 127; } if (fine < -128) fine = -128;
      }
      const s: Sample = {
        name: `SNES $${e.srcn.toString(16).toUpperCase().padStart(2, '0')}${brr.loop ? ' loop' : ''}`,
        data, ls: brr.ls, ll: brr.ll, loop: brr.loop, vol: 64, fine, rel,
      };
      (s as Sample & { peak?: number }).peak = peak;
      inst = { id: 0, key, srcn: e.srcn, addr: e.addr, sample: s, noise: false, uses: 0, pitched, pitches: [] };
      insts.set(key, inst); list.push(inst);
    }
    inst.pitches.push(e.pitch);
    return inst;
  };

  const evByFrame: Map<number, KonAt>[] = [];
  let loop: { start: number; len: number } | null = null;
  let recorded = maxFrames, lastKon = 0, ended = false;
  for (let f = 0; f < maxFrames; f++) {
    for (const v of dsp.voices) v.envSum = 0;
    konLog.length = 0;
    player.run(SPC_FRAME, pcmAll, f * SPC_FRAME * 2);
    const row: FrameVoice[] = [];
    const evs = new Map<number, KonAt>();
    for (const e of konLog) {
      const isNoise = !!(dsp.regs[0x3d] & (1 << e.voice)) && o.noise !== false;
      evs.set(e.voice, { e, inst: instOf(e, isNoise), t: e.sample - t0 });
      loopEvents.push({ t: e.sample - t0, key: `${e.voice}:${e.srcn}:${e.addr}:${e.pitch}` });
    }
    evByFrame.push(evs);
    for (let n = 0; n < 8; n++) {
      const v = dsp.voices[n], b = n * 16;
      row.push({
        kon: evs.get(n)?.e ?? null,
        env: v.envSum / SPC_FRAME,
        volL: s8(dsp.regs[b]), volR: s8(dsp.regs[b + 1]),
        pitch: dsp.regs[b + 2] | ((dsp.regs[b + 3] & 0x3f) << 8),
        noise: !!(dsp.regs[0x3d] & (1 << n)),
        gain: 1,
        rel: v.envMode === 0,
      });
    }
    timeline.push(row);
    // echo as it stands in this frame: level of the first repeat relative to the dry sound, and the delay
    {
      const r = dsp.regs;
      const mv = Math.abs(s8(r[0x0c])) + Math.abs(s8(r[0x1c]));
      const ev = Math.abs(s8(r[0x2c])) + Math.abs(s8(r[0x3c]));
      let fir = 0;
      for (let k = 0; k < 8; k++) fir += s8(r[0x0f + 16 * k]);
      const on = !(r[0x6c] & 0x20);
      echoG[f] = on && mv ? Math.min(1.5, (ev / mv) * (Math.abs(fir) / 128)) : 0;
      echoD[f] = Math.round(((r[0x7d] & 15) * 16) / 20);
      echoEon[f] = r[0x4d];
    }
    if (konLog.length) lastKon = f;
    // a jingle that has ended: no new notes for 20 s
    if (loopOn && f >= wantFrames && f - lastKon > 1000) { recorded = f + 1; ended = true; break; }
    if (loopOn && f >= 499 && f % 250 === 249) {
      const lp = findLoop(loopEvents, (f + 1) * SPC_FRAME);
      if (lp) { loop = lp; recorded = f + 1; break; }
    }
  }
  dsp.onKon = null;
  if (loopOn && !loop) recorded = Math.min(recorded, wantFrames);
  timeline.length = Math.min(timeline.length, recorded);
  evByFrame.length = Math.min(evByFrame.length, recorded);

  // samples without a pitch (percussion, noise): the note numbers are arbitrary, centre them on C-4
  for (const inst of list) {
    if (inst.pitched || inst.noise || !inst.pitches.length) continue;
    const ps = [...inst.pitches].sort((a, b) => a - b), med = Math.max(1, ps[ps.length >> 1]);
    inst.sample.rel = Math.max(-96, Math.min(95, Math.round(12 * Math.log2(((med * SPC_RATE) / 4096) / 8363))));
    inst.sample.fine = 0;
  }

  // ---- instruments (XM allows 128)
  list.sort((a, b) => a.srcn - b.srcn || a.addr - b.addr);
  let dropped = 0;
  const useCount = new Map<Inst, number>();
  for (const ev of evByFrame) for (const { inst } of ev.values()) useCount.set(inst, (useCount.get(inst) ?? 0) + 1);
  let kept = list;
  if (list.length > 128) {
    kept = [...list].sort((a, b) => (useCount.get(b) ?? 0) - (useCount.get(a) ?? 0)).slice(0, 128).sort((a, b) => a.srcn - b.srcn || a.addr - b.addr);
    dropped = list.length - 128;
    warnings.push(`${list.length} different samples are used; only the 128 most used became instruments (${dropped} dropped)`);
  }
  const instruments: (Instrument | null)[] = [null];
  kept.forEach((inst, i) => {
    inst.id = i + 1;
    instruments.push({
      name: inst.sample.name, samples: [inst.sample], keymap: Array(96).fill(0), venv: [], vflags: 0, vsus: 0, vls: 0, vle: 0, fade: 0, vib: [0, 0, 0, 0],
    });
  });
  for (const inst of list) if (!kept.includes(inst)) inst.id = 0;

  // ---- echo channels: a delayed copy of every echoed voice at the level of the first repeat
  const frames = timeline.length;
  const echoVoices: number[] = [];
  const echoUsed = (() => { for (let f = 0; f < frames; f++) if (echoG[f] > 0 && echoEon[f]) return true; return false; })();
  if (echoUsed && o.echo !== false && o.echoNotes !== false) {
    for (let n = 0; n < 8; n++) {
      if (muted(n)) continue;
      const gs: number[] = [];
      let notes = 0;
      for (let f = 0; f < frames; f++) {
        if (evByFrame[f].has(n)) notes++;
        if (echoEon[f] & (1 << n) && echoD[f] > 0) gs.push(echoG[f]);
      }
      if (!notes || gs.length < frames / 4) continue;
      gs.sort((a, b) => a - b);
      if (gs[gs.length >> 1] >= 0.12) echoVoices.push(n);
    }
    echoVoices.forEach((n, j) => {
      const ch = 8 + j, bit = 1 << n;
      for (let f = 0; f < frames; f++) {
        const d = echoD[f], src = f - d;
        if (!d || src < 0 || !(echoEon[src] & bit) || !echoG[f]) { timeline[f].push(SILENT); continue; }
        timeline[f].push({ ...timeline[src][n], gain: echoG[f] });
        const ev = evByFrame[src].get(n);
        if (ev) evByFrame[f].set(ch, { ...ev, t: ev.t + d * SPC_FRAME });
      }
    });
  }
  const nch = 8 + echoVoices.length;

  // ---- loudness scale: the 98th percentile of the dry channel gains becomes volume 60
  const mv = (Math.abs(s8(dsp.regs[0x0c])) + Math.abs(s8(dsp.regs[0x1c]))) / 254 || 1;
  const gainOf = (fv: FrameVoice, inst: Inst | null): number => {
    const pk = inst && !inst.noise ? (inst.sample as Sample & { peak?: number }).peak ?? 1 : 0.5;
    return (fv.env / 2047) * ((Math.abs(fv.volL) + Math.abs(fv.volR)) / 254) * Math.min(1, pk) * mv * fv.gain;
  };
  let scale = 1;
  {
    const all: number[] = [];
    const cur: (Inst | null)[] = Array(8).fill(null);
    for (let f = 0; f < frames; f++) for (let n = 0; n < 8; n++) {
      const ev = evByFrame[f].get(n);
      if (ev) cur[n] = ev.inst;
      const g = gainOf(timeline[f][n], cur[n]);
      if (g > 0.002) all.push(g);
    }
    all.sort((a, b) => a - b);
    scale = all.length ? 60 / Math.max(all[Math.floor(all.length * 0.98)], 1e-4) : 1;
  }
  const volOf = (fv: FrameVoice, inst: Inst) => Math.max(0, Math.min(64, Math.round(gainOf(fv, inst) * scale)));
  const noteOf = (inst: Inst, pitch: number): number => {
    const rate = (pitch * SPC_RATE) / 4096;
    return 49 - (inst.sample.rel + inst.sample.fine / 128) + 12 * Math.log2(Math.max(1, rate) / 8363);
  };
  const notes = Array(8).fill(0);
  let outOfRange = 0;
  /** the tracker note of a key-on; counts notes outside the tracker range */
  const keyNote = (inst: Inst, pitch: number): { note: number; exact: number } => {
    let nf = inst.noise ? 49 : noteOf(inst, pitch);
    let note = Math.round(nf);
    if (note < 1 || note > 96) { outOfRange++; note = Math.max(1, Math.min(96, note)); nf = note; }
    return { note, exact: nf };
  };
  const live = (ch: number) => !(ch < 8 && muted(ch));

  // ---- the note grid
  const onsets: number[] = [];
  for (let f = 0; f < frames; f++) for (const [ch, ev] of evByFrame[f]) if (ch < 8 && live(ch) && ev.inst.id) onsets.push(ev.t);
  onsets.sort((a, b) => a - b);
  const grid = findStep(onsets);
  let layout: SpcRows = o.rows ?? 'frame';
  if (layout === 'step' && !grid) { layout = 'frame'; warnings.push('no steady note grid was found (tempo changes or free timing): one row per 50 Hz frame'); }

  let rows: Cell[][] = [];
  let loopRow = -1;
  let speed0 = 1, bpm = 250;
  let usedFrames = frames;
  const newRow = () => Array.from({ length: nch }, emptyCell);

  if (layout === 'frame') {
    // frame f lives in row f + 2; row 0 is one 10 ms tick, row 1 sets speed 2 (its other channels stay empty)
    let last = frames;
    if (loop) {
      const ls = Math.floor(loop.start / SPC_FRAME);
      last = Math.min(frames, ls + Math.max(1, Math.round(loop.len / SPC_FRAME)));
      loopRow = ls + 2;
    }
    usedFrames = last;
    rows = Array.from({ length: last + 2 }, newRow);
    rows[1][0].eff = 0x0f; rows[1][0].par = 2;
    const track = Array.from({ length: nch }, () => ({ inst: null as Inst | null, modelled: 0, active: false, lastVol: -1 }));
    const slide = (c: Cell, t: { modelled: number }, target: number): void => {
      const delta = Math.round((target - t.modelled) * 16);
      if (!delta) return;
      const par = Math.min(255, Math.abs(delta));
      c.eff = delta > 0 ? 1 : 2; c.par = par;
      t.modelled += (Math.sign(delta) * par) / 16;
    };
    for (let f = 0; f < last; f++) {
      const row = rows[f + 2];
      for (let ch = 0; ch < nch; ch++) {
        if (!live(ch)) continue;
        const fv = timeline[f][ch], t = track[ch], c = row[ch];
        const ev = evByFrame[f].get(ch);
        if (ev) { t.inst = ev.inst.id ? ev.inst : null; t.active = true; }
        const inst = t.inst;
        if (!inst || !t.active) continue;
        const vol = volOf(fv, inst);
        if (ev) {
          const k = keyNote(inst, fv.pitch || ev.e.pitch);
          c.note = k.note; c.inst = inst.id; c.vol = 0x10 + vol; t.lastVol = vol; t.modelled = k.note;
          if (ch < 8) notes[ch]++;
          if (!inst.noise) slide(c, t, k.exact);
          continue;
        }
        if (vol === 0) {
          if (t.lastVol !== 0 && fv.env <= 0) { c.note = 97; t.active = false; t.lastVol = 0; } else if (t.lastVol !== 0) { c.vol = 0x10; t.lastVol = 0; }
          continue;
        }
        if (vol !== t.lastVol) { c.vol = 0x10 + vol; t.lastVol = vol; }
        if (!inst.noise) slide(c, t, noteOf(inst, fv.pitch));
      }
    }
  } else {
    // ---- one row per grid step, one tick per 50 Hz frame (125 BPM); module frame m shows timeline frame m - LAG (the
    // same timing as the frame layout)
    const LAG = 2;
    const { T, phase } = grid!;
    const tol = Math.max(160, T * 0.05);
    bpm = 125;
    const startOf = (k: number) => Math.max(0, Math.floor((phase + k * T - tol) / SPC_FRAME) + LAG);
    let kEnd: number, kLoop = -1;
    if (loop) {
      kLoop = Math.max(0, Math.round((loop.start - phase) / T));
      const lr = Math.max(1, Math.round(loop.len / T));
      if (Math.abs(loop.len / T - lr) > 0.1) warnings.push('the loop is not a whole number of grid steps: the loop point is rounded to the nearest row');
      kEnd = kLoop + lr;
      while (kEnd > kLoop + 1 && startOf(kEnd) - LAG > frames) kEnd--;
    } else {
      kEnd = 0;
      while (startOf(kEnd + 1) - LAG <= frames) kEnd++;
    }
    const lead = startOf(0) > 0 ? 1 : 0;
    const starts: number[] = lead ? [0] : [];
    for (let k = 0; k <= kEnd; k++) starts.push(startOf(k));
    const R = starts.length - 1;                       // rows; starts[R] = end frame
    usedFrames = Math.min(frames, starts[R] - LAG);
    if (loop) loopRow = lead + kLoop;
    rows = Array.from({ length: R }, newRow);
    const fvAt = (m: number, ch: number): FrameVoice => (m >= LAG && m - LAG < frames ? timeline[m - LAG][ch] : SILENT);
    // key-ons -> rows (on the grid: no delay; off the grid: EDx)
    const konRow: Map<number, { at: KonAt; f: number; delay: number }>[] = Array.from({ length: R }, () => new Map());
    let merged = 0;
    for (let f = 0; f < Math.min(frames, starts[R] - LAG); f++) {
      for (const [ch, at] of evByFrame[f]) {
        if (!live(ch)) continue;
        const k = Math.floor((at.t - phase + tol) / T);
        const r = k + lead;
        if (r < 0 || r >= R) continue;
        const onGrid = k >= 0 && Math.abs(at.t - (phase + k * T)) <= tol;
        const m = f + LAG;
        const delay = onGrid ? 0 : Math.max(0, Math.min(starts[r + 1] - starts[r] - 1, m - starts[r], 15));
        const prev = konRow[r].get(ch);
        if (prev) { merged++; if (prev.delay <= delay) continue; }
        konRow[r].set(ch, { at, f, delay });
      }
    }
    if (merged) warnings.push(`${merged} notes were closer together than a row and were left out (try "one row per frame")`);
    // ---- the DSP envelope (ADSR / GAIN) of every instrument becomes an XM volume envelope (one point per tick = frame);
    // the volume column then only carries the voice level (VOL L/R), so a row needs no volume changes while a note plays
    const envPeak = new Map<Inst, number>();
    {
      const seqs = new Map<Inst, number[][]>();
      for (let ch = 0; ch < 8; ch++) {
        if (!live(ch)) continue;
        for (let f = 0; f < frames; f++) {
          const ev = evByFrame[f].get(ch);
          if (!ev || !ev.inst.id) continue;
          const seq: number[] = [];
          for (let j = 0; j < 96 && f + j < frames; j++) {
            if (j && (evByFrame[f + j].has(ch) || timeline[f + j][ch].rel)) break;
            const e = timeline[f + j][ch].env / 2047;
            if (j > 1 && e <= 0) break;
            seq.push(e);
          }
          let l = seqs.get(ev.inst);
          if (!l) seqs.set(ev.inst, (l = []));
          l.push(seq);
        }
      }
      for (const [inst, l] of seqs) {
        const curve: number[] = [];
        for (let j = 0; j < 96; j++) {
          const vals = l.filter((q) => q.length > j).map((q) => q[j]).sort((x, y) => x - y);
          if (vals.length < Math.max(1, l.length * 0.2)) break;
          curve.push(vals[vals.length >> 1]);
        }
        const peak = Math.max(...curve, 0);
        if (curve.length < 2 || peak <= 0) continue;
        const ys = curve.map((v) => (v / peak) * 64);
        // fewest points (at most 12) that follow the curve within a tolerance
        let pts: [number, number][] = [];
        for (let tolE = 1; tolE <= 64; tolE *= 1.5) {
          const keep = new Set<number>([0, ys.length - 1]);
          const dp = (i0: number, i1: number) => {
            let worst = -1, wd = tolE;
            for (let i = i0 + 1; i < i1; i++) {
              const y = ys[i0] + ((ys[i1] - ys[i0]) * (i - i0)) / (i1 - i0);
              if (Math.abs(ys[i] - y) > wd) { wd = Math.abs(ys[i] - y); worst = i; }
            }
            if (worst >= 0) { keep.add(worst); dp(i0, worst); dp(worst, i1); }
          };
          dp(0, ys.length - 1);
          pts = [...keep].sort((x, y) => x - y).map((i) => [i, Math.round(ys[i])] as [number, number]);
          if (pts.length <= 12) break;
        }
        if (pts.length > 12) continue;
        const ins = instruments[inst.id]!;
        ins.venv = pts; ins.vflags = 1;
        envPeak.set(inst, peak);
      }
    }
    /** the volume column of a voice: its level only when the instrument carries the envelope */
    const levelOf = (fv: FrameVoice, inst: Inst): number => {
      const pk = envPeak.get(inst);
      if (pk === undefined) return volOf(fv, inst);
      return Math.max(0, Math.min(64, Math.round(gainOf({ ...fv, env: 2047 * pk }, inst) * scale)));
    };
    // shift: frames between the row start and the real key-on of a note snapped to the grid (its frames are read that much later)
    const st = Array.from({ length: nch }, () => ({ inst: null as Inst | null, active: false, note: 0, vol: 0, shift: 0 }));
    const clampV = (v: number) => Math.max(0, Math.min(64, v));
    /** squared error of a volume line (start v0, sl per tick from tick 1 on) against the frame volumes */
    const lineErr = (vs: number[], v0: number, sl: number) => {
      let e = 0, v = v0;
      for (let j = 0; j < vs.length; j++) { if (j) v = clampV(v + sl); e += (v - vs[j]) ** 2; }
      return e;
    };
    /** the best line with a free start, or with the start fixed at `from` */
    const fitLine = (vs: number[], from: number | null, slope: boolean): { v0: number; sl: number; err: number } => {
      const n = vs.length;
      let ls = 0;
      if (slope && n > 1) {
        const mj = (n - 1) / 2, mv = vs.reduce((x, y) => x + y, 0) / n;
        let num = 0, den = 0;
        for (let j = 0; j < n; j++) { num += (j - mj) * (vs[j] - mv); den += (j - mj) ** 2; }
        ls = den ? num / den : 0;
      }
      let best = { v0: 0, sl: 0, err: Infinity };
      const sls = slope ? [Math.floor(ls) - 1, Math.floor(ls), Math.ceil(ls), Math.ceil(ls) + 1, 0] : [0];
      for (const raw of sls) {
        const sl = Math.max(-15, Math.min(15, raw));
        if (from !== null && !sl) continue;          // a fixed start without a slope is "no change": handled by the caller
        let v0 = from ?? 0;
        if (from === null) { let t = 0; for (let j = 0; j < n; j++) t += vs[j] - sl * j; v0 = clampV(Math.round(t / n)); }
        const err = lineErr(vs, v0, sl);
        if (err < best.err) best = { v0, sl, err };
      }
      return best;
    };
    for (let r = 0; r < R; r++) {
      const a = starts[r], b = starts[r + 1], steps = b - a - 1;
      for (let ch = 0; ch < nch; ch++) {
        if (!live(ch)) continue;
        const c = rows[r][ch], s = st[ch];
        const kon = konRow[r].get(ch);
        if (kon) {
          s.inst = kon.at.inst.id ? kon.at.inst : null;
          s.active = !!s.inst;
          if (!s.inst) continue;
          const fv = timeline[kon.f][ch];
          const k = keyNote(s.inst, fv.pitch || kon.at.e.pitch);
          c.note = k.note; c.inst = s.inst.id;
          s.note = k.note;
          s.shift = kon.delay ? 0 : Math.max(0, kon.f + LAG - a);
          if (ch < 8) notes[ch]++;
          if (kon.delay) {
            // a delayed note: one volume for the rest of the row (the volume column is applied on the delayed tick)
            const vs: number[] = [];
            for (let m = a + kon.delay; m < b; m++) vs.push(levelOf(fvAt(m, ch), s.inst));
            const v = clampV(Math.round(vs.reduce((x, y) => x + y, 0) / Math.max(1, vs.length)));
            c.vol = 0x10 + v; s.vol = v;
            c.eff = 0x0e; c.par = 0xd0 | kon.delay;
            continue;
          }
        }
        const inst = s.inst;
        if (!inst || !s.active) continue;
        // the note ends inside this row: key-off at the row start or a note cut on the tick it ends
        const sh = s.shift;
        let end = b;
        if (!kon) for (let m = a; m < b; m++) { const fv = fvAt(m + sh, ch); if (fv.env <= 0 && volOf(fv, inst) === 0) { end = m; break; } }
        // (a key-off would leave an XM envelope running: the end of a note is volume 0)
        if (end === a) { if (s.vol) c.vol = 0x10; s.active = false; s.vol = 0; continue; }
        const vs: number[] = [];
        for (let m = a; m < end; m++) { const fv = fvAt(m + sh, ch); vs.push(volOf(fv, inst) ? levelOf(fv, inst) : 0); }
        // pitch: reach the pitch of the last frame of the row (1xx / 2xx)
        let pitchPar = 0;
        if (!inst.noise && steps > 0 && end === b) {
          const p = fvAt(b - 1 + sh, ch).pitch;
          if (p) {
            const want = noteOf(inst, p) - s.note;
            const per = Math.round((want * 16) / steps);
            if (per && Math.abs(want) >= 0.15) pitchPar = per;
          }
        }
        const effFree = !pitchPar && end === b;
        // volume: set + Axy slide, keep + volume-column slide, or set only; whichever follows the frames best
        const opts: { v0: number; sl: number; err: number; how: 'axy' | 'vslide' | 'set' | 'none' }[] = [];
        if (effFree && steps > 0) opts.push({ ...fitLine(vs, null, true), how: 'axy' });
        if (!kon && steps > 0) opts.push({ ...fitLine(vs, s.vol, true), how: 'vslide' });
        if (!kon) opts.push({ v0: s.vol, sl: 0, err: lineErr(vs, s.vol, 0), how: 'none' });
        opts.push({ ...fitLine(vs, null, false), how: 'set' });
        opts.sort((x, y) => x.err - y.err || (x.how === 'none' ? -1 : 0));
        const o1 = opts[0];
        if (o1.how === 'set' || o1.how === 'axy' || kon) { c.vol = 0x10 + o1.v0; s.vol = o1.v0; }
        if (o1.how === 'vslide') { c.vol = o1.sl < 0 ? 0x60 | -o1.sl : 0x70 | o1.sl; }
        if (o1.how === 'axy') { c.eff = 0x0a; c.par = o1.sl > 0 ? o1.sl << 4 : -o1.sl; }
        if (o1.how === 'axy' || o1.how === 'vslide') s.vol = clampV(s.vol + o1.sl * Math.max(0, vs.length - 1));
        if (end < b) { c.eff = 0x0e; c.par = 0xc0 | Math.min(15, end - a); s.active = false; s.vol = 0; continue; }
        if (pitchPar) {
          const par = Math.min(255, Math.abs(pitchPar));
          c.eff = pitchPar > 0 ? 1 : 2; c.par = par;
          s.note += (Math.sign(pitchPar) * par * steps) / 16;
        }
      }
    }
    // speed of every row = frames to the next grid point
    speed0 = starts[1] - starts[0];
    let cur = speed0;
    for (let r = 0; r < R; r++) {
      const sp = starts[r + 1] - starts[r];
      if (sp === cur && r !== loopRow) continue;
      cur = sp;
      let ch = rows[r].findIndex((c) => !c.eff);
      if (ch < 0) ch = nch - 1;
      rows[r][ch].eff = 0x0f; rows[r][ch].par = Math.max(1, Math.min(31, sp));
    }
  }
  if (outOfRange) warnings.push(`${outOfRange} notes were outside the 8-octave tracker range and were moved to its edge`);

  // ---- patterns: 64 rows each, a new pattern starts at the loop row
  const patterns: Cell[][][] = [];
  const cut = (from: number, to: number) => { for (let r = from; r < to; r += 64) patterns.push(rows.slice(r, Math.min(to, r + 64))); };
  let restart = 0;
  if (loopRow > 0 && loopRow < rows.length) { cut(0, loopRow); restart = patterns.length; cut(loopRow, rows.length); }
  else cut(0, rows.length);
  if (patterns.length > 255) throw new Error('The recording is too long for one module (max 255 patterns): shorten Seconds');

  const echoOn = echoUsed;
  if (echoOn) {
    if (echoVoices.length) warnings.push(`the echo is played as ${echoVoices.length} echo channel${echoVoices.length === 1 ? '' : 's'} (${echoVoices.map((n) => n + 1).join(', ')} → ${echoVoices.map((_, j) => 9 + j).join(', ')}), priority Low: they get the voices the other channels leave free`);
    else if (o.echoNotes === false || o.echo === false) warnings.push('the song uses the SNES echo/reverb; echo channels are off');
    else warnings.push('the song uses the SNES echo/reverb, too quietly to be worth echo channels');
  }
  if (dsp.regs[0x2d]) warnings.push('pitch modulation (PMON) is used: the modulated voice is converted from its plain pitch');
  if (loopOn && !loop) warnings.push(ended ? 'the song ends (no loop)' : `no loop was found in ${MAX_SECONDS / 60} minutes: Seconds sets the length`);

  const prio: Record<number, number> = {};
  echoVoices.forEach((_, j) => { prio[8 + j] = PRIO_LOW; });
  const title = tags.title || tags.game || 'SPC';
  const module: Module = {
    kind: 'spc', title, nch, order: patterns.map((_, i) => i), restart, patterns, instruments, speed: speed0, bpm, amiga: false,
  };
  // the original preview: up to the loop end (it loops back to the loop start)
  const pcmEnd = loop ? Math.min(recorded * SPC_FRAME, loop.start + loop.len) : usedFrames * SPC_FRAME;
  const pcm = pcmAll.slice(0, pcmEnd * 2);
  const voicesUsed = Array.from({ length: 8 }, (_, n) => evByFrame.some((ev) => ev.has(n)));
  const info: SpcInfo = {
    title: tags.title, game: tags.game, artist: tags.artist, dumper: tags.dumper, comment: tags.comment,
    seconds: usedFrames / 50, frames: usedFrames, instruments: kept.length, notes, tagSeconds: tags.seconds, droppedInstruments: dropped, outOfRange, echo: echoOn,
    loop: loop ? { start: loop.start / SPC_RATE, end: (loop.start + loop.len) / SPC_RATE } : null,
    stepMs: grid ? (grid.T / SPC_RATE) * 1000 : null, rows: layout, echoVoices, voicesUsed, warnings,
  };
  return { module, info, pcm, pcmLoop: loop ? loop.start / SPC_RATE : 0, prio };
}
