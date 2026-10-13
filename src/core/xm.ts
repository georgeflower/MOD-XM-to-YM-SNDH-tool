import type { Cell, Instrument, Module, Sample } from './types';

const u16 = (d: DataView, o: number) => d.getUint16(o, true);
const u32 = (d: DataView, o: number) => d.getUint32(o, true);
function ascii(b: Uint8Array, off: number, len: number): string {
  let end = off + len;
  for (let i = off; i < off + len; i++) if (b[i] === 0) { end = i; break; }
  let s = '';
  for (let i = off; i < end; i++) s += String.fromCharCode(b[i]);
  return s.trim();
}

export function isXm(b: Uint8Array): boolean {
  const sig = 'Extended Module: ';
  if (b.length < 80) return false;
  for (let i = 0; i < sig.length; i++) if (b[i] !== sig.charCodeAt(i)) return false;
  return true;
}

export function parseXm(buf: Uint8Array): Module {
  if (!isXm(buf)) throw new Error('Not an XM file');
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const title = ascii(buf, 17, 20);
  const hs = u32(d, 60);
  const songlen = u16(d, 64), restart = u16(d, 66), nch = u16(d, 68), npat = u16(d, 70),
    ninst = u16(d, 72), flags = u16(d, 74), speed = u16(d, 76), bpm = u16(d, 78);
  if (!(flags & 1)) throw new Error('Amiga-frequency XM files are not supported yet (linear only)');
  const order = Array.from(buf.subarray(80, 80 + songlen));
  let off = 60 + hs;
  const patterns: Cell[][][] = [];
  for (let p = 0; p < npat; p++) {
    const plh = u32(d, off), nrows = u16(d, off + 5), psize = u16(d, off + 7);
    const data = buf.subarray(off + plh, off + plh + psize);
    let i = 0;
    const rows: Cell[][] = [];
    for (let r = 0; r < nrows; r++) {
      const row: Cell[] = [];
      for (let c = 0; c < nch; c++) {
        const cell: Cell = { note: 0, inst: 0, vol: 0, eff: 0, par: 0 };
        if (i < data.length) {
          const b = data[i++];
          if (b & 0x80) {
            if (b & 1) cell.note = data[i++];
            if (b & 2) cell.inst = data[i++];
            if (b & 4) cell.vol = data[i++];
            if (b & 8) cell.eff = data[i++];
            if (b & 16) cell.par = data[i++];
          } else {
            cell.note = b; cell.inst = data[i]; cell.vol = data[i + 1]; cell.eff = data[i + 2]; cell.par = data[i + 3]; i += 4;
          }
        }
        row.push(cell);
      }
      rows.push(row);
    }
    patterns.push(rows);
    off += plh + psize;
  }
  const instruments: (Instrument | null)[] = [null];
  for (let n = 0; n < ninst; n++) {
    const ih = u32(d, off);
    const name = ascii(buf, off + 4, 22);
    const ns = u16(d, off + 27);
    const ins: Instrument = { name, samples: [], keymap: new Array(96).fill(0), venv: [], vflags: 0, vsus: 0, vls: 0, vle: 0, fade: 0, vib: [0, 0, 0, 0] };
    if (ns > 0) {
      const shs = u32(d, off + 29);
      const b = off + 33;
      ins.keymap = Array.from(buf.subarray(b, b + 96));
      const nvp = buf[b + 192];
      for (let k = 0; k < nvp; k++) ins.venv.push([u16(d, b + 96 + 4 * k), u16(d, b + 96 + 4 * k + 2)]);
      ins.vsus = buf[b + 194]; ins.vls = buf[b + 195]; ins.vle = buf[b + 196];
      ins.vflags = buf[b + 200];
      ins.vib = [buf[b + 202], buf[b + 203], buf[b + 204], buf[b + 205]];
      ins.fade = u16(d, b + 206);
      off += ih;
      const hdrs: { sl: number; ls: number; ll: number; vol: number; fine: number; typ: number; rel: number; name: string }[] = [];
      for (let s = 0; s < ns; s++) {
        hdrs.push({
          sl: u32(d, off), ls: u32(d, off + 4), ll: u32(d, off + 8), vol: buf[off + 12],
          fine: d.getInt8(off + 13), typ: buf[off + 14], rel: d.getInt8(off + 16), name: ascii(buf, off + 18, 22),
        });
        off += shs;
      }
      for (const h of hdrs) {
        const raw = buf.subarray(off, off + h.sl);
        off += h.sl;
        let data: Float64Array;
        let ls = h.ls, ll = h.ll;
        if (h.typ & 0x10) {
          const n16 = raw.length >> 1;
          data = new Float64Array(n16);
          let acc = 0;
          for (let k = 0; k < n16; k++) {
            acc = (acc + (raw[2 * k] | (raw[2 * k + 1] << 8))) & 0xffff;
            data[k] = (acc >= 0x8000 ? acc - 0x10000 : acc) / 32768;
          }
          ls >>= 1; ll >>= 1;
        } else {
          data = new Float64Array(raw.length);
          let acc = 0;
          for (let k = 0; k < raw.length; k++) {
            acc = (acc + raw[k]) & 0xff;
            data[k] = (acc >= 0x80 ? acc - 0x100 : acc) / 128;
          }
        }
        let loop = (h.typ & 3) as 0 | 1 | 2;
        if (loop === 3 as number) loop = 0;
        if (loop && ll < 2) loop = 0;
        const smp: Sample = { name: h.name, data, ls, ll, loop, vol: h.vol, fine: h.fine, rel: h.rel };
        ins.samples.push(smp);
      }
    } else {
      off += ih;
    }
    instruments.push(ins);
  }
  return { kind: 'xm', title, nch, order, restart, patterns, instruments, speed, bpm, amiga: false };
}
