// Plays the Furnace export through a real Furnace and compares it with this editor's own render.
// usage: npx tsx scripts/furnace-check.ts <furnace executable> <module .mod/.xm | song .ymt | synth> [frames]
//   <furnace executable>  any Furnace 0.6.x build with the command line options -vgmout and -loops (it plays the .fur and writes
//                         the AY register writes as a VGM; Furnace itself is not part of this repository)
//   synth                 a small built-in song with arpeggio, slide, vibrato and a buzzer instead of a file
// It prints, over the first `frames` frames (default 3000), how many audible voice-frames differ in level, pitch or tone / noise mix.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadModule } from '../src/core/load';
import { moduleToSong } from '../src/tracker/fromModule';
import { decodeYmt, isYmt } from '../src/tracker/ymt';
import { renderSong } from '../src/tracker/render';
import { songToFur } from '../src/furnace/fur';
import { newSong, emptyPattern, defaultInstrument, parseEffectChar, type Song } from '../src/tracker/types';

const [bin, file, framesArg] = process.argv.slice(2);
if (!bin || !file) { console.error('usage: furnace-check.ts <furnace executable> <module|ymt|synth> [frames]'); process.exit(2); }

const c = (note: number, instrument = 0, effect = '', param = 0) => ({ note, instrument, volume: 0, effect: effect ? parseEffectChar(effect) : 0, param });
function synth(): Song {
  const s = newSong(3);
  s.patterns = [emptyPattern(32, 3)];
  s.instruments[1] = { ...defaultInstrument('lead'), adsr: { useAdsr: true, attack: 0, decay: 6, sustain: 9, release: 6 } };
  s.instruments[2] = { ...defaultInstrument('buzz'), useHardEnv: true, hardEnvShape: 8, toneEnabled: false };
  const p = s.patterns[0].cells;
  p[0][0] = c(49, 1, '0', 0x37); p[8][0] = c(53, 1, '1', 0x04); p[12][0] = c(0, 0, '4', 0x46); p[20][0] = c(97);
  p[0][1] = c(37, 2); p[16][1] = c(44, 2);
  p[4][2] = c(61, 1); p[10][2] = c(64, 1, '3', 0x08);
  return s;
}

const data = file === 'synth' ? null : new Uint8Array(readFileSync(file));
const song = !data ? synth() : isYmt(data) ? await decodeYmt(data) : moduleToSong(loadModule(data), { arpFill: 3 }).song;
const fur = songToFur(song, { title: 'check' });
const dir = mkdtempSync(join(tmpdir(), 'fur-'));
writeFileSync(join(dir, 'x.fur'), fur.bytes);
execFileSync(bin, ['-loglevel', 'error', '-vgmout', join(dir, 'x.vgm'), '-loops', '0', join(dir, 'x.fur')], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });

// VGM -> one 14-register snapshot per tick
const hz = song.bpm * 0.4, spt = 44100 / hz;
const v = readFileSync(join(dir, 'x.vgm'));
let p = 0x34 + v.readUInt32LE(0x34), t = 0;
const cur = new Uint8Array(14), frames: Uint8Array[] = [];
const snap = (upTo: number) => { while ((frames.length + 1) * spt <= upTo + 1e-6) frames.push(Uint8Array.from(cur)); };
while (p < v.length) {
  const cmd = v[p++];
  if (cmd === 0xa0) { const r = v[p++], d = v[p++]; snap(t); if (r < 14) cur[r] = d; }
  else if (cmd === 0x61) { t += v.readUInt16LE(p); p += 2; }
  else if (cmd === 0x62) t += 735; else if (cmd === 0x63) t += 882;
  else if (cmd >= 0x70 && cmd <= 0x7f) t += (cmd & 15) + 1;
  else if (cmd === 0x66) break;
  else if (cmd === 0x4f || cmd === 0x50 || (cmd >= 0x30 && cmd <= 0x3f)) p += 1;
  else if ((cmd >= 0x51 && cmd <= 0x5f) || (cmd >= 0xa1 && cmd <= 0xaf)) p += 2;
  else if (cmd === 0x67) { p += 2; p += 4 + v.readUInt32LE(p); }
  else throw new Error(`unknown VGM command ${cmd.toString(16)}`);
}
snap(t + spt);

const ours = renderSong(song);
const n = Math.min(+(framesArg ?? 3000), ours.nframes, frames.length);
let aud = 0, lvl = 0, pitch = 0, mix = 0;
for (let f = 0; f < n; f++) {
  const x = ours.regs.subarray(f * 14, f * 14 + 14), y = frames[f];
  for (let ch = 0; ch < 3; ch++) {
    const la = x[8 + ch] & 16 ? 15 : x[8 + ch] & 15, lb = y[8 + ch] & 16 ? 15 : y[8 + ch] & 15;
    if (!la && !lb) continue;
    aud++;
    if (Math.abs(la - lb) > 2) lvl++;
    const ta = !(x[7] & (1 << ch)), tb = !(y[7] & (1 << ch));
    if (ta !== tb) { mix++; continue; }
    if (ta && la && lb) {
      const pa = x[2 * ch] | ((x[2 * ch + 1] & 15) << 8), pb = y[2 * ch] | ((y[2 * ch + 1] & 15) << 8);
      if (Math.abs(pa - pb) / Math.max(1, pa) > 0.02) pitch++;
    }
  }
}
const pc = (k: number) => `${k} (${aud ? ((100 * k) / aud).toFixed(1) : '0'}%)`;
console.log(`${n} frames, ${fur.stats.instruments} instruments, ${fur.stats.patterns} patterns; ${aud} audible voice-frames`);
console.log(`  level differs by more than 2 steps: ${pc(lvl)}`);
console.log(`  pitch differs by more than 2 %:     ${pc(pitch)}`);
console.log(`  tone / noise mix differs:           ${pc(mix)}`);
for (const w of fur.warnings) console.log(`  warning: ${w}`);
