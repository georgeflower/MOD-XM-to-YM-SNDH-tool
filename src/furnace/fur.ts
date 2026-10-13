/**
 * Furnace Tracker export (.fur): the AY pattern editor's song as one subsong on one AY-3-8910 chip (YM2149, 2 MHz), 3 channels.
 *
 * The file is written in Furnace's classic layout (format version 228, "Furnace 0.6.8.1"): INFO + FLAG + ADIR + INS2 + PATN
 * blocks, uncompressed (Furnace reads both). Every later Furnace reads this layout too.
 *
 * Instruments are baked into Furnace macros (see export/bake.ts): volume (with the release tail as the macro's release part),
 * wave (bit 0 tone, bit 1 noise, bit 2 envelope), duty (= 31 - noise period), arpeggio, pitch, and for buzzers the AY
 * envelope shape (ex2) plus the auto-envelope ratio (ex3 / alg) that makes the envelope follow the note.
 *
 * Furnace facts used (from its source, ay.cpp / macroInt.cpp / fur.cpp): note C-0 is 60 (editor note n = Furnace n + 59);
 * volume is subtractive (outVol = macro - (15 - channel volume)); the pitch macro subtracts from the register period in
 * non-linear mode, which is how this file is flagged (so slides and the pitch macro are in register period units, as in the
 * editor); auto-envelope period = (period * den / num) >> 4; macro release continues a macro after its release index.
 */
import {
  type Song, type Cell, type Instrument, NOTE_OFF, VOICES, channelsOf, EFFECT_LETTERS, noteToFreq,
} from '../tracker/types';
import { bakeInstrument, clamp, logVol, type Tk } from './../export/bake';

export interface FurOptions { title?: string; author?: string; comment?: string }
export interface FurResult { bytes: Uint8Array; warnings: string[]; stats: { orders: number; patterns: number; instruments: number; rows: number } }

const FORMAT_VERSION = 228;
const MAX_MACRO = 255;
const NOTE_BASE = 59;            // editor note n sounds as Furnace note n + 59 (C-0 = 60)
const FUR_NOTE_OFF = 180, FUR_NOTE_REL = 181;
const MAC = { vol: 0, arp: 1, duty: 2, wave: 3, pitch: 4, ex2: 6, ex3: 7, alg: 8, phase: 14, ex5: 16 } as const;

// ------------------------------------------------------------------------------------------------ byte writer

class W {
  b: number[] = [];
  get length() { return this.b.length; }
  u8(v: number) { this.b.push(v & 255); return this; }
  u16(v: number) { this.b.push(v & 255, (v >> 8) & 255); return this; }
  u32(v: number) { this.b.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); return this; }
  f32(v: number) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); for (let i = 0; i < 4; i++) this.b.push(d.getUint8(i)); return this; }
  str(s: string) { for (const c of new TextEncoder().encode(s)) this.b.push(c); this.b.push(0); return this; }
  tag(s: string) { for (let i = 0; i < s.length; i++) this.b.push(s.charCodeAt(i)); return this; }
  bytes(a: ArrayLike<number>) { for (let i = 0; i < a.length; i++) this.b.push(a[i] & 255); return this; }
  fill(v: number, n: number) { for (let i = 0; i < n; i++) this.b.push(v & 255); return this; }
  /** a block: 4-byte id, 4-byte size, payload */
  static block(id: string, payload: W | number[]): number[] {
    const p = payload instanceof W ? payload.b : payload;
    const w = new W().tag(id).u32(p.length);
    return w.b.concat(p);
  }
}

// ------------------------------------------------------------------------------------------------ instruments

interface Macro { code: number; vals: number[]; loop: number; rel: number; instant: boolean }
interface FInst {
  name: string; macros: Macro[]; hasTail: boolean;
  /** baked ticks (as the macros were built from them) and the tick the cycle repeats from */
  ticks: Tk[]; loopStart: number;
  /** the instrument has fractional semitones (step tables): one copy per played note carries the period correction */
  frac: boolean;
  /** copies made for notes, with the pitch macro each carries */
  variants: { inst: FInst; pitch: number[] }[];
  /** position in the file's instrument list (-1 = not used yet) */
  index: number;
}

/** a macro from per-tick values: `loopStart` < 0 holds the last value, otherwise the part from loopStart repeats */
function seqMacro(code: number, vals: number[], loopStart: number): Macro {
  let v = vals.slice();
  let loop = 255;
  if (loopStart >= 0 && loopStart < v.length) {
    // shrink the repeating part to its shortest period
    const reg = v.slice(loopStart);
    let q = reg.length;
    for (let p = 1; p < reg.length; p++) {
      if (reg.length % p) continue;
      let ok = true;
      for (let i = p; i < reg.length && ok; i++) if (reg[i] !== reg[i - p]) ok = false;
      if (ok) { q = p; break; }
    }
    v = v.slice(0, loopStart + q);
    if (q === 1) {                    // a held value: no loop needed, and merge it into the run before it
      while (loopStart > 0 && v[loopStart - 1] === v[loopStart]) { v.pop(); loopStart--; }
      loop = 255;
    } else loop = loopStart;
  } else {
    while (v.length > 1 && v[v.length - 1] === v[v.length - 2]) v.pop();
  }
  return { code, vals: v, loop, rel: 255, instant: false };
}

function compileInstrument(inst: Instrument, index: number, warn: (k: string, m: string) => void, rowTicks: number): FInst {
  const label = `instrument ${index.toString(16).toUpperCase().padStart(2, '0')} "${inst.name}"`;
  const baked = bakeInstrument(inst, label, warn, MAX_MACRO - 1, 'Furnace', 'register period units', false, rowTicks);
  const hard = baked.hard;
  let ticks: Tk[] = baked.ticks.length ? baked.ticks.slice() : [{ vol: 0, noise: 0, tone: false, semi: 0, frac: 0, pitch: 0 }];
  let loopStart = baked.loopStart;
  // a one-shot step table is silent after its last step
  if (!baked.looping) {
    const last = ticks[ticks.length - 1];
    if (last.vol > 0 && ticks.length < MAX_MACRO) ticks.push({ ...last, vol: 0 });
    loopStart = -1;
  }
  if (inst.syncSquare) warn('syncsq:' + label, `${label}: sync-square is left out (Furnace's AY has no equivalent)`);

  const noiseUsed = ticks.some((t) => t.noise > 0);
  const macros: Macro[] = [];

  // volume + release tail
  const volVals = ticks.map((t) => (t.vol > 0 && (hard || t.tone || t.noise) ? t.vol : 0));
  const vol = seqMacro(MAC.vol, volVals, loopStart);
  const tail = baked.release;
  if (tail.length) {
    // the tail follows the macro's release index; the held value sits at that index
    if (vol.loop !== 255 && vol.vals.length - 1 <= vol.loop) vol.loop = 255;
    vol.rel = vol.vals.length - 1;
    // after the release Furnace plays the held value once more before the tail, so the tail starts one step in: from the
    // second tick on it lines up with the editor's
    const t2 = (tail.length > 1 ? tail.slice(1) : tail).map((v) => (hard ? (v > 0 ? 15 : 0) : v));
    vol.vals.push(...t2.slice(0, MAX_MACRO - vol.vals.length));
    vol.instant = true;
  }
  macros.push(vol);

  // wave: tone / noise / envelope bits
  const waveVals = ticks.map((t, i) => {
    const on = volVals[i] > 0;
    if (hard && !t.plain) return on ? ((t.tone ? 1 : 0) | (t.noise ? 2 : 0) | 4) : 0;
    return (t.tone ? 1 : 0) | (t.noise ? 2 : 0);
  });
  const wave = seqMacro(MAC.wave, waveVals, loopStart);
  if (tail.length && hard) {
    // a buzzer keeps its envelope bit until the wave macro drops it, so the wave macro follows the tail
    const last = wave.vals[wave.vals.length - 1];
    if (wave.loop !== 255 && wave.vals.length - 1 <= wave.loop) wave.loop = 255;
    wave.rel = wave.vals.length - 1; wave.instant = true;
    wave.vals.push(...vol.vals.slice(vol.rel + 1).map((v) => (v > 0 ? last : 0)));
  }
  macros.push(wave);

  if (noiseUsed) {
    let prev = 16;
    const duty = ticks.map((t) => { if (t.noise > 0) prev = t.noise; return 31 - clamp(prev, 1, 31); });
    macros.push(seqMacro(MAC.duty, duty, loopStart));
  }
  if (ticks.some((t) => t.semi !== 0)) macros.push(seqMacro(MAC.arp, ticks.map((t) => t.semi), loopStart));
  if (ticks.some((t) => t.pitch !== 0)) macros.push(seqMacro(MAC.pitch, ticks.map((t) => -Math.round(t.pitch)), loopStart));          // Furnace subtracts the pitch from the period; the editor adds it

  if (hard) {
    macros.push({ code: MAC.phase, vals: [1], loop: 255, rel: 255, instant: false });
    macros.push({ code: MAC.ex2, vals: [inst.hardEnvShape & 15], loop: 255, rel: 255, instant: false });
    if (!inst.hardEnvAutoPeriod && inst.hardEnvPeriod) {
      macros.push({ code: MAC.ex3, vals: [0], loop: 255, rel: 255, instant: false });
      macros.push({ code: MAC.ex5, vals: [clamp(inst.hardEnvPeriod, 1, 0xffff)], loop: 255, rel: 255, instant: false });
    } else {
      // the envelope runs at (tone period * den / num) / 16: den / num is the editor's divisor
      const div = Math.max(1 / 64, inst.hardEnvDivisor || 1);
      let num = 1, den = 1;
      if (div >= 1) den = clamp(Math.round(div), 1, 255); else num = clamp(Math.round(1 / div), 1, 255);
      const exact = div >= 1 ? den : 1 / num;
      if (Math.abs(exact - div) > 1e-6) warn('div:' + label, `${label}: envelope divisor ${div} is played as ${exact}`);
      macros.push({ code: MAC.ex3, vals: [num], loop: 255, rel: 255, instant: false });
      macros.push({ code: MAC.alg, vals: [den], loop: 255, rel: 255, instant: false });
    }
    if (ticks.some((t) => t.semi !== 0 || t.pitch !== 0)) warn('hardfollow:' + label, `${label}: Furnace's envelope follows the note's arpeggio / pitch (the editor keeps it on the written note)`);
  }
  macros.sort((a, b) => a.code - b.code);
  return {
    name: inst.name || `Instrument ${index}`, macros, hasTail: tail.length > 0, ticks, loopStart,
    frac: ticks.some((t) => Math.abs(t.frac) > 0.02), variants: [], index: -1,
  };
}

function writeInstrument(f: FInst): number[] {
  const w = new W();
  w.u16(FORMAT_VERSION).u16(6);                       // type 6 = AY-3-8910
  // name
  const na = new W().str(f.name);
  w.tag('NA').u16(na.length).bytes(na.b);
  // macros
  const ma = new W().u16(8);
  for (const m of f.macros) {
    const mn = Math.min(...m.vals), mx = Math.max(...m.vals);
    let size = 0;                                      // 0 u8, 1 s8, 2 s16
    if (mn >= 0 && mx <= 255) size = 0; else if (mn >= -128 && mx <= 127) size = 1; else size = 2;
    ma.u8(m.code).u8(m.vals.length).u8(m.loop).u8(m.rel).u8(0).u8((m.instant ? 8 : 0) | (size << 6)).u8(0).u8(1);
    for (const v of m.vals) { if (size === 2) ma.u16(v); else ma.u8(v); }
  }
  ma.u8(255);
  w.tag('MA').u16(ma.length).bytes(ma.b);
  w.tag('EN');
  return W.block('INS2', w);
}

// ------------------------------------------------------------------------------------------------ patterns

interface FCell { note: number; ins: number; vol: number; fx: [number, number][] }
interface ChState { inst: number; furIns: number; last: number; vol64: number; vol15: number; arp: boolean; arpSpeed: number; slide: number; porta: number; vs: number; vd: number; vibFine: boolean }
const FX = (c: string) => EFFECT_LETTERS.indexOf(c) + 1;

/** one channel's pattern bytes */
function patternBytes(rows: (FCell | null)[], patLen: number): number[] {
  const w = new W();
  let r = 0;
  while (r < patLen) {
    const c = rows[r];
    if (!c) {
      let n = 1;
      while (r + n < patLen && !rows[r + n]) n++;
      if (r + n >= patLen) { w.u8(0xff); return w.b; }           // the rest is empty
      if (n === 1) w.u8(0);
      else { let left = n; while (left > 0) { const k = Math.min(left, 129); if (k === 1) w.u8(0); else w.u8(0x80 | (k - 2)); left -= k; } }
      r += n; continue;
    }
    let mask = 0, fxMask = 0;
    if (c.note >= 0) mask |= 1;
    if (c.ins >= 0) mask |= 2;
    if (c.vol >= 0) mask |= 4;
    c.fx.forEach((_, k) => { fxMask |= 3 << (2 * k); });
    if (fxMask & 0xff) mask |= 32;
    if (fxMask & 0xff00) mask |= 64;
    w.u8(mask);
    if (mask & 32) w.u8(fxMask & 0xff);
    if (mask & 64) w.u8((fxMask >> 8) & 0xff);
    if (mask & 1) w.u8(c.note);
    if (mask & 2) w.u8(c.ins);
    if (mask & 4) w.u8(c.vol);
    for (const [e, v] of c.fx) { w.u8(e); w.u8(v); }
    r++;
  }
  w.u8(0xff);
  return w.b;
}

export function songToFur(song: Song, opts: FurOptions = {}): FurResult {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const warn = (k: string, m: string) => { if (!seen.has(k)) { seen.add(k); warnings.push(m); } };
  const counts = new Map<string, number>();
  const unsup = (text: string) => counts.set(text, (counts.get(text) ?? 0) + 1);

  const nch = Math.min(VOICES, channelsOf(song));
  if (channelsOf(song) > VOICES) warn('chan', `channels ${VOICES + 1}+ (drum channel / extra columns) are not exported`);

  // ---- instruments: compiled the first time a note plays them (a step table with fractional semitones gets one copy per
  // note, because Furnace's pitch macro is in period units and the correction depends on the note)
  const insts: FInst[] = [];
  const templates = new Map<number, FInst | null>();
  let instFull = false;
  const template = (ii: number): FInst | null => {
    if (!templates.has(ii)) templates.set(ii, song.instruments[ii] ? compileInstrument(song.instruments[ii], ii, warn, song.speed || 6) : null);
    return templates.get(ii)!;
  };
  const indexOf = (f: FInst): number => {
    if (f.index < 0) {
      if (insts.length >= 256) { if (!instFull) { instFull = true; warn('inst', 'more than 256 instruments (incl. per-note copies of fractional-semitone instruments): the extra ones use the plain instrument'); } return -1; }
      f.index = insts.length; insts.push(f);
    }
    return f.index;
  };
  const periodOf = (note: number, semi = 0) => 2_000_000 / (16 * noteToFreq(note) * 2 ** (semi / 12));
  /** the instrument to play `note` with: the template itself, or its copy with the note's period correction */
  const variantFor = (t: FInst, note: number): number => {
    if (!t.frac) return indexOf(t);
    const pn = Math.round(periodOf(note));
    const pv = t.ticks.map((k) => Math.round(Math.round(periodOf(note + k.semi)) - pn / 2 ** ((k.semi + k.frac) / 12)) - Math.round(k.pitch));
    if (pv.every((v) => Math.abs(v) <= 1)) return indexOf(t);
    for (const v of t.variants) if (v.pitch.length === pv.length && v.pitch.every((x, i) => Math.abs(x - pv[i]) <= 1)) return indexOf(v.inst);
    const copy: FInst = { ...t, macros: t.macros.filter((m) => m.code !== MAC.pitch).concat(seqMacro(MAC.pitch, pv, t.loopStart)).sort((a, b) => a.code - b.code), variants: [], index: -1 };
    const ix = indexOf(copy);
    if (ix < 0) return indexOf(t);
    t.variants.push({ inst: copy, pitch: pv });
    return ix;
  };

  // ---- order list: song positions that exist
  const orderPats: { pat: NonNullable<Song['patterns'][number]>; height: number; orderIndex: number }[] = [];
  let skippedOrders = false;
  for (let oi = 0; oi < Math.min(256, song.order.length); oi++) {
    const pat = song.patterns[song.order[oi]];
    if (!pat) { skippedOrders = true; continue; }
    let height = Math.min(256, pat.rows);
    for (let r = 0; r < height; r++) {
      let brk = false;
      for (let c = 0; c < nch; c++) if (pat.cells[r][c].effect === FX('D')) brk = true;
      if (brk) { height = r + 1; break; }
    }
    orderPats.push({ pat, height, orderIndex: oi });
  }
  if (song.order.length > 256) warn('orders', 'the order list is cut at 256 positions (Furnace limit)');
  if (skippedOrders) warn('orderskip', 'order positions that point to missing patterns are left out; Bxx jump targets may shift');
  const posOf = new Map<number, number>();
  orderPats.forEach((o, i) => posOf.set(o.orderIndex, i));
  if (song.patterns.some((p) => p.rows > 256)) warn('rows', 'patterns longer than 256 rows are cut (Furnace limit)');
  const patLen = Math.max(1, ...orderPats.map((o) => o.height));

  // ---- pattern pass
  const st: ChState[] = Array.from({ length: nch }, () => ({ inst: 0, furIns: -1, last: -1, vol64: 64, vol15: 15, arp: false, arpSpeed: 1, slide: 0, porta: 0, vs: 0, vd: 0, vibFine: false }));
  let speed = song.speed || 6;
  const initialSpeed = speed;
  const chanRows: (FCell | null)[][][] = Array.from({ length: nch }, () => []);   // [channel][order][row]
  let maxFx = 1;

  orderPats.forEach((op, oIdx) => {
    const perChan: (FCell | null)[][] = Array.from({ length: nch }, () => Array.from({ length: patLen }, () => null as FCell | null));
    const cellAt = (c: number, r: number): FCell => (perChan[c][r] ??= { note: -1, ins: -1, vol: -1, fx: [] });
    const addGlobal = (r: number, e: number, v: number) => {
      for (let c = 0; c < nch; c++) { const cl = cellAt(c, r); if (cl.fx.length < 8) { cl.fx.push([e, v]); return; } }
      unsup('effects beyond 8 per row');
    };
    for (let r = 0; r < op.height; r++) {
      for (let c = 0; c < nch; c++) {
        const cell: Cell = op.pat.cells[r][c];
        const s = st[c];
        const out: FCell = { note: -1, ins: -1, vol: -1, fx: [] };
        const eff = cell.effect ? EFFECT_LETTERS[cell.effect - 1] : '';
        const p = cell.param;
        const noteOn = cell.note > 0 && cell.note < NOTE_OFF;
        const porta = eff === '3';
        let triggered = false;

        if (cell.note === NOTE_OFF || eff === 'K') {
          if (s.last >= 0 && (cell.note === NOTE_OFF || cell.note === 0)) {
            const tail = s.inst ? template(s.inst)?.hasTail : false;
            out.note = tail ? FUR_NOTE_REL : FUR_NOTE_OFF;
          }
        } else if (noteOn) {
          const fn = cell.note + NOTE_BASE;
          if (fn < 0 || fn > 179) warn('noterange', 'notes outside the Furnace range are left out');
          else if (porta && s.last >= 0) {
            out.note = fn; s.last = cell.note;                         // glide target: no instrument, keeps playing
            if (cell.instrument) s.vol64 = 64;
          } else {
            const ii = cell.instrument ? cell.instrument : s.inst;
            const tpl = ii ? template(ii) : null;
            const fi = tpl ? variantFor(tpl, cell.note) : -1;
            if (fi < 0) unsup('notes without an instrument');
            else {
              out.note = fn; s.inst = ii; s.last = cell.note; triggered = true;
              if (cell.instrument) s.vol64 = 64;
              if (cell.instrument || s.furIns !== fi) { out.ins = fi; s.furIns = fi; }
            }
          }
        } else if (cell.instrument && song.instruments[cell.instrument]) {
          s.inst = cell.instrument;                                   // instrument without a note: only selects (the editor restarts it, Furnace would too, but needs a note)
          unsup('instrument columns without a note');
        }
        void triggered;

        // volume column / C effect
        if (cell.volume >= 0x10 && cell.volume <= 0x50) s.vol64 = cell.volume - 0x10;
        if (eff === 'C') s.vol64 = clamp(p, 0, 64);
        const v15 = logVol(s.vol64);
        if ((out.note >= 0 || cell.volume || eff === 'C') && v15 !== s.vol15) { out.vol = v15; s.vol15 = v15; }

        // arpeggio (not persistent in the editor, persistent in Furnace)
        if (eff === '0' && p) {
          const sp = Math.max(1, song.instruments[s.inst]?.arpSpeed ?? 1);
          if (sp !== s.arpSpeed) { out.fx.push([0xe0, clamp(sp, 1, 255)]); s.arpSpeed = sp; }
          out.fx.push([0x00, p]); s.arp = true;
        } else if (s.arp) { out.fx.push([0x00, 0]); s.arp = false; }

        // slides (persistent in both; the editor stops them on the first row without one)
        const want = (eff === '1' || eff === '2') && p ? (eff === '1' ? 1 : 2) : 0;
        if (want) { out.fx.push([want, p]); s.slide = want; }
        else if (s.slide && !(eff === '1' || eff === '2')) { out.fx.push([s.slide, 0]); s.slide = 0; }
        if (porta) {
          if (out.note >= 0 && out.ins < 0 && !triggered) { const sp = p || s.porta || 1; out.fx.push([0x03, sp]); s.porta = sp; }
          else unsup('tone portamento without a new note');
        }
        // vibrato: the editor keeps speed / depth until the next note (a zero nibble keeps the old value); Furnace keeps them across notes
        const newNote = out.note >= 0 && out.note < FUR_NOTE_OFF && !(porta && !triggered);
        if (eff === '4') {
          const nvs = ((p >> 4) & 15) || (newNote ? 0 : s.vs), nvd = (p & 15) || (newNote ? 0 : s.vd);
          if (!s.vibFine) { out.fx.push([0xe4, 1]); s.vibFine = true; }   // vibrato range 1: 0.5 register-period unit per depth step, like the editor
          out.fx.push([0x04, (nvs << 4) | nvd]); s.vs = nvs; s.vd = nvd;
          warn('vib', 'vibrato (4xy) is exported as Furnace 04xy; its curve starts in the opposite direction and about two ticks earlier');
        } else if (newNote && (s.vs || s.vd)) { out.fx.push([0x04, 0]); s.vs = 0; s.vd = 0; }
        if (eff === 'E') {
          const sub = (p >> 4) & 15, v = p & 15;
          if (sub === 0xd) out.fx.push([0xed, v]);
          else if (sub === 0xc) out.fx.push([0xec, v]);
          else unsup(`extended effect E${sub.toString(16).toUpperCase()}x`);
        }

        // speed / flow
        if (eff === 'F') {
          if (p === 0) unsup('F00 stop');
          else if (p < 0x20) { speed = p; addGlobal(r, 0x0f, p); }
          else addGlobal(r, 0xf0, p);
        }
        if (eff === 'D') {
          const row = (p >> 4) * 10 + (p & 15);
          addGlobal(r, 0x0d, clamp(row, 0, 255));
        }
        if (eff === 'B') {
          const target = posOf.get(p);
          if (target === undefined) unsup('position jumps to missing positions');
          else addGlobal(r, 0x0b, target);
        }

        // everything else the editor has that Furnace's AY cannot do the same way
        if (eff && !'0123BCDEFK4'.includes(eff)) {
          const names: Record<string, string> = { '5': 'tone portamento + volume slide', '6': 'vibrato + volume slide', '7': 'tremolo', '8': 'tremolo', 'A': 'volume slide', 'G': 'global volume', 'H': 'global volume slide', 'L': 'envelope position', 'M': 'envelope period', 'P': 'envelope divisor', 'R': 'retrigger', 'T': 'effect T', 'X': 'envelope shape', 'Y': 'envelope period', 'Q': 'timer effects (Q/S/U)', 'S': 'timer effects (Q/S/U)', 'U': 'timer effects (Q/S/U)', 'Z': 'digidrums (Z)', '9': 'effect 9' };
          unsup(names[eff] ?? `effect ${eff}`);
        }

        if (out.note >= 0 || out.ins >= 0 || out.vol >= 0 || out.fx.length) {
          const dst = cellAt(c, r);
          dst.note = out.note; dst.ins = out.ins; dst.vol = out.vol; dst.fx.push(...out.fx);
        }
      }
    }
    // a short pattern ends with a jump to the next one (or back to the restart position, for the last)
    const isLast = oIdx === orderPats.length - 1;
    const lastRow = op.height - 1;
    const hasFlow = (r: number) => perChan.some((ch) => ch[r]?.fx.some(([e]) => e === 0x0d || e === 0x0b));
    if (isLast && song.restartPos > 0 && !hasFlow(lastRow)) addGlobal(lastRow, 0x0b, clamp(posOf.get(song.restartPos) ?? 0, 0, 255));
    else if (op.height < patLen && !hasFlow(lastRow)) addGlobal(lastRow, 0x0d, 0);
    for (let c = 0; c < nch; c++) {
      chanRows[c].push(perChan[c]);
      for (const cl of perChan[c]) if (cl) maxFx = Math.max(maxFx, cl.fx.length);
    }
  });

  for (const [t, n] of counts) warnings.push(`not exported: ${t} (${n}×)`);
  if (!orderPats.length) warnings.push('the song is empty');

  // ---- per-channel effect columns
  const effCols: number[] = [];
  for (let c = 0; c < nch; c++) {
    let m = 1;
    for (const o of chanRows[c]) for (const cl of o) if (cl) m = Math.max(m, cl.fx.length);
    effCols.push(clamp(m, 1, 8));
  }

  // ---- patterns: identical channel patterns share one
  const patBlocks: number[][] = [];
  const patIndex: number[][] = Array.from({ length: nch }, () => []);   // [channel][order] -> pattern number within the channel
  for (let c = 0; c < nch; c++) {
    const keys = new Map<string, number>();
    let next = 0;
    chanRows[c].forEach((rows, oIdx) => {
      const data = patternBytes(rows, patLen);
      const key = data.join(',');
      let ix = keys.get(key);
      if (ix === undefined) {
        ix = next++;
        keys.set(key, ix);
        const w = new W().u8(0).u8(c).u16(ix).str('').bytes(data);
        patBlocks.push(W.block('PATN', w));
      }
      patIndex[c][oIdx] = ix;
    });
  }

  // ---- blocks
  const insBlocks = insts.map(writeInstrument);
  const flag = W.block('FLAG', new W().str('chipType=1\nclockSel=3\nstereo=false\n'));
  const adir = W.block('ADIR', new W().u32(0));

  const hz = Math.round(song.bpm * 0.4 * 1000) / 1000 || 50;
  const buildInfo = (flagPtr: number, adirPtrs: number[], insPtrs: number[], patPtrs: number[]): number[] => {
    const w = new W();
    w.u8(0).u8(initialSpeed).u8(initialSpeed).u8(1).f32(hz);
    w.u16(patLen).u16(Math.max(1, orderPats.length)).u8(4).u8(16);
    w.u16(insBlocks.length).u16(0).u16(0).u32(patBlocks.length);
    w.u8(0x80).fill(0, 31);                                           // chips: one AY-3-8910
    w.u8(64).fill(0, 31);                                             // volumes (superseded by the floats below)
    w.fill(0, 32);                                                    // panning
    w.u32(flagPtr).fill(0, 31 * 4);                                   // chip flag pointers
    w.str(opts.title ?? song.name ?? '').str(opts.author ?? song.author ?? '').f32(440);
    // compatibility flags (Furnace defaults, but with non-linear pitch: slides / pitch macro in register period units)
    w.bytes([0, 0, 2, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    for (const p of insPtrs) w.u32(p);
    for (const p of patPtrs) w.u32(p);
    // orders: channel-major
    for (let c = 0; c < nch; c++) for (let o = 0; o < Math.max(1, orderPats.length); o++) w.u8(patIndex[c][o] ?? 0);
    for (let c = 0; c < nch; c++) w.u8(effCols[c]);
    for (let c = 0; c < nch; c++) w.u8(3);                            // shown + oscilloscope
    for (let c = 0; c < nch; c++) w.u8(0);                            // collapse
    const names = song.channelNames ?? ['A', 'B', 'C'];
    for (let c = 0; c < nch; c++) w.str(names[c] ?? ['A', 'B', 'C'][c]);
    for (let c = 0; c < nch; c++) w.str('');
    w.str(opts.comment ?? 'made with MOD-XM-to-YM-SNDH-tool');
    w.f32(1);                                                         // master volume
    // extended compatibility flags
    w.bytes([0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 4, 0, 0, 1, 1, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0]);
    w.u16(150).u16(150);                                              // virtual tempo
    w.str('').str('').u8(0).fill(0, 3);                               // first subsong name / comment, no more subsongs
    w.str('Atari ST').str('').str('').str('').str('').str('');
    w.f32(1).f32(0).f32(0);                                           // chip volume / pan / balance
    w.u32(0).u8(1);                                                   // patchbay: no connections, automatic
    w.fill(0, 8);                                                     // more compat flags
    w.u8(1).u8(initialSpeed).fill(0, 15);                             // speed pattern (1 entry)
    w.u8(0);                                                          // grooves
    for (const p of adirPtrs) w.u32(p);
    return W.block('INFO', w);
  };

  const infoLen = buildInfo(0, [0, 0, 0], insBlocks.map(() => 0), patBlocks.map(() => 0)).length;
  let off = 32 + infoLen;
  const flagPtr = off; off += flag.length;
  const adirPtrs: number[] = [];
  for (let i = 0; i < 3; i++) { adirPtrs.push(off); off += adir.length; }
  const insPtrs: number[] = [];
  for (const b of insBlocks) { insPtrs.push(off); off += b.length; }
  const patPtrs: number[] = [];
  for (const b of patBlocks) { patPtrs.push(off); off += b.length; }
  const info = buildInfo(flagPtr, adirPtrs, insPtrs, patPtrs);

  const out = new W();
  out.tag('-Furnace module-').u16(FORMAT_VERSION).u16(0).u32(32).fill(0, 8);
  out.bytes(info).bytes(flag);
  for (let i = 0; i < 3; i++) out.bytes(adir);
  for (const b of insBlocks) out.bytes(b);
  for (const b of patBlocks) out.bytes(b);

  return {
    bytes: Uint8Array.from(out.b),
    warnings,
    stats: { orders: orderPats.length, patterns: patBlocks.length, instruments: insts.length, rows: patLen },
  };
}

/** the .fur file name for a song title */
export const furName = (title: string) => `${(title || 'song').replace(/[^A-Za-z0-9 _.-]/g, '_') || 'song'}.fur`;
