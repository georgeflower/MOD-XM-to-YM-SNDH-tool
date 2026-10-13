/**
 * maxYMiser native file formats (by Gareth Morris "gwEm"): .MYS song, .MYV voice bank, .MYI single instrument.
 * Layouts follow the editor's own files (v1.29 and later); all multi-byte values are big-endian.
 *
 * song  : "MYM0TRAK" + 64 state bytes + 256 order rows x 4 bytes (3 YM tracks + DMA track) + length + repeat,
 *         then the patterns, 64 rows each as 8-byte records (note, instrument, volume, fx1, p1, fx2, p2, skip)
 *         where `skip` says how many following rows are empty and not stored.
 * bank  : 8 sample pointers (each relative to its own position) + "MYM0INST" + 32 instruments x 64 bytes +
 *         8 sample parameter records + N sequences (64 bytes: 31 words, length, repeat) + "MYM1DIGI" + sample data.
 * inst  : "MYM0.MYI" + 48 bytes of instrument + seven 64-byte sequences (the ones the instrument points to, in order).
 */
export const MYM_ROWS = 64;
export const MYM_MAX_PATTERNS = 240;
export const MYM_MAX_ORDERS = 256;
export const MYM_MAX_SEQUENCES = 256;
export const MYM_SEQ_WORDS = 31;            // version 0 banks; version 1 has 63
export const MYM_INSTRUMENTS = 32;
export const MYM_SAMPLES = 8;

/** instrument record offsets (64 bytes) */
export const INST = {
  name: 0, portaMask: 16, arpMask: 17, vibMask: 18, transMask: 19, fixMask: 20, detuneMask: 21,
  seqSpeed: 32, pulse: 33, wave: 34, sync: 35, sample: 36, sampleRate: 37, volume: 38, detuneCoarse: 39, detuneFine: 40, freqRes: 41,
  volSeq: 48, arpSeq: 49, vibSeq: 50, mixSeq: 51, noiseSeq: 52, fixSeq: 53, timSeq: 54, pwmSeq: 55,
} as const;

export interface MymCell { note: number; inst: number; vol: number; fx1: number; p1: number; fx2: number; p2: number }
export const emptyMymCell = (): MymCell => ({ note: 0, inst: 0, vol: 0, fx1: 0, p1: 0, fx2: 0, p2: 0 });
export const isEmptyMymCell = (c: MymCell) => !c.note && !c.inst && !c.vol && !c.fx1 && !c.p1 && !c.fx2 && !c.p2;

export interface MymSong {
  version: number;
  state: Uint8Array;                         // 64 bytes of editor / replayer settings
  orders: number[][];                        // [position][track 0..3] pattern ids (0xFF empty, 0xFE note-off)
  length: number;
  repeat: number;
  patterns: MymCell[][];                     // [pattern][row 0..63]
}

export interface MymSeq { values: number[]; length: number; repeat: number }
export const emptySeq = (): MymSeq => ({ values: [], length: 0, repeat: 0 });
export interface MymSample { pcm: Uint8Array; params: Uint8Array }       // signed 8-bit PCM; 4 parameter bytes (word length + 2)

export interface MymBank {
  version: number;
  instruments: Uint8Array[];                 // 32 x 64 bytes
  sequences: MymSeq[];                       // index = sequence id (0 is the reserved empty one)
  samples: MymSample[];                      // 8
  sampleVersion: number;
}

const u16 = (d: Uint8Array, p: number) => (d[p] << 8) | d[p + 1];
const u32 = (d: Uint8Array, p: number) => ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
const put16 = (d: Uint8Array, p: number, v: number) => { d[p] = (v >> 8) & 255; d[p + 1] = v & 255; };
const put32 = (d: Uint8Array, p: number, v: number) => { d[p] = (v >>> 24) & 255; d[p + 1] = (v >>> 16) & 255; d[p + 2] = (v >>> 8) & 255; d[p + 3] = v & 255; };
const tag = (d: Uint8Array, p: number, s: string) => { for (let i = 0; i < s.length; i++) d[p + i] = s.charCodeAt(i); };
const hasTag = (d: Uint8Array, p: number, s: string) => { for (let i = 0; i < s.length; i++) if (d[p + i] !== s.charCodeAt(i)) return false; return true; };

export const SONG_HEADER = 8 + 64 + 256 * 4 + 2;
const BANK_HEADER = 32 + 8 + 32 * 64 + 8 * 4;

// ------------------------------------------------------------------ song

export function newMymSong(): MymSong {
  const state = new Uint8Array(64);
  // defaults of a fresh song in the editor
  state[8] = 1; state[11] = 255; state[12] = 3; state[13] = 6; state[14] = 50; state[36] = 7; state[49] = 2; state[56] = 7;
  for (const i of [32, 33, 34, 35, 50]) state[i] = 1;
  [0, 1, 2, 3].forEach((v, k) => { state[40 + k] = v; });
  state[51] = 4;
  return { version: 0, state, orders: [], length: 0, repeat: 0, patterns: [] };
}

export function encodeSong(s: MymSong): Uint8Array {
  if (s.length < 1 || s.length > MYM_MAX_ORDERS || s.repeat >= s.length) throw new Error('maxYMiser: bad song length / repeat');
  if (s.patterns.length > MYM_MAX_PATTERNS) throw new Error('maxYMiser: more than 240 patterns');
  const body: number[] = [];
  for (const pat of s.patterns) {
    for (let row = 0; row < MYM_ROWS;) {
      const c = pat[row] ?? emptyMymCell();
      let skip = 0;
      while (row + skip + 1 < MYM_ROWS && isEmptyMymCell(pat[row + skip + 1] ?? emptyMymCell())) skip++;
      body.push(c.note, c.inst, c.vol, c.fx1, c.p1, c.fx2, c.p2, skip);
      row += skip + 1;
    }
  }
  const out = new Uint8Array(SONG_HEADER + body.length);
  tag(out, 0, 'MYM0TRAK'); out[3] = 0x30 + s.version;
  out.set(s.state.subarray(0, 64), 8);
  for (let i = 0; i < 256; i++) for (let t = 0; t < 4; t++) out[72 + i * 4 + t] = s.orders[i]?.[t] ?? 0xff;
  out[1096] = s.length; out[1097] = s.repeat;
  out.set(body, SONG_HEADER);
  return out;
}

export function decodeSong(d: Uint8Array): MymSong {
  if (d.length < SONG_HEADER || !hasTag(d, 0, 'MYM') || !hasTag(d, 4, 'TRAK')) throw new Error('not a maxYMiser .MYS file');
  const s: MymSong = { version: d[3] - 0x30, state: d.slice(8, 72), orders: [], length: d[1096], repeat: d[1097], patterns: [] };
  for (let i = 0; i < 256; i++) s.orders.push([d[72 + i * 4], d[73 + i * 4], d[74 + i * 4], d[75 + i * 4]]);
  let p = SONG_HEADER;
  while (p < d.length) {
    const pat: MymCell[] = Array.from({ length: MYM_ROWS }, emptyMymCell);
    for (let row = 0; row < MYM_ROWS;) {
      if (p + 8 > d.length) throw new Error('maxYMiser: truncated pattern');
      const skip = d[p + 7];
      if (row + skip >= MYM_ROWS) throw new Error('maxYMiser: RLE run exceeds the pattern');
      pat[row] = { note: d[p], inst: d[p + 1], vol: d[p + 2], fx1: d[p + 3], p1: d[p + 4], fx2: d[p + 5], p2: d[p + 6] };
      p += 8; row += skip + 1;
    }
    s.patterns.push(pat);
  }
  return s;
}

// ------------------------------------------------------------------ voice bank

export function newMymBank(): MymBank {
  return {
    version: 0,
    instruments: Array.from({ length: MYM_INSTRUMENTS }, () => new Uint8Array(64)),
    sequences: [emptySeq()],
    samples: Array.from({ length: MYM_SAMPLES }, () => ({ pcm: new Uint8Array(0), params: new Uint8Array(4) })),
    sampleVersion: 1,
  };
}

const seqStride = (version: number) => (version === 0 ? 64 : 128);

export function encodeBank(b: MymBank): Uint8Array {
  const stride = seqStride(b.version), words = stride / 2 - 1;
  const n = Math.max(1, b.sequences.length);
  if (n > MYM_MAX_SEQUENCES) throw new Error('maxYMiser: more than 256 sequences');
  const head = new Uint8Array(BANK_HEADER + stride * n + 8);
  tag(head, 32, 'MYM0INST'); head[35] = 0x30 + b.version;
  b.instruments.forEach((ins, i) => head.set(ins.subarray(0, 64), 40 + i * 64));
  for (let i = 0; i < n; i++) {
    const s = b.sequences[i] ?? emptySeq();
    if (s.length > words) throw new Error(`maxYMiser: sequence ${i} has ${s.length} steps, at most ${words}`);
    const at = BANK_HEADER + i * stride;
    for (let k = 0; k < words; k++) put16(head, at + k * 2, s.values[k] ?? 0);
    head[at + stride - 2] = s.length; head[at + stride - 1] = s.repeat;
  }
  tag(head, head.length - 8, 'MYM0DIGI'); head[head.length - 5] = 0x30 + b.sampleVersion;
  const parts: Uint8Array[] = [head];
  let size = head.length;
  b.samples.forEach((smp, i) => {
    if (smp.pcm.length > 65535) throw new Error(`maxYMiser: sample ${i} too long`);
    put32(head, i * 4, size - i * 4);
    const params = Uint8Array.from(smp.params.length >= 4 ? smp.params.subarray(0, 4) : [0, 0, 0, 0]);
    put16(params, 0, smp.pcm.length);
    head.set(params, 2088 + i * 4);
    const chunk = new Uint8Array(smp.pcm.length + 1);
    chunk.set(smp.pcm);
    parts.push(chunk); size += chunk.length;
  });
  const res = new Uint8Array(size);
  let p = 0;
  for (const part of parts) { res.set(part, p); p += part.length; }
  return res;
}

export function decodeBank(d: Uint8Array): MymBank {
  if (d.length < BANK_HEADER + 8 || !hasTag(d, 32, 'MYM') || !hasTag(d, 36, 'INST')) throw new Error('not a maxYMiser .MYV file');
  const version = d[35] - 0x30;
  if (version > 1) throw new Error(`maxYMiser: unsupported voice bank version ${version}`);
  const offs = Array.from({ length: 8 }, (_, i) => i * 4 + u32(d, i * 4));
  const end = offs[0] - 8;
  if (!hasTag(d, end, 'MYM') || !hasTag(d, end + 4, 'DIGI')) throw new Error('maxYMiser: missing sample tag');
  const stride = seqStride(version);
  if ((end - BANK_HEADER) % stride) throw new Error('maxYMiser: misaligned sequence data');
  const bank: MymBank = { version, instruments: [], sequences: [], samples: [], sampleVersion: d[end + 3] - 0x30 };
  for (let i = 0; i < 32; i++) bank.instruments.push(d.slice(40 + i * 64, 104 + i * 64));
  const n = (end - BANK_HEADER) / stride;
  for (let i = 0; i < n; i++) {
    const at = BANK_HEADER + i * stride;
    const length = d[at + stride - 2], repeat = d[at + stride - 1];
    bank.sequences.push({ values: Array.from({ length }, (_, k) => u16(d, at + k * 2)), length, repeat });
  }
  offs.forEach((start, i) => {
    const params = d.slice(2088 + i * 4, 2092 + i * 4);
    const len = u16(params, 0);
    bank.samples.push({ pcm: d.slice(start, start + len), params });
  });
  return bank;
}

// ------------------------------------------------------------------ single instrument

export interface MymInstrumentFile {
  version: number;
  inst: Uint8Array;                          // first 48 bytes of the record: name + parameters (no sequence ids)
  sequences: MymSeq[];                       // vol, arp, vib, mixer, noise, fixed, timer (in this order)
  sample?: Uint8Array;
}
export const MYI_SEQ_ORDER = [INST.volSeq, INST.arpSeq, INST.vibSeq, INST.mixSeq, INST.noiseSeq, INST.fixSeq, INST.timSeq] as const;

export function encodeInstrument(f: MymInstrumentFile): Uint8Array {
  const count = f.version === 3 ? 8 : 7, stride = f.version >= 2 ? 128 : 64, words = stride / 2 - 1;
  const sample = f.sample ?? new Uint8Array(0);
  const out = new Uint8Array(56 + count * stride + (f.inst[INST.sample] ? sample.length : 0));
  tag(out, 0, 'MYM0.MYI'); out[3] = 0x30 + f.version;
  out.set(f.inst.subarray(0, 48), 8);
  for (let i = 0; i < count; i++) {
    const s = f.sequences[i] ?? emptySeq();
    if (s.length > words) throw new Error(`maxYMiser: instrument sequence ${i} has more than ${words} steps`);
    const at = 56 + i * stride;
    for (let k = 0; k < words; k++) put16(out, at + k * 2, s.values[k] ?? 0);
    out[at + stride - 2] = s.length; out[at + stride - 1] = s.repeat;
  }
  if (f.inst[INST.sample]) out.set(sample, 56 + count * stride);
  return out;
}

export function decodeInstrument(d: Uint8Array): MymInstrumentFile {
  if (d.length < 56 || !hasTag(d, 0, 'MYM') || !hasTag(d, 4, '.MYI') || d[3] < 0x30 || d[3] > 0x33) throw new Error('not a maxYMiser .MYI file');
  const version = d[3] - 0x30, count = version === 3 ? 8 : 7, stride = version >= 2 ? 128 : 64;
  if (d.length < 56 + count * stride) throw new Error('maxYMiser: truncated .MYI');
  const sequences: MymSeq[] = [];
  for (let i = 0; i < count; i++) {
    const at = 56 + i * stride, length = d[at + stride - 2], repeat = d[at + stride - 1];
    sequences.push({ values: Array.from({ length: Math.min(length, stride / 2 - 1) }, (_, k) => u16(d, at + k * 2)), length, repeat });
  }
  return { version, inst: d.slice(8, 56), sequences, sample: d.length > 56 + count * stride ? d.slice(56 + count * stride) : undefined };
}
