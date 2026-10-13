/**
 * Minimal ZIP reader (stored and deflated entries) for container formats such as Arkos Tracker .aks.
 * Inflating uses the platform's DecompressionStream ('deflate-raw'), as the .ymt reader does for gzip.
 */
export interface ZipEntry { name: string; data: Uint8Array }

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  void w.write(data as unknown as BufferSource).then(() => w.close()).catch(() => { /* surfaced through the reader */ });
  const reader = ds.readable.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value); n += value.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const isZip = (d: Uint8Array) => d.length >= 4 && d[0] === 0x50 && d[1] === 0x4b && d[2] === 0x03 && d[3] === 0x04;

/** every file entry of a ZIP archive (directories skipped) */
export async function unzip(d: Uint8Array): Promise<ZipEntry[]> {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  // end of central directory record: scan backwards
  let e = -1;
  for (let i = d.length - 22; i >= Math.max(0, d.length - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('not a ZIP archive (no central directory)');
  const count = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const lho = v.getUint32(p + 42, true);
    const name = dec.decode(d.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (v.getUint32(lho, true) !== 0x04034b50) throw new Error('corrupt ZIP entry');
    const start = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
    const raw = d.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: raw.slice() });
    else if (method === 8) out.push({ name, data: await inflateRaw(raw) });
    else throw new Error(`ZIP entry "${name}" uses compression method ${method}, which is not supported`);
  }
  return out;
}
