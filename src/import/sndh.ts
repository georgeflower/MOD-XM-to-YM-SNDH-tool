// SNDH importer: run the tune's 68000 code in an emulator and record the YM2149 registers once per 50 Hz frame.
//
// The play routine is called once per frame and the registers it leaves behind are the music.  MFP timer interrupts
// that the tune sets up (digidrums, SID voice, sinus-SID, sync-buzzer) are run too, in virtual time, and every YM write
// they make is logged with a timestamp; sndhfx.ts turns that log into digidrum samples and timer effects.
import { M68k, type Bus, RAM_SIZE } from './m68k';
import { Mfp, MFP_FRAME } from './mfp';
import { extractTimerEffects } from './sndhfx';
import { iceDepack, isIce } from './ice';
import type { AyTune } from './tune';
import type { DrumTrack } from '../core/drums';
import { dmaToDrums, dmaReport, type DmaResult } from './dma';
import type { FxTrack } from '../core/fx';

const BASE = 0x10000;
const RET = 0x400;
const STACK = 0x3f0000;
const ISR_STACK = 0x3e0000;
const MAX_ISR_PER_FRAME = 4000;
const MAX_LOG = 3_000_000;

export interface SndhInfo {
  title: string; author: string; ripper: string; converter: string; year: string;
  subtunes: number;
  subtuneNames: string[];
  durations: number[];       // seconds per subtune from the TIME tag (0 = unknown)
  rateHz: number;            // call rate of the play routine
  timer: 'vbl' | 'A' | 'B' | 'C' | 'D';
  flags: string;
  /** STe DMA sound: distinct samples and hits found while running the tune */
  dmaSamples?: number; dmaHits?: number;
}

export function isSndh(d: Uint8Array): boolean {
  if (isIce(d)) return true;
  return d.length > 16 && String.fromCharCode(d[12], d[13], d[14], d[15]) === 'SNDH';
}

const str = (d: Uint8Array, p: number, n: number) => String.fromCharCode(...d.subarray(p, p + n));
function cstr(d: Uint8Array, p: number): [string, number] {
  let e = p;
  while (e < d.length && d[e] !== 0) e++;
  return [str(d, p, e - p), e + 1];
}

export function parseSndhHeader(d: Uint8Array): SndhInfo {
  const info: SndhInfo = { title: '', author: '', ripper: '', converter: '', year: '', subtunes: 1, subtuneNames: [], durations: [], rateHz: 50, timer: 'vbl', flags: '' };
  let p = 16;
  const skipNul = () => { while (p < d.length && d[p] === 0) p++; };
  for (let guard = 0; guard < 200 && p + 4 <= d.length; guard++) {
    const t4 = str(d, p, 4), t2 = str(d, p, 2);
    if (t4 === 'HDNS') break;
    if (t4 === 'TITL' || t4 === 'COMM' || t4 === 'RIPP' || t4 === 'CONV' || t4 === 'YEAR' || t4 === 'FLAG') {
      let s: string; [s, p] = cstr(d, p + 4); skipNul();
      if (t4 === 'TITL') info.title = s; else if (t4 === 'COMM') info.author = s; else if (t4 === 'RIPP') info.ripper = s;
      else if (t4 === 'CONV') info.converter = s; else if (t4 === 'YEAR') info.year = s; else info.flags = s;
    } else if (t4 === 'TIME') {
      p += 4;
      for (let i = 0; i < Math.max(1, info.subtunes); i++, p += 2) info.durations.push((d[p] << 8) | d[p + 1]);
    } else if (t4 === '!#SN') {
      const start = p; p += 4;
      const names: string[] = [];
      let last = p;
      for (let i = 0; i < info.subtunes; i++, p += 2) {
        const off = (d[p] << 8) | d[p + 1];
        const [s, e] = cstr(d, start + off); names.push(s); last = Math.max(last, e);
      }
      info.subtuneNames = names; p = Math.max(p, last); skipNul();
    } else if (t2 === '##') {
      const n = parseInt(str(d, p + 2, 2), 10); if (n > 0) info.subtunes = n;
      p += 4; skipNul();
    } else if (t2 === '!V' || t2 === 'TA' || t2 === 'TB' || t2 === 'TC' || t2 === 'TD') {
      let s: string; [s, p] = cstr(d, p + 2); skipNul();
      const hz = parseInt(s, 10);
      if (hz > 0) info.rateHz = hz;
      info.timer = t2 === '!V' ? 'vbl' : (t2[1] as 'A');
    } else if (t2 === '**') { let s: string; [s, p] = cstr(d, p + 2); void s; skipNul(); }
    else break;
  }
  return info;
}

/** one write to the STe DMA sound control register ($FF8901) */
export interface DmaEvent {
  frame: number;
  play: boolean;
  /** frame base / end addresses as programmed, sample mode byte ($FF8921: bits 0-1 rate, bit 7 mono) */
  start: number; end: number; mode: number;
  loop: boolean;
}
const MAX_DMA_EVENTS = 20_000;

class YmBus implements Bus {
  regs = new Uint8Array(16);
  /** frame the play routine is running for (to date the DMA events) */
  frame = 0;
  dma: DmaEvent[] = [];
  sel = 0;
  envWritten = false;
  io = new Uint8Array(0x8000);          // plain backing store for the rest of the I/O page
  mfpTimerTouched = false;
  mfp = new Mfp();
  /** true while a timer interrupt handler runs: its YM data writes go to the log instead of the base image */
  isr = false;
  /** optional trace of every YM data write outside timer interrupts (register, value as written, instruction count) */
  trace: { r: number; v: number; i: number }[] | null = null;
  clock: () => number = () => 0;
  logT: number[] = []; logR: number[] = []; logV: number[] = [];
  logFull = false;
  /** STe microwire: after a data write the mask register reads "shifting" for a few polls, then the original mask again */
  mwBusy = 0;
  ioRead(addr: number, size: number): number {
    if (addr === 0xff8924 && size === 1 && this.mwBusy > 0) { this.mwBusy--; return 0; }
    let v = 0;
    for (let i = 0; i <= (size === 2 ? 3 : size === 1 ? 1 : 0); i++) v = (v * 256) + this.rb(addr + i);
    return v;
  }
  private rb(a: number): number {
    if (a >= 0xff8800 && a < 0xff8900) { const k = a & 3; return k === 0 || k === 2 ? this.regs[this.sel] : 0xff; }
    if (a >= 0xfffa00 && a < 0xfffa40) return this.mfp.read(a);
    return this.io[a - 0xff8000];
  }
  ioWrite(addr: number, size: number, value: number) {
    const n = size === 2 ? 4 : size === 1 ? 2 : 1;
    for (let i = 0; i < n; i++) this.wb(addr + i, (value >>> (8 * (n - 1 - i))) & 0xff);
  }
  private wb(a: number, v: number) {
    if (a >= 0xff8800 && a < 0xff8900) {
      const k = a & 3;
      if (k === 0) this.sel = v & 15;
      else if (k === 2) {
        const r = this.sel;
        if (this.trace && !this.isr) this.trace.push({ r, v, i: this.clock() });
        if (r < 14) {
          const m = [255, 15, 255, 15, 255, 15, 31, 255, 31, 31, 31, 255, 255, 15][r];
          this.regs[r] = v & m;
          if (this.isr) {
            if (this.logT.length < MAX_LOG) { this.logT.push(this.mfp.now); this.logR.push(r); this.logV.push(v & m); } else this.logFull = true;
          } else if (r === 13) this.envWritten = true;
        }
      }
      return;
    }
    if (a >= 0xfffa19 && a <= 0xfffa25 && v !== 0) this.mfpTimerTouched = true; // timer control/data regs
    if (a >= 0xfffa00 && a < 0xfffa40) { this.mfp.write(a, v); return; }
    this.io[a - 0xff8000] = v;
    if (a === 0xff8922 || a === 0xff8923) this.mwBusy = 3;
    if (a === 0xff8901 && this.dma.length < MAX_DMA_EVENTS) {
      const g = (o: number) => this.io[o - 0xff8000];
      this.dma.push({
        frame: this.frame, play: (v & 1) !== 0, loop: (v & 2) !== 0,
        start: (g(0xff8903) << 16) | (g(0xff8905) << 8) | g(0xff8907),
        end: (g(0xff890f) << 16) | (g(0xff8911) << 8) | g(0xff8913),
        mode: g(0xff8921),
      });
    }
  }
}

/**
 * A cookie jar at $5A0 that says "STe": SNDH players look for _MCH / _SND before they start the DMA sound chip
 * (maxYMiser's does, and plays its sample track only on an STe). _MCH 1.0 = STe, _SND 3 = YM2149 + 8-bit DMA.
 */
const JAR = 0x600;
function installCookies(cpu: M68k) {
  const cookies: [string, number][] = [['_CPU', 0], ['_VDO', 0x00010000], ['_MCH', 0x00010000], ['_SND', 3], ['_FRB', 0]];
  let p = JAR;
  for (const [id, v] of cookies) {
    for (let i = 0; i < 4; i++) cpu.mem[p + i] = id.charCodeAt(i);
    cpu.wr32(p + 4, v); p += 8;
  }
  cpu.wr32(p, 0); cpu.wr32(p + 4, cookies.length + 1);
  cpu.wr32(0x5a0, JAR);
}

/**
 * GEMDOS memory calls (TRAP #1): Malloc $48, Mxalloc $44, Mfree $49. Players such as maxYMiser's allocate a buffer for
 * their samples at init; without an answer d0 keeps the subtune number and the player copies over low memory.
 */
const HEAP_START = 0x320000, HEAP_END = 0x3d0000;
function installGemdos(cpu: M68k) {
  let heap = HEAP_START;
  cpu.onTrap = (n) => {
    if (n !== 1) return;
    const sp = cpu.a[7] >>> 0, fn = cpu.rd16(sp);
    if (fn === 0x48 || fn === 0x44) {
      const size = cpu.rd32(sp + 2) | 0;
      if (size === -1) { cpu.d[0] = HEAP_END - heap; return; }
      const sz = (Math.max(0, size) + 3) & ~3;
      if (size < 0 || heap + sz > HEAP_END) { cpu.d[0] = 0; return; }
      cpu.d[0] = heap; heap += sz;
    } else if (fn === 0x49) cpu.d[0] = 0;
  };
}

export interface SndhOptions {
  subtune?: number;          // 1-based
  seconds?: number;          // override the rendered length
  maxInstructions?: number;
  /** turn STe DMA samples into digidrum hits (default true); false leaves them out */
  dma?: boolean;
  /** collect every YM data write made by the play routine, in order (tests) */
  trace?: { r: number; v: number; i: number }[];
}

export function parseSndh(file: Uint8Array, opt: SndhOptions = {}): AyTune & { info: SndhInfo } {
  const d = isIce(file) ? iceDepack(file) : file;
  if (!isSndh(d)) throw new Error('Not an SNDH file');
  const info = parseSndhHeader(d);
  const warnings: string[] = [];
  const sub = Math.min(Math.max(1, opt.subtune ?? 1), info.subtunes);
  if (isIce(file)) warnings.push('ICE-packed file unpacked');

  const bus = new YmBus();
  const cpu = new M68k(bus);
  if (opt.trace) { bus.trace = opt.trace; bus.clock = () => cpu.instructions; }
  cpu.mem.set(d.subarray(0, Math.min(d.length, 0x300000)), BASE);
  let budgetLeft = opt.maxInstructions ?? 600_000_000;

  const call = (offset: number, d0: number, budget: number): boolean => {
    cpu.a[7] = STACK - 4; cpu.wr32(STACK - 4, RET);
    cpu.d[0] = d0;
    cpu.pc = BASE + offset;
    const before = cpu.instructions;
    const ok = cpu.run(RET, budget);
    budgetLeft -= cpu.instructions - before;
    return ok;
  };

  bus.regs[7] = 0xff;
  installCookies(cpu);
  installGemdos(cpu);
  if (info.timer !== 'vbl') bus.mfp.disabled['ABCD'.indexOf(info.timer)] = true;   // the host's own timer, not the tune's
  try {
    if (!call(0, sub, 5_000_000)) warnings.push(`init routine did not return (waiting for hardware? stuck at offset $${(cpu.pc - BASE).toString(16)})`);
  } catch (e) { throw new Error(`SNDH init crashed: ${(e as Error).message}`); }

  const dur = opt.seconds ?? (info.durations[sub - 1] || 0);
  const seconds = dur > 0 ? dur : 180;
  if (!(dur > 0)) warnings.push('no TIME tag: rendering 180 s');
  const nframes = Math.max(1, Math.round(seconds * 50));
  const perFrame = info.rateHz / 50;
  if (info.rateHz !== 50) warnings.push(`player runs at ${info.rateHz} Hz; frames sampled at 50 Hz`);

  // ---- timer interrupts: run the tune's handler to completion at the moment the timer underflows
  let isrRuns = 0, isrSkipped = 0, isrHung = 0, isrFloods = 0;
  const runIsr = (i: number) => {
    const entry = cpu.rd32(bus.mfp.vectorAddr(i));
    if (entry < 0x400 || entry >= RAM_SIZE) { isrSkipped++; return; }
    const sd = Int32Array.from(cpu.d), sa = Int32Array.from(cpu.a), spc = cpu.pc, ssr = cpu.sr;
    cpu.a[7] = ISR_STACK - 6;
    cpu.wr16(cpu.a[7], ssr); cpu.wr32(cpu.a[7] + 2, RET);
    cpu.pc = entry;
    bus.isr = true;
    const before = cpu.instructions;
    let ok = false;
    try { ok = cpu.run(RET, 20_000); } finally { bus.isr = false; }
    budgetLeft -= cpu.instructions - before;
    if (!ok) isrHung++;
    cpu.d.set(sd); cpu.a.set(sa); cpu.pc = spc; cpu.sr = ssr;
    isrRuns++;
  };
  const runTimers = (until: number) => {
    let n = 0;
    for (;;) {
      const i = bus.mfp.earliest(until);
      if (i < 0) break;
      const t = bus.mfp.next[i];
      const per = bus.mfp.period(i);
      bus.mfp.advance(i);
      if (per < 100 || n >= MAX_ISR_PER_FRAME) { if (n === MAX_ISR_PER_FRAME) { isrFloods++; n++; } continue; }
      if (!bus.mfp.enabled(i)) continue;
      bus.mfp.now = t;
      runIsr(i);
      n++;
    }
  };

  const regs = new Uint8Array(nframes * 14);
  let acc = 0, hung = 0, f = 0;
  try {
    for (; f < nframes; f++) {
      acc += perFrame;
      let calls = Math.floor(acc + 1e-9); acc -= calls;
      bus.envWritten = false;
      bus.frame = f;
      bus.mfp.now = f * MFP_FRAME;
      let envShape = 0xff;
      while (calls-- > 0) {
        if (!call(8, 0, 3_000_000)) hung++;
        if (bus.envWritten) { envShape = bus.regs[13]; bus.envWritten = false; }
      }
      const o = regs.subarray(f * 14, f * 14 + 14);
      o.set(bus.regs.subarray(0, 13));
      o[7] |= 0xc0;
      o[13] = envShape;
      if (bus.mfp.mode.some((m) => m)) {
        const base = bus.regs.slice();
        runTimers((f + 1) * MFP_FRAME);
        bus.regs.set(base);                              // the handlers' writes live in the log, not in the music
      }
      if (budgetLeft <= 0) { warnings.push(`stopped after ${(f / 50).toFixed(1)} s: the tune needs too much emulation time`); f++; break; }
    }
  } catch (e) {
    warnings.push(`playback stopped after ${(f / 50).toFixed(1)} s: ${(e as Error).message}`);
  }
  const got = Math.max(1, f);
  if (hung) warnings.push(`${hung} play call(s) did not return`);
  if (isrHung) warnings.push(`${isrHung} timer interrupt handler run(s) did not return`);
  if (isrSkipped) warnings.push(`${isrSkipped} timer interrupt(s) had no handler installed`);
  if (isrFloods) warnings.push(`${isrFloods} frame(s) with more than ${MAX_ISR_PER_FRAME} timer interrupts: the rest were skipped`);
  if (bus.logFull) warnings.push('timer interrupt log full: the rest of the tune is not analysed');

  let out = regs.slice(0, got * 14);
  let drums: DrumTrack | undefined, fx: FxTrack | undefined;
  if (bus.logT.length) {
    const x = extractTimerEffects(out, got, { t: bus.logT, reg: bus.logR, val: bus.logV });
    drums = x.drums; fx = x.fx; warnings.push(...x.warnings);
  } else if (bus.mfpTimerTouched) {
    warnings.push('this tune programs MFP timers, but no timer interrupt reached a handler that writes the YM');
  }
  let dmaRes: DmaResult | undefined;
  const dmaStarts = bus.dma.filter((e) => e.play).length;
  if (dmaStarts) {
    if (opt.dma !== false) {
      dmaRes = dmaToDrums(bus.dma, cpu.mem, out, got, drums);
      if (dmaRes.track) drums = dmaRes.track;
      warnings.push(...dmaRes.warnings);
    }
  }
  const { nframes: n2, loopFrame } = detectLoop(out, got, drums?.trig, fx);
  out = out.slice(0, n2 * 14);
  if (drums) drums = { drums: drums.drums, trig: drums.trig.slice(0, n2) };
  if (dmaStarts && !dmaRes?.track) {
    info.dmaHits = bus.dma.filter((e) => e.play && e.frame < n2).length;
    if (opt.dma === false) warnings.push(`STe DMA sound: ${info.dmaHits} sample start(s) left out`);
  }
  if (dmaRes?.track && drums) {
    warnings.push(dmaReport(dmaRes, drums, n2));
    const used = new Set<number>(); let hits = 0;
    drums.trig.forEach((t) => { const i = t & 63; if (t && i !== 63 && i >= dmaRes!.first) { hits++; used.add(i); } });
    info.dmaSamples = used.size; info.dmaHits = hits;
  }
  if (fx) fx = fx.slice(0, n2);
  return {
    title: info.title, author: info.author, comment: [info.converter, info.ripper].filter(Boolean).join(' / '),
    regs: out, nframes: n2, loopFrame, source: 'sndh', warnings, info, drums, fx,
  };
}

/** If the rendered music repeats (TIME longer than one pass), cut it to one pass and return the loop frame. */
export function detectLoop(regs: Uint8Array, n: number, trig?: Uint8Array, fx?: Uint32Array): { nframes: number; loopFrame: number } {
  const eq = (a: number, b: number) => {
    if ((trig && trig[a] !== trig[b]) || (fx && fx[a] !== fx[b])) return false;
    for (let k = 0; k < 14; k++) if (regs[a * 14 + k] !== regs[b * 14 + k]) return false;
    return true;
  };
  const tail = Math.min(300, Math.floor(n / 3));
  if (tail < 50) return { nframes: n, loopFrame: 0 };
  // a tail that is just silence / a held chord would "repeat" with any period: require some activity
  let changes = 0;
  for (let i = 1; i < tail; i++) if (!eq(n - i, n - i - 1)) changes++;
  if (changes < 6) return { nframes: n, loopFrame: 0 };
  for (let P = 25; P <= n / 2; P++) {
    let ok = true;
    for (let i = 1; i <= tail; i++) if (!eq(n - i, n - i - P)) { ok = false; break; }
    if (!ok) continue;
    // extend backwards to find where the periodic part starts
    let s = n - P;
    while (s > 0 && eq(s - 1, s - 1 + P)) s--;
    if (n - s >= 2 * P) return { nframes: s + P, loopFrame: s };
  }
  return { nframes: n, loopFrame: 0 };
}
