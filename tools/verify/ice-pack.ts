// Test helper: a small greedy Pack-Ice-format *encoder* (the repo only ships the decoder).
// Streams are produced in decode order (output is rebuilt from its end), then laid out backwards.
export function icePack(data: Uint8Array): Uint8Array {
  // ---- token stream
  type Tok = { bits: [number, number][] } | { lit: Uint8Array };
  const toks: Tok[] = [];
  const bitsTok = (...b: [number, number][]) => toks.push({ bits: b });
  const bitsOf = (v: number, n: number): [number, number] => [v, n];

  const putLiteralLength = (len: number): [number, number][] => {
    const width = [1, 2, 2, 3, 8, 15], full = [1, 3, 3, 7, 0xff, 0x7fff], add = [1, 2, 5, 8, 15, 270];
    const out: [number, number][] = [];
    for (let i = 0; i < 6; i++) {
      const n = len - add[i];
      if (n >= 0 && n < full[i]) { out.push(bitsOf(n, width[i])); return out; }
      out.push(bitsOf(full[i], width[i]));
    }
    throw new Error('literal run too long');
  };
  const putMatch = (len: number, off: number): [number, number][] => {
    const out: [number, number][] = [];
    // length
    if (len === 2) out.push(bitsOf(0, 1));
    else if (len === 3) out.push(bitsOf(0b10, 2));
    else if (len <= 5) out.push(bitsOf(0b110, 3), bitsOf(len - 4, 1));
    else if (len <= 9) out.push(bitsOf(0b1110, 4), bitsOf(len - 6, 2));
    else out.push(bitsOf(0b1111, 4), bitsOf(len - 10, 10));
    // offset
    if (len === 2) {
      if (off >= 0x3f) out.push(bitsOf(1, 1), bitsOf(off - 0x3f, 9));
      else out.push(bitsOf(0, 1), bitsOf(off + 1, 6));
    } else if (off >= 31 && off < 31 + 256) out.push(bitsOf(0, 1), bitsOf(off - 31, 8));
    else if (off >= 0 && off < 31) out.push(bitsOf(0b10, 2), bitsOf(off + 1, 5));
    else out.push(bitsOf(0b11, 2), bitsOf(off - 287, 12));
    return out;
  };

  let pos = data.length;
  let litEnd = pos;                         // pending literal block is data[pos..litEnd)
  const flushLiteral = () => {
    const n = litEnd - pos;
    if (n > 0) { bitsTok(bitsOf(1, 1), ...putLiteralLength(n)); toks.push({ lit: data.slice(pos, litEnd) }); }
    else bitsTok(bitsOf(0, 1));
    litEnd = pos;
  };
  const maxLit = 33000;
  while (pos > 0) {
    // find the best match for the block ending at pos (going downwards), source later in the data
    let bestLen = 0, bestOff = 0;
    // the block data[pos-len, pos) equals the bytes D = len + off above it, i.e. data[x] == data[x + D]
    // for x = pos-len .. pos-1: a run of equality ending at pos-1, walking downwards
    for (let D = 2; D <= 4382 + 1033 && pos - 1 + D < data.length; D++) {
      let run = 0;
      while (run < 1033 && pos - 1 - run >= 0 && data[pos - 1 - run] === data[pos - 1 - run + D]) run++;
      const len = Math.min(run, D);
      if (len < 2) continue;
      const off = D - len;
      if (len === 2 ? off > 574 : off > 4382) continue;
      if (len > bestLen) { bestLen = len; bestOff = off; }
    }
    if (bestLen >= 3 || (bestLen === 2 && bestOff < 574)) {
      flushLiteral();
      bitsTok(...putMatch(bestLen, bestOff));
      pos -= bestLen; litEnd = pos;
    } else {
      pos--;
      if (litEnd - pos >= maxLit) { flushLiteral(); }
      continue;
    }
  }
  // end: the decoder expects (literal flag [+ literal]) and then stops because the output is complete
  flushLiteral();
  // after a match ending exactly at 0 the decoder reads the literal flag bit once more, we just emitted it.

  // ---- lay out bytes in decode order
  const order: number[] = [];                // decode-order bytes: slots hold bit payload, literals raw
  const slots: { idx: number; bits: number[] }[] = [];
  let curSlot: { idx: number; bits: number[] } | null = null;
  const initial = { idx: 0, bits: [] as number[] }; order.push(0); slots.push(initial);
  // initial byte carries 0 payload bits (just the sentinel 0x80), first read refills
  initial.bits = [];
  let left = 0;
  const litChunks: { at: number; data: Uint8Array }[] = [];
  for (const t of toks) {
    if ('bits' in t) {
      for (const [v, n] of t.bits) for (let i = n - 1; i >= 0; i--) {
        if (left === 0) { curSlot = { idx: order.length, bits: [] }; order.push(0); slots.push(curSlot); left = 8; }
        curSlot!.bits.push((v >> i) & 1); left--;
      }
    } else { litChunks.push({ at: order.length, data: t.lit }); for (let i = 0; i < t.lit.length; i++) order.push(0); }
  }
  // memory layout: decode-order byte j (0-based) lives at M[S-1-j]; a literal block of L bytes occupies
  // M[ptr-L .. ptr) forward, i.e. decode positions j..j+L-1 hold the block bytes in *reverse* memory order
  const S = order.length;
  const M = new Uint8Array(S);
  for (const s of slots) {
    let b = 0;
    if (s === initial) b = 0x80;                      // sentinel only
    else { for (let i = 0; i < 8; i++) b = (b << 1) | (s.bits[i] ?? 0); }
    M[S - 1 - s.idx] = b;
  }
  for (const c of litChunks) {
    // block occupies M[S-1-(at+L-1) .. S-1-at] forward
    const L = c.data.length;
    M.set(c.data, S - 1 - (c.at + L - 1));
  }
  const out = new Uint8Array(12 + S);
  out.set([0x49, 0x43, 0x45, 0x21]);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, 12 + S); dv.setUint32(8, data.length);
  out.set(M, 12);
  return out;
}
