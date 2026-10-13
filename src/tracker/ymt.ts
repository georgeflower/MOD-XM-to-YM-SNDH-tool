/**
 * .ymt — the YM Tracker's native song file ("YMT1": gzip-able chunked payload), read and written here
 * byte-compatibly, so songs go both ways between the two tools.
 *
 * Extension: after the last instrument this tool appends an "XSEQ" block with the step tables of
 * step-table instruments (the YM Tracker stops reading after the instruments and ignores it).
 */
import {
  type Song, type Pattern, type Cell, type Instrument, type DigiDrumSample,
  NOTE_OFF, MAX_CHANNELS, NUM_CHANNELS, defaultInstrument, emptyPattern, emptyCell, isEmptyCell,
} from './types';

const MAGIC = 'YMT1';
const VERSION = 1;
const FLAG_GZIP = 1;

class W {
  private buf = new Uint8Array(4096); private len = 0; private dv = new DataView(this.buf.buffer);
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length; while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap); nb.set(this.buf); this.buf = nb; this.dv = new DataView(nb.buffer);
  }
  u8(v: number) { this.ensure(1); this.buf[this.len++] = v & 0xff; }
  i8(v: number) { this.ensure(1); this.dv.setInt8(this.len, v); this.len += 1; }
  u16(v: number) { this.ensure(2); this.dv.setUint16(this.len, v, true); this.len += 2; }
  i16(v: number) { this.ensure(2); this.dv.setInt16(this.len, v, true); this.len += 2; }
  u32(v: number) { this.ensure(4); this.dv.setUint32(this.len, v >>> 0, true); this.len += 4; }
  f32(v: number) { this.ensure(4); this.dv.setFloat32(this.len, v, true); this.len += 4; }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length; }
  str16(s: string) { const e = new TextEncoder().encode(s); this.u16(e.length); this.bytes(e); }
  str8(s: string) { const e = new TextEncoder().encode(s).slice(0, 255); this.u8(e.length); this.bytes(e); }
  view() { return this.buf.subarray(0, this.len); }
}
class R {
  private dv: DataView; private off = 0;
  constructor(private buf: Uint8Array) { this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  u8() { return this.dv.getUint8(this.off++); }
  i8() { const v = this.dv.getInt8(this.off); this.off += 1; return v; }
  u16() { const v = this.dv.getUint16(this.off, true); this.off += 2; return v; }
  i16() { const v = this.dv.getInt16(this.off, true); this.off += 2; return v; }
  u32() { const v = this.dv.getUint32(this.off, true); this.off += 4; return v >>> 0; }
  f32() { const v = this.dv.getFloat32(this.off, true); this.off += 4; return v; }
  bytes(n: number) { const o = this.buf.subarray(this.off, this.off + n); this.off += n; return o; }
  str16() { return new TextDecoder().decode(this.bytes(this.u16())); }
  str8() { return new TextDecoder().decode(this.bytes(this.u8())); }
  get eof() { return this.off >= this.buf.byteLength; }
  get left() { return this.buf.byteLength - this.off; }
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function packPattern(p: Pattern, channelCount: number): Uint8Array {
  const w = new W();
  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < channelCount; c++) {
      const cell = p.cells[r]?.[c] ?? emptyCell();
      if (isEmptyCell(cell)) { w.u8(0x80); continue; }
      let mask = 0x80;
      if (cell.note) mask |= 1; if (cell.instrument) mask |= 2; if (cell.volume) mask |= 4; if (cell.effect) mask |= 8; if (cell.param) mask |= 16;
      w.u8(mask);
      if (cell.note) w.u8(cell.note); if (cell.instrument) w.u8(cell.instrument); if (cell.volume) w.u8(cell.volume);
      if (cell.effect) w.u8(cell.effect); if (cell.param) w.u8(cell.param);
    }
  }
  return new Uint8Array(w.view());
}
function unpackPattern(buf: Uint8Array, rows: number, channelCount: number): Pattern {
  const r = new R(buf); const cells: Cell[][] = [];
  for (let ri = 0; ri < rows; ri++) {
    const row: Cell[] = [];
    for (let ci = 0; ci < channelCount; ci++) {
      const cell = emptyCell();
      if (!r.eof) {
        const mask = r.u8();
        if (!(mask & 0x80)) cell.note = mask;
        else {
          if (mask & 1) cell.note = r.u8(); if (mask & 2) cell.instrument = r.u8(); if (mask & 4) cell.volume = r.u8();
          if (mask & 8) cell.effect = r.u8(); if (mask & 16) cell.param = r.u8();
        }
      }
      row.push(cell);
    }
    cells.push(row);
  }
  return { rows, cells };
}
const packPcm4 = (pcm: Uint8Array) => { const o = new Uint8Array(Math.ceil(pcm.length / 2)); for (let i = 0; i < pcm.length; i++) o[i >> 1] |= (i & 1) ? (pcm[i] & 15) << 4 : pcm[i] & 15; return o; };
const unpackPcm4 = (b: Uint8Array, n: number) => { const o = new Uint8Array(n); for (let i = 0; i < n; i++) { const x = b[i >> 1] ?? 0; o[i] = (i & 1) ? (x >> 4) & 15 : x & 15; } return o; };

function writeInstrument(w: W, inst: Instrument) {
  w.str16(inst.name ?? '');
  const a = inst.adsr;
  w.u8(a.useAdsr ? 1 : 0); w.u8(a.attack); w.u8(a.decay); w.u8(a.sustain); w.u8(a.release);
  w.u8(inst.useHardEnv ? 1 : 0); w.u8(inst.hardEnvShape); w.u16(inst.hardEnvPeriod); w.u8(inst.hardEnvAutoPeriod ? 1 : 0);
  w.u8(inst.hardEnvDivisor); w.u8(inst.syncBuzz ? 1 : 0);
  w.u8(inst.noiseEnabled ? 1 : 0); w.u16(inst.noisePeriod); w.u8(inst.toneEnabled ? 1 : 0);
  w.u8(inst.arpSpeed ?? 1); w.u8(inst.vibratoSpeed ?? 0); w.u8(inst.vibratoDepth ?? 0);
  w.u8(inst.phase ?? 0); w.u8(inst.dutyPercent ?? 0); w.u8(inst.noiseAnd ?? 0); w.u8(inst.noiseOr ?? 0); w.u8(inst.channelMode ?? 0);
  w.i16(inst.volSustain ?? -1);
  w.u16(inst.volEnv.length); for (const v of inst.volEnv) w.u8(v);
  w.u16(inst.volRelease.length); for (const v of inst.volRelease) w.u8(v);
  w.u16(inst.arpMacro.length); for (const v of inst.arpMacro) w.i8(Math.max(-128, Math.min(127, v | 0)));
  w.u16(inst.pitchMacro.length); for (const v of inst.pitchMacro) w.i16(Math.max(-32768, Math.min(32767, v | 0)));
  const wt = inst.wavetableMacro ?? []; w.u16(wt.length); for (const v of wt) w.u8(v);
  const drums = inst.digiDrums ?? [];
  w.u16(drums.length);
  for (const d of drums) { w.str8(d.name ?? 'Drum'); w.u16(Math.max(1, Math.min(65535, d.rateHz | 0))); w.u32(d.pcm.length); w.bytes(packPcm4(d.pcm)); }
}
function readInstrument(r: R): Instrument {
  const inst: Instrument = { ...defaultInstrument(), digiDrums: [] };
  inst.name = r.str16();
  inst.adsr = { useAdsr: !!r.u8(), attack: r.u8(), decay: r.u8(), sustain: r.u8(), release: r.u8() };
  inst.useHardEnv = !!r.u8(); inst.hardEnvShape = r.u8(); inst.hardEnvPeriod = r.u16(); inst.hardEnvAutoPeriod = !!r.u8();
  inst.hardEnvDivisor = r.u8(); inst.syncBuzz = !!r.u8();
  inst.noiseEnabled = !!r.u8(); inst.noisePeriod = r.u16(); inst.toneEnabled = !!r.u8();
  inst.arpSpeed = r.u8(); inst.vibratoSpeed = r.u8(); inst.vibratoDepth = r.u8();
  inst.phase = r.u8(); inst.dutyPercent = r.u8(); inst.noiseAnd = r.u8(); inst.noiseOr = r.u8(); inst.channelMode = r.u8();
  inst.volSustain = r.i16();
  let n = r.u16(); inst.volEnv = []; for (let i = 0; i < n; i++) inst.volEnv.push(r.u8());
  n = r.u16(); inst.volRelease = []; for (let i = 0; i < n; i++) inst.volRelease.push(r.u8());
  n = r.u16(); inst.arpMacro = []; for (let i = 0; i < n; i++) inst.arpMacro.push(r.i8());
  n = r.u16(); inst.pitchMacro = []; for (let i = 0; i < n; i++) inst.pitchMacro.push(r.i16());
  n = r.u16(); inst.wavetableMacro = []; for (let i = 0; i < n; i++) inst.wavetableMacro.push(r.u8());
  const dc = r.u16(); const drums: DigiDrumSample[] = [];
  for (let i = 0; i < dc; i++) { const name = r.str8(); const rateHz = r.u16(); const len = r.u32(); drums.push({ name, rateHz, pcm: unpackPcm4(r.bytes(Math.ceil(len / 2)), len) }); }
  inst.digiDrums = drums;
  return inst;
}

export const isYmt = (b: Uint8Array) => b.length >= 4 && String.fromCharCode(b[0], b[1], b[2], b[3]) === MAGIC;

export async function encodeYmt(song: Song, opts: { gzip?: boolean } = {}): Promise<Uint8Array> {
  const useGzip = opts.gzip !== false;
  const channelCount = Math.max(1, Math.min(MAX_CHANNELS, song.channelCount ?? NUM_CHANNELS));
  const drumChannel = typeof song.drumChannel === 'number' ? song.drumChannel : -1;
  const p = new W();
  p.str16(song.name ?? ''); p.u16(song.bpm | 0); p.u8(song.speed | 0); p.u8(song.step | 0); p.u16(song.restartPos | 0);
  p.u8(channelCount); p.i8(Math.max(-1, Math.min(127, drumChannel)));
  p.u16(song.order.length); p.u16(song.patterns.length); p.u16(song.instruments.length);
  const names = song.channelNames;
  if (names?.length) { p.u8(1); for (let i = 0; i < channelCount; i++) p.str8((names[i] ?? '').slice(0, 255)); } else p.u8(0);
  for (const o of song.order) p.u8(o);
  for (const pat of song.patterns) { p.u16(pat.rows); const pk = packPattern(pat, channelCount); p.u32(pk.length); p.bytes(pk); }
  for (const inst of song.instruments) writeInstrument(p, inst);
  // ---- extension: step tables + author
  p.bytes(new TextEncoder().encode('XSEQ'));
  const withSeq = song.instruments.map((ins, i) => [ins, i] as const).filter(([ins]) => ins.seq);
  p.u16(withSeq.length);
  for (const [ins, i] of withSeq) {
    const sq = ins.seq!;
    p.u16(i); p.i16(sq.loopFrom); p.u8(sq.velocity ? 1 : 0); p.u8(sq.release); p.u16(sq.steps.length);
    for (const s of sq.steps) { p.i16(Math.round(s.vol * 100)); p.i16(Math.round(s.semi * 100)); p.u8(s.noise); p.u8((s.tone ? 1 : 0) | (s.plain ? 2 : 0)); }
  }
  p.bytes(new TextEncoder().encode('XAUT')); p.str16(song.author ?? '');
  const withSync = song.instruments.map((ins, i) => [ins, i] as const).filter(([ins]) => ins.syncSquare);
  if (withSync.length) { p.bytes(new TextEncoder().encode('XSYN')); p.u16(withSync.length); for (const [, i] of withSync) p.u16(i); }
  const payload = new Uint8Array(p.view());
  const body = useGzip ? await pipe(payload, new CompressionStream('gzip')) : payload;
  const h = new W();
  h.bytes(new TextEncoder().encode(MAGIC)); h.u8(VERSION); h.u8(useGzip ? FLAG_GZIP : 0); h.u16(8); h.bytes(body);
  return new Uint8Array(h.view());
}

export async function decodeYmt(buf: Uint8Array): Promise<Song> {
  if (!isYmt(buf)) throw new Error('Not a .ymt file (bad magic)');
  if (buf[4] !== VERSION) throw new Error(`Unsupported .ymt version ${buf[4]}`);
  const flags = buf[5], headerSize = buf[6] | (buf[7] << 8);
  const raw = buf.subarray(headerSize);
  const r = new R(flags & FLAG_GZIP ? await pipe(raw, new DecompressionStream('gzip')) : raw);
  const name = r.str16(), bpm = r.u16(), speed = r.u8(), step = r.u8(), restartPos = r.u16();
  const channelCount = Math.max(1, Math.min(MAX_CHANNELS, r.u8()));
  const drumChannel = r.i8();
  const orderLen = r.u16(), patCount = r.u16(), instCount = r.u16();
  let channelNames: string[] | undefined;
  if (r.u8()) { channelNames = []; for (let i = 0; i < channelCount; i++) channelNames.push(r.str8()); }
  const order: number[] = []; for (let i = 0; i < orderLen; i++) order.push(r.u8());
  const patterns: Pattern[] = [];
  for (let i = 0; i < patCount; i++) { const rows = r.u16(); const n = r.u32(); patterns.push(unpackPattern(r.bytes(n), rows, channelCount)); }
  if (!patterns.length) patterns.push(emptyPattern(64, channelCount));
  const instruments: Instrument[] = []; for (let i = 0; i < instCount; i++) instruments.push(readInstrument(r));
  const song: Song = {
    name, bpm, speed, step, restartPos, channelCount, drumChannel: Math.max(-1, Math.min(channelCount - 1, drumChannel)), channelNames,
    order: order.map((p) => Math.max(0, Math.min(patterns.length - 1, p))), patterns, instruments,
  };
  // optional extension blocks written by this tool
  while (r.left >= 4) {
    const tag = new TextDecoder().decode(r.bytes(4));
    if (tag === 'XSEQ') {
      const n = r.u16();
      for (let k = 0; k < n; k++) {
        const idx = r.u16(), loopFrom = r.i16(), velocity = !!r.u8(), release = r.u8(), cnt = r.u16();
        const steps = [];
        for (let j = 0; j < cnt; j++) { const vol = r.i16() / 100, semi = r.i16() / 100, noise = r.u8(), tb = r.u8(); steps.push(tb & 2 ? { vol, semi, noise, tone: !!(tb & 1), plain: true } : { vol, semi, noise, tone: !!tb }); }
        if (instruments[idx]) instruments[idx].seq = { steps, loopFrom, velocity, release };
      }
    } else if (tag === 'XAUT') song.author = r.str16();
    else if (tag === 'XSYN') { const n = r.u16(); for (let k = 0; k < n; k++) { const idx = r.u16(); if (instruments[idx]) instruments[idx].syncSquare = true; } }
    else break;
  }
  void NOTE_OFF;
  return song;
}
