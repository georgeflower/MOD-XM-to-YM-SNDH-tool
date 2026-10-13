// usage: tsx scripts/song-cli.ts <module> [arpFill]   — convert to a pattern song, render it, compare with the frame converter
import { readFileSync } from 'node:fs';
import { loadModule } from '../src/core/load';
import { convert } from '../src/core/convert';
import { moduleToSong } from '../src/tracker/fromModule';
import { renderSong } from '../src/tracker/render';

const file = process.argv[2];
const arp = +(process.argv[3] ?? 0);
const m = loadModule(new Uint8Array(readFileSync(file)));
const t0 = Date.now();
const ref = convert(m, { arpFill: arp });
const t1 = Date.now();
const r = moduleToSong(m, { arpFill: arp });
const t2 = Date.now();
const out = renderSong(r.song);
const t3 = Date.now();
console.log(r.report.join('\n'));
if (r.warnings.length) console.log('warnings:', r.warnings.join('; '));
console.log(`frame converter ${ref.nframes} frames (${t1 - t0} ms), song ${out.nframes} frames (convert ${t2 - t1} ms, render ${t3 - t2} ms), loop ref ${ref.loopFrame} song ${out.loopFrame}`);

// frame-by-frame similarity: for each frame the multiset of (pitch class period, level) of audible voices
const NR = 14;
const voiceSet = (regs: Uint8Array, f: number) => {
  const mix = regs[f * NR + 7];
  const v: { p: number; l: number; n: boolean }[] = [];
  for (let i = 0; i < 3; i++) {
    const l = regs[f * NR + 8 + i] & 15;
    if (!l) continue;
    const tone = !(mix & (1 << i)), noise = !(mix & (8 << i));
    if (tone) v.push({ p: regs[f * NR + 2 * i] | ((regs[f * NR + 2 * i + 1] & 15) << 8), l, n: false });
    else if (noise) v.push({ p: -1, l, n: true });
  }
  return v;
};
const n = Math.min(ref.nframes, out.nframes);
let same = 0, near = 0, levelErr = 0, cnt = 0, silentMismatch = 0;
for (let f = 0; f < n; f++) {
  const a = voiceSet(ref.regs, f), b = voiceSet(out.regs, f);
  if (a.length !== b.length) silentMismatch++;
  // tones matched greedily by period (within 3%)
  const bb = b.slice();
  for (const x of a) {
    cnt++;
    const j = bb.findIndex((y) => (x.n && y.n) || (!x.n && !y.n && Math.abs(Math.log2(x.p / y.p)) < 0.045));
    if (j >= 0) { same++; levelErr += Math.abs(x.l - bb[j].l); bb.splice(j, 1); }
  }
}
console.log(`voice events matched: ${(100 * same / Math.max(1, cnt)).toFixed(1)}%  mean level error ${(levelErr / Math.max(1, same)).toFixed(2)}  frames with different voice count: ${(100 * silentMismatch / n).toFixed(1)}%`);
