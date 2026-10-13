// LHA archive reader for the single-file archives that .ym files are wrapped in (-lh0-, -lh4-..-lh7-).

class Bits {
  private pos: number;
  private buf = 0; // up to 32 bits, MSB first
  private n = 0;
  constructor(private d: Uint8Array, start: number) { this.pos = start; }
  /** peek `k` (<=16) bits without consuming */
  peek(k: number): number {
    while (this.n < k) { this.buf = (this.buf << 8 | (this.pos < this.d.length ? this.d[this.pos] : 0)) >>> 0; this.pos++; this.n += 8; }
    return (this.buf >>> (this.n - k)) & ((1 << k) - 1);
  }
  skip(k: number) { this.peek(k); this.n -= k; this.buf &= this.n ? (2 ** this.n - 1) : 0; }
  get(k: number): number { if (!k) return 0; const v = this.peek(k); this.skip(k); return v; }
  bit(): number { return this.get(1); }
}

interface Huff { constant: number; lens: Uint8Array; count: Uint16Array; sorted: Uint16Array }

function makeHuff(lens: Uint8Array): Huff {
  const count = new Uint16Array(18);
  for (const l of lens) if (l) count[l]++;
  const offs = new Uint16Array(18);
  for (let l = 1; l < 17; l++) offs[l + 1] = offs[l] + count[l];
  const sorted = new Uint16Array(lens.length);
  for (let s = 0; s < lens.length; s++) if (lens[s]) sorted[offs[lens[s]]++] = s;
  return { constant: -1, lens, count, sorted };
}

function decodeSym(h: Huff, b: Bits): number {
  if (h.constant >= 0) return h.constant;
  let code = 0, first = 0, index = 0;
  for (let len = 1; len <= 16; len++) {
    code |= b.bit();
    const c = h.count[len];
    if (code - c < first) return h.sorted[index + (code - first)];
    index += c; first += c; first <<= 1; code <<= 1;
  }
  throw new Error('LHA: corrupt Huffman data');
}

const NC = 510, NT = 19, THRESHOLD = 3;

function readPtLen(b: Bits, nn: number, nbit: number, iSpecial: number): Huff {
  const n = b.get(nbit);
  if (n === 0) { const h = makeHuff(new Uint8Array(nn)); h.constant = b.get(nbit); return h; }
  const len = new Uint8Array(nn);
  let i = 0;
  while (i < n) {
    let c = b.peek(3);
    if (c === 7) { let mask = 1 << 12; const v = b.peek(16); while (v & mask) { mask >>= 1; c++; } }
    b.skip(c < 7 ? 3 : c - 3);
    len[i++] = c;
    if (i === iSpecial) { let k = b.get(2); while (k-- > 0) len[i++] = 0; }
  }
  return makeHuff(len);
}

function readCLen(b: Bits, pt: Huff): Huff {
  const n = b.get(9);
  if (n === 0) { const h = makeHuff(new Uint8Array(NC)); h.constant = b.get(9); return h; }
  const len = new Uint8Array(NC);
  let i = 0;
  while (i < n) {
    let c = decodeSym(pt, b);
    if (c <= 2) {
      if (c === 0) c = 1; else if (c === 1) c = b.get(4) + 3; else c = b.get(9) + 20;
      while (c-- > 0) len[i++] = 0;
    } else len[i++] = c - 2;
  }
  return makeHuff(len);
}

function unpackLh(data: Uint8Array, start: number, origSize: number, dicBit: number): Uint8Array {
  const np = dicBit + 1, pbit = dicBit === 13 ? 4 : 5;
  const b = new Bits(data, start);
  const out = new Uint8Array(origSize);
  let loc = 0, blockSize = 0, cH!: Huff, pH!: Huff;
  while (loc < origSize) {
    if (blockSize === 0) {
      blockSize = b.get(16);
      const pt = readPtLen(b, NT, 5, 3);
      cH = readCLen(b, pt);
      pH = readPtLen(b, np, pbit, -1);
    }
    blockSize--;
    const c = decodeSym(cH, b);
    if (c < 256) out[loc++] = c;
    else {
      const len = c - 256 + THRESHOLD;
      let j = decodeSym(pH, b);
      if (j) j = (1 << (j - 1)) + b.get(j - 1);
      let src = loc - j - 1;
      for (let k = 0; k < len && loc < origSize; k++, src++) out[loc++] = src >= 0 ? out[src] : 0x20;
    }
  }
  return out;
}

export function isLha(d: Uint8Array): boolean {
  return d.length > 24 && d[2] === 0x2d && d[3] === 0x6c && d[4] === 0x68 && d[6] === 0x2d;
}

/** extract the first file of an LHA archive */
export function lhaExtract(d: Uint8Array): { name: string; data: Uint8Array } {
  if (!isLha(d)) throw new Error('not an LHA archive');
  const method = String.fromCharCode(d[3], d[4], d[5]);                       // lh5 etc.
  const level = d[20];
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let packed = dv.getUint32(7, true);
  const orig = dv.getUint32(11, true);
  let dataStart: number, name = '';
  if (level === 0) {
    const hs = d[0];
    const nl = d[21];
    name = String.fromCharCode(...d.subarray(22, 22 + nl));
    dataStart = hs + 2;
  } else if (level === 1) {
    const nl = d[21];
    name = String.fromCharCode(...d.subarray(22, 22 + nl));
    let p = 22 + nl + 2 + 1;                                                    // crc16 + OS id
    let ext = dv.getUint16(p, true); p += 2;
    while (ext) { packed -= ext; p += ext - 2; ext = dv.getUint16(p, true); p += 2; }
    dataStart = p - 0;
    // level-1 header: after the first-extension size field the skip size counts the extended headers
    dataStart = p;
  } else if (level === 2) {
    dataStart = dv.getUint16(0, true);
  } else throw new Error(`LHA header level ${level} is not supported`);
  if (method === 'lh0') return { name, data: d.slice(dataStart, dataStart + orig) };
  const dic = { lh4: 12, lh5: 13, lh6: 15, lh7: 16 }[method as 'lh4'];
  if (!dic) throw new Error(`LHA method -${method}- is not supported`);
  return { name, data: unpackLh(d, dataStart, orig, dic) };
}
