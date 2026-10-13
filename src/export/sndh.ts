// SNDH writer: header (bra.w x3 + tags) + position independent 68000 player + packed register stream.
import { PLAYER_BLOB } from '../player68k/blob';
import { packStream } from './stream';
import { packDrumTable } from './drumtable';
import { type DrumTrack, compactDrums, hasDrums } from '../core/drums';

export interface SndhMeta {
  title: string;
  author: string;
  converter?: string;
  year?: string;
  /** play time written to the TIME tag; defaults to the song length */
  seconds?: number;
}

function z(s: string): number[] {
  const o: number[] = [];
  for (const ch of s) { const c = ch.codePointAt(0)!; o.push(c < 256 ? c : 63); }
  o.push(0);
  return o;
}
const ascii = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));

export function writeSndh(
  regs: Uint8Array, nframes: number, loopFrame: number, meta: SndhMeta, drumTrack?: DrumTrack | null,
): Uint8Array {
  const drums = hasDrums(drumTrack) ? compactDrums(drumTrack) : null;
  const { data, loopOffset } = packStream(regs, nframes, loopFrame, drums);
  const table = drums ? packDrumTable(drums.drums) : new Uint8Array(0);
  const seconds = meta.seconds ?? Math.max(1, Math.round(nframes / 50));
  const tags: number[] = [];
  const even = () => { if (tags.length & 1) tags.push(0); }; // tags start at offset 12 (even)
  const str = (tag: string, value: string) => { tags.push(...ascii(tag), ...z(value)); even(); };
  tags.push(...ascii('SNDH'));
  str('TITL', meta.title);
  str('COMM', meta.author);
  str('CONV', meta.converter ?? 'MOD-XM-to-YM-SNDH-tool');
  str('YEAR', meta.year ?? String(new Date().getFullYear()));
  str('##01', '');
  str('TC50', '');
  tags.push(...ascii('TIME'), (seconds >> 8) & 255, seconds & 255);
  tags.push(...ascii('HDNS'));
  while ((12 + tags.length) & 1) tags.push(0); // keep the player even aligned
  const codeStart = 12 + tags.length; // the tags array includes the 'SNDH' magic at offset 12
  const blob = PLAYER_BLOB;
  const dataEnd = blob.length + data.length + ((blob.length + data.length) & 1);   // the drum table starts word aligned
  const total = codeStart + dataEnd + table.length;
  const out = new Uint8Array(total + (total & 1));
  const dv = new DataView(out.buffer);
  // header branches (bra.w displacement is relative to the displacement word)
  for (let i = 0; i < 3; i++) {
    dv.setUint16(i * 4, 0x6000);
    dv.setInt16(i * 4 + 2, codeStart + i * 4 - (i * 4 + 2));
  }
  out.set(tags, 12);
  out.set(blob, codeStart);
  const pv = new DataView(out.buffer, codeStart);
  pv.setUint16(12, nframes);
  pv.setUint16(14, nframes - loopFrame);
  pv.setUint32(16, loopOffset);
  out.set(data, codeStart + blob.length);
  if (table.length) { pv.setUint32(20, dataEnd); out.set(table, codeStart + dataEnd); }
  return out;
}
