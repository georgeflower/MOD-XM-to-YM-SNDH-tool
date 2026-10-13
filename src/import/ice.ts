// "ICE!" depacker (Pack-Ice 2.x), used for compressed SNDH files. The stream is read backwards:
// bits come from a shift register that is refilled from the end of the packed data, and literal runs are
// raw bytes sitting in the same backward stream; the output is rebuilt from its end towards its start.

export function isIce(d: Uint8Array): boolean {
  return d.length > 12 && d[0] === 0x49 && d[1] === 0x43 && d[2] === 0x45 && d[3] === 0x21;
}

const u32 = (d: Uint8Array, p: number) => ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;

export function iceDepack(src: Uint8Array): Uint8Array {
  if (!isIce(src)) throw new Error('not an ICE! file');
  const packedSize = u32(src, 4), outSize = u32(src, 8);
  if (!packedSize || !outSize || packedSize > src.length) throw new Error('ICE: bad header');
  const out = new Uint8Array(outSize);
  let rp = packedSize - 1;            // last byte consumed so far
  let bits = src[rp];
  let w = outSize;                    // write position (decoding goes downwards)

  const bit = (): number => {
    let b = bits & 0x80 ? 1 : 0;
    bits = (bits << 1) & 0xff;
    if (bits === 0) {
      if (rp <= 0) throw new Error('ICE: truncated data');
      bits = src[--rp];
      b = bits & 0x80 ? 1 : 0;
      bits = ((bits << 1) & 0xff) + 1;
    }
    return b;
  };
  const take = (n: number): number => { let v = 0; while (n-- > 0) v = (v << 1) | bit(); return v; };

  const literalLength = (): number => {
    const width = [1, 2, 2, 3, 8, 15], full = [1, 3, 3, 7, 0xff, 0x7fff], add = [1, 2, 5, 8, 15, 270, 270];
    let i = 0, n = 0;
    for (; i < 6; i++) { n = take(width[i]); if (n !== full[i]) break; }
    return n + add[i];
  };
  const matchLength = (): number => {
    const width = [0, 0, 1, 2, 10], add = [2, 3, 4, 6, 10];
    let i = 0;
    for (; i < 4; i++) if (!bit()) break;
    return (width[i] ? take(width[i]) : 0) + add[i];
  };
  const matchOffset = (len: number): number => {
    if (len === 2) return bit() ? take(9) + 0x3f : take(6) - 1;
    const width = [8, 5, 12], add = [31, -1, 287];
    let i = 0;
    for (; i < 2; i++) if (!bit()) break;
    const off = take(width[i]) + add[i];
    return off < 0 ? off + 2 - len : off;
  };

  for (;;) {
    if (bit()) {
      const len = literalLength();
      rp -= len; w -= len;
      if (w < 0 || rp < 0) throw new Error('ICE: corrupt data');
      out.set(src.subarray(rp, rp + len), w);
    }
    if (w <= 0) return out;
    const len = matchLength();
    const off = matchOffset(len);
    w -= len;
    if (w < 0) throw new Error('ICE: corrupt data');
    // copy backwards (last byte first), so overlapping runs repeat like the original depacker
    let to = w + len, from = w + len + off + len;
    for (let n = len; n > 0; n--) out[--to] = out[--from];
  }
}
