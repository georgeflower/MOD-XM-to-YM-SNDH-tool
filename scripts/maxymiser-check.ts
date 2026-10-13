// Plays a song through the real maxYMiser replayer and compares it with this editor's own render.
// usage: npx tsx scripts/maxymiser-check.ts <MYM_REPL.BIN> <module .mod/.xm | song .ymt> [frames]      (export check)
//        npx tsx scripts/maxymiser-check.ts <MYM_REPL.BIN> <song .mys> [frames] [voice .myv]           (import check)
// (MYM_REPL.BIN is part of the maxYMiser package by gwEm; it is not stored in this repository.)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadModule } from '../src/core/load';
import { moduleToSong } from '../src/tracker/fromModule';
import { decodeYmt, isYmt } from '../src/tracker/ymt';
import { renderSong } from '../src/tracker/render';
import { songToMaxymiser } from '../src/maxymiser/convert';
import { maxymiserToSong } from '../src/maxymiser/import';
import { parseSndh } from '../src/import/sndh';

const [bin, file, framesArg, voiceArg] = process.argv.slice(2);
if (!bin || !file) { console.error('usage: maxymiser-check.ts <MYM_REPL.BIN> <module|ymt> [frames]'); process.exit(2); }
const data = new Uint8Array(readFileSync(file));
const dir = mkdtempSync(join(tmpdir(), 'mym-'));
let song, m: { mys: Uint8Array; myv: Uint8Array; warnings: string[]; stats: { orders: number; patterns: number; instruments: number; sequences: number } };
if (/\.mys$/i.test(file)) {
  // import check: the real replayer plays the original files, the editor plays what the importer made of them
  const voice = new Uint8Array(readFileSync(voiceArg ?? file.replace(/\.(mys)$/i, (_m, e: string) => (e === e.toUpperCase() ? '.MYV' : '.myv'))));
  const imp = maxymiserToSong(data, voice, file);
  song = imp.song;
  m = { mys: data, myv: voice, warnings: imp.warnings, stats: { orders: imp.stats.orders, patterns: imp.stats.patterns, instruments: imp.stats.instruments, sequences: 0 } };
} else {
  song = isYmt(data) ? await decodeYmt(data) : moduleToSong(loadModule(data), {}).song;
  m = songToMaxymiser(song);
}
const ours = renderSong(song);
writeFileSync(join(dir, 's.mys'), m.mys); writeFileSync(join(dir, 's.myv'), m.myv);
execFileSync(resolve('tools/verify/maxymiser/oracle.sh'), [resolve(bin), join(dir, 's.mys'), join(dir, 's.myv'), join(dir, 's.sndh')], { stdio: 'inherit' });
const theirs = parseSndh(new Uint8Array(readFileSync(join(dir, 's.sndh'))));
const n = Math.min(+(framesArg ?? 3000), ours.nframes, theirs.nframes);
const miss: Record<string, number[]> = {};
const add = (k: string, f: number) => (miss[k] ??= []).push(f);
for (let f = 0; f < n; f++) {
  const a = ours.regs.subarray(f * 14, f * 14 + 14), b = theirs.regs.subarray(f * 14, f * 14 + 14);
  for (let c = 0; c < 3; c++) {
    const va = a[8 + c] & 31, vb = b[8 + c] & 31;
    const ta = !(a[7] & (1 << c)), tb = !(b[7] & (1 << c)), na = !(a[7] & (8 << c)), nb = !(b[7] & (8 << c));
    if (va !== vb) add(`volume ${'ABC'[c]}`, f);
    if (!va || !vb) continue;
    if (ta !== tb) add(`tone on/off ${'ABC'[c]}`, f);
    if (na !== nb) add(`noise on/off ${'ABC'[c]}`, f);
    if (ta && tb && Math.abs((a[2 * c] | ((a[2 * c + 1] & 15) << 8)) - (b[2 * c] | ((b[2 * c + 1] & 15) << 8))) > 1) add(`pitch ${'ABC'[c]}`, f);
    if (na && nb && a[6] !== b[6]) add('noise period', f);
    if (va & vb & 16) {
      if (Math.abs((a[11] | (a[12] << 8)) - (b[11] | (b[12] << 8))) > 1) add('envelope period', f);
      if (a[13] !== 0xff && b[13] !== 0xff && a[13] !== b[13]) add('envelope shape', f);
    }
  }
}
console.log(`${n} frames compared against the real replayer; ${m.stats.orders} positions, ${m.stats.patterns} patterns, ${m.stats.instruments} instruments, ${m.stats.sequences} sequences`);
const rows = Object.entries(miss).sort((x, y) => y[1].length - x[1].length);
if (!rows.length) console.log('identical');
for (const [k, v] of rows) console.log(`  ${k}: ${v.length} frame(s), first at ${v.slice(0, 5).join(', ')}`);
if (m.warnings.length) console.log('warnings:\n  ' + m.warnings.join('\n  '));
