import type { Cell, Instrument, Module, Sample } from './types';
import { PT_NOTE_BASE, periodToIndex } from './pitch';

function chansFromTag(tag: string): number {
  if (tag === 'M.K.' || tag === 'M!K!' || tag === 'FLT4' || tag === '4CHN' || tag === 'N.T.') return 4;
  if (tag === '6CHN') return 6;
  if (tag === '8CHN' || tag === 'OCTA' || tag === 'CD81' || tag === 'FLT8') return 8;
  let m = /^(\d\d)CH$/.exec(tag);
  if (m) return parseInt(m[1], 10);
  m = /^(\d)CHN$/.exec(tag);
  if (m) return parseInt(m[1], 10);
  return 0;
}

export function isMod(b: Uint8Array): boolean {
  if (b.length < 1084) return false;
  const tag = String.fromCharCode(b[1080], b[1081], b[1082], b[1083]);
  return chansFromTag(tag) > 0;
}

function ascii(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = off; i < off + len; i++) { if (b[i] === 0) break; s += String.fromCharCode(b[i]); }
  return s.trim();
}

export function parseMod(buf: Uint8Array): Module {
  if (!isMod(buf)) throw new Error('Not a 31-sample ProTracker MOD (M.K./xCHN/xxCH)');
  const tag = String.fromCharCode(buf[1080], buf[1081], buf[1082], buf[1083]);
  const nch = chansFromTag(tag);
  const title = ascii(buf, 0, 20);
  const hdr: { name: string; len: number; ft: number; vol: number; ls: number; ll: number }[] = [];
  for (let i = 0; i < 31; i++) {
    const o = 20 + i * 30;
    const ft = buf[o + 24] & 15;
    hdr.push({
      name: ascii(buf, o, 22), len: ((buf[o + 22] << 8) | buf[o + 23]) * 2, ft: ft > 7 ? ft - 16 : ft,
      vol: Math.min(64, buf[o + 25]), ls: ((buf[o + 26] << 8) | buf[o + 27]) * 2, ll: ((buf[o + 28] << 8) | buf[o + 29]) * 2,
    });
  }
  const songlen = Math.min(128, buf[950]);
  const restartRaw = buf[951];
  const orderAll = Array.from(buf.subarray(952, 952 + 128));
  const order = orderAll.slice(0, songlen);
  const npat = Math.max(...orderAll) + 1;
  let off = 1084;
  const patterns: Cell[][][] = [];
  for (let p = 0; p < npat; p++) {
    const rows: Cell[][] = [];
    for (let r = 0; r < 64; r++) {
      const row: Cell[] = [];
      for (let c = 0; c < nch; c++) {
        const b0 = buf[off] ?? 0, b1 = buf[off + 1] ?? 0, b2 = buf[off + 2] ?? 0, b3 = buf[off + 3] ?? 0;
        off += 4;
        const period = ((b0 & 15) << 8) | b1;
        row.push({
          note: period ? PT_NOTE_BASE + periodToIndex(period) : 0,
          inst: (b0 & 0xf0) | (b2 >> 4), vol: 0, eff: b2 & 15, par: b3,
        });
      }
      rows.push(row);
    }
    patterns.push(rows);
  }
  const instruments: (Instrument | null)[] = [null];
  for (let i = 0; i < 31; i++) {
    const h = hdr[i];
    const raw = buf.subarray(off, Math.min(buf.length, off + h.len));
    off += h.len;
    const data = new Float64Array(raw.length);
    for (let k = 0; k < raw.length; k++) data[k] = (raw[k] > 127 ? raw[k] - 256 : raw[k]) / 128;
    const looped = h.ll > 2;
    const smp: Sample = {
      name: h.name, data, ls: h.ls, ll: h.ll, loop: looped ? 1 : 0, vol: h.vol, fine: 0, rel: 0, modFine: h.ft,
    };
    instruments.push({
      name: h.name, samples: data.length ? [smp] : [], keymap: new Array(96).fill(0), venv: [], vflags: 0,
      vsus: 0, vls: 0, vle: 0, fade: 0, vib: [0, 0, 0, 0],
    });
  }
  return {
    kind: 'mod', title, nch, order, restart: restartRaw < songlen ? restartRaw : 0, patterns, instruments,
    speed: 6, bpm: 125, amiga: true,
  };
}
