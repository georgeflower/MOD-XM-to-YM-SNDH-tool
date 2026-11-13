/**
 * SPC (SNES sound) -> tracker module. The SPC file is played in the emulator; for every 50 Hz frame the 8 DSP voices are
 * read (key-on, sample, pitch, envelope, volume). The BRR samples that were keyed on become instruments (decoded to PCM,
 * pitch measured), every voice becomes a channel, and the result is an ordinary module that goes through the normal
 * converter, import dialog, previews and exports.
 *
 * Row timing: one row per 50 Hz frame, speed 2 at 250 BPM (10 ms ticks). The 50 Hz frame snapshots then fall on tick 1 of a
 * row, after that tick's slides, so pitch changes (1xx / 2xx, 1/16 semitone steps, no retrigger) and volume changes
 * (volume column) show up in the same frame.
 */
import type { Cell, Instrument, Module, Sample } from '../core/types';
import { emptyCell } from '../core/types';
import { SpcPlayer, SPC_RATE, type KonEvent } from './spc';

export const SPC_FRAME = SPC_RATE / 50;      // 640 DSP samples per 50 Hz frame

export interface SpcOptions {
  /** where to start / how much to analyse, seconds (default 0 / the song length from the tags, else 120, max 300) */
  startSeconds?: number;
  seconds?: number;
  /** a voice is left out of the module when its number is true (index 0..7) */
  voiceOff?: boolean[];
  /** noise voices (NON) become noise instruments */
  noise?: boolean;
  /** ignore the echo/reverb of the DSP in the "original" rendering */
  echo?: boolean;
}

export interface SpcInfo {
  title: string; game: string; artist: string; dumper: string; comment: string;
  seconds: number; frames: number; instruments: number; notes: number[];
  /** from the file's tags, 0 = unknown */
  tagSeconds: number;
  droppedInstruments: number;
  outOfRange: number;
  echo: boolean;
  warnings: string[];
}

export interface SpcResult {
  module: Module;
  info: SpcInfo;
  /** the song as the SNES plays it, 32 kHz stereo (interleaved), for the "original" preview */
  pcm: Int16Array;
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

const MIDDLE_C_PERIOD = 8363 / 261.6256;     // samples per cycle of an XM sample tuned to C-4

interface Inst { id: number; key: string; srcn: number; addr: number; sample: Sample; noise: boolean; uses: number; pitched: boolean; pitches: number[] }

/** 8-voice frame state collected from the emulator */
interface FrameVoice { kon: KonEvent | null; env: number; volL: number; volR: number; pitch: number; noise: boolean }

export function spcToModule(file: Uint8Array, o: SpcOptions = {}): SpcResult {
  const player = new SpcPlayer(file);
  const tags = player.tags;
  const warnings: string[] = [];
  const dsp = player.dsp;
  const ram = player.ram;
  const startS = Math.max(0, o.startSeconds ?? 0);
  const total = Math.min(300, Math.max(1, o.seconds ?? (tags.seconds ? Math.min(tags.seconds, 240) : 120)));
  const frames = Math.floor(total * 50);
  const skipFrames = Math.floor(startS * 50);
  if (o.echo === false) dsp.regs[0x2c] = dsp.regs[0x3c] = 0;
  const pcm = new Int16Array(frames * SPC_FRAME * 2);

  // skip ahead (no output kept)
  for (let f = 0; f < skipFrames; f++) player.run(SPC_FRAME);

  const insts = new Map<string, Inst>();
  const noiseInst: { v: Inst | null } = { v: null };
  const list: Inst[] = [];
  const timeline: FrameVoice[][] = [];
  const konLog: KonEvent[] = [];
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

  const voiceInst: (Inst | null)[] = Array(8).fill(null);
  const voiceNoise: boolean[] = Array(8).fill(false);
  const evByFrame: (Map<number, { e: KonEvent; inst: Inst }> )[] = [];

  for (let f = 0; f < frames; f++) {
    for (const v of dsp.voices) v.envSum = 0;
    konLog.length = 0;
    // a note started during the frame: read the instrument right away (before the driver changes things)
    player.run(SPC_FRAME, pcm, f * SPC_FRAME * 2);
    const row: FrameVoice[] = [];
    const evs = new Map<number, { e: KonEvent; inst: Inst }>();
    for (const e of konLog) {
      const isNoise = !!(dsp.regs[0x3d] & (1 << e.voice)) && o.noise !== false;
      evs.set(e.voice, { e, inst: instOf(e, isNoise) });
    }
    evByFrame.push(evs);
    for (let n = 0; n < 8; n++) {
      const v = dsp.voices[n], b = n * 16;
      row.push({
        kon: evs.get(n)?.e ?? null,
        env: v.envSum / SPC_FRAME,
        volL: (dsp.regs[b] << 24) >> 24, volR: (dsp.regs[b + 1] << 24) >> 24,
        pitch: dsp.regs[b + 2] | ((dsp.regs[b + 3] & 0x3f) << 8),
        noise: !!(dsp.regs[0x3d] & (1 << n)),
      });
    }
    timeline.push(row);
  }
  dsp.onKon = null;

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

  // ---- loudness scale: the 98th percentile of the channel gains becomes volume 60
  const mv = (Math.abs((dsp.regs[0x0c] << 24) >> 24) + Math.abs((dsp.regs[0x1c] << 24) >> 24)) / 254 || 1;
  const gainOf = (fv: FrameVoice, inst: Inst | null): number => {
    const pk = inst && !inst.noise ? (inst.sample as Sample & { peak?: number }).peak ?? 1 : 0.5;
    return (fv.env / 2047) * ((Math.abs(fv.volL) + Math.abs(fv.volR)) / 254) * Math.min(1, pk) * mv;
  };
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
    (gainOf as unknown as { scale: number }).scale = all.length ? 60 / Math.max(all[Math.floor(all.length * 0.98)], 1e-4) : 1;
  }
  const scale = (gainOf as unknown as { scale: number }).scale;

  // ---- pattern data
  const ROWS = 64;
  const nrows = frames + 2;
  const npat = Math.ceil(nrows / ROWS);
  if (npat > 255) throw new Error('The recording is too long for one module (max 255 patterns): shorten Seconds');
  const patterns: Cell[][][] = [];
  for (let p = 0; p < npat; p++) patterns.push(Array.from({ length: ROWS }, () => Array.from({ length: 8 }, emptyCell)));
  const cell = (row: number, ch: number): Cell => patterns[Math.floor(row / ROWS)][row % ROWS][ch];
  cell(1, 0).eff = 0x0f; cell(1, 0).par = 2;                 // speed 2 from row 1 on (row 0 is one 10 ms tick: frame snapshots land on tick 1)
  // channel 0 effect slot at row 1 is taken by F02, so pitch work for that row starts at row 2 (frame f lives in row f + 2)

  const noteOf = (inst: Inst, pitch: number): number => {
    const rate = (pitch * SPC_RATE) / 4096;
    return 49 - (inst.sample.rel + inst.sample.fine / 128) + 12 * Math.log2(Math.max(1, rate) / 8363);
  };
  const track: { inst: Inst | null; modelled: number; active: boolean; lastVol: number }[] = Array.from({ length: 8 }, () => ({ inst: null, modelled: 0, active: false, lastVol: -1 }));
  const notes = Array(8).fill(0);
  let outOfRange = 0;
  for (let f = 0; f < frames; f++) {
    const row = f + 2;
    for (let n = 0; n < 8; n++) {
      if (o.voiceOff?.[n]) continue;
      const fv = timeline[f][n], t = track[n], c = cell(row, n);
      const ev = evByFrame[f].get(n);
      if (ev) { t.inst = ev.inst.id ? ev.inst : null; t.active = true; }
      const inst = t.inst;
      if (!inst || !t.active) continue;
      const vol = Math.max(0, Math.min(64, Math.round(gainOf(fv, inst) * scale)));
      if (ev) {
        let nf = inst.noise ? 49 : noteOf(inst, fv.pitch || ev.e.pitch);
        let note = Math.round(nf);
        if (note < 1 || note > 96) { outOfRange++; note = Math.max(1, Math.min(96, note)); nf = note; }
        c.note = note; c.inst = inst.id; c.vol = 0x10 + vol; t.lastVol = vol; t.modelled = note;
        notes[n]++;
        if (!inst.noise) slide(c, t, nf);
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
  function slide(c: Cell, t: { modelled: number }, target: number): void {
    const delta = Math.round((target - t.modelled) * 16);
    if (!delta) return;
    const par = Math.min(255, Math.abs(delta));
    c.eff = delta > 0 ? 1 : 2; c.par = par;
    t.modelled += Math.sign(delta) * par / 16;
  }
  if (outOfRange) warnings.push(`${outOfRange} notes were outside the 8-octave tracker range and were moved to its edge`);

  const echoOn = !(dsp.regs[0x6c] & 0x20) && !!((dsp.regs[0x2c] || dsp.regs[0x3c]) && dsp.regs[0x4d]);
  if (echoOn) warnings.push('the song uses the SNES echo/reverb (EON voices): it is part of the original preview but not of the YM version');
  if (dsp.regs[0x2d]) warnings.push('pitch modulation (PMON) is used: the modulated voice is converted from its plain pitch');

  const order = Array.from({ length: npat }, (_, i) => i);
  const title = tags.title || tags.game || 'SPC';
  const module: Module = {
    kind: 'spc', title, nch: 8, order, restart: 0, patterns, instruments, speed: 1, bpm: 250, amiga: false,
  };
  const info: SpcInfo = {
    title: tags.title, game: tags.game, artist: tags.artist, dumper: tags.dumper, comment: tags.comment,
    seconds: frames / 50, frames, instruments: kept.length, notes, tagSeconds: tags.seconds, droppedInstruments: dropped, outOfRange, echo: echoOn, warnings,
  };
  return { module, info, pcm };
}
