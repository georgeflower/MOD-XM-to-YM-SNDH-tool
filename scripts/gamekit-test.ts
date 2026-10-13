// generates the game kit (song.h + ymplay.h) for the drum test song plus the reference per-frame dump,
// then tools/verify/gamekit_check.sh compiles a host test against it:  npx tsx scripts/gamekit-test.ts <outdir>
import { writeFileSync } from 'node:fs';
import { newSong, emptyPattern, parseEffectChar } from '../src/tracker/types';
import { renderSong } from '../src/tracker/render';
import { packStream } from '../src/export/stream';
import { packDrumTable } from '../src/export/drumtable';
import { writeCHeader } from '../src/export/cheader';
import { replayerHeader } from '../src/export/replayer';
import { starterKit, compactDrums } from '../src/core/drums';
import { writeSndh } from '../src/export/sndh';
import { fxEvents, fxHzOf, fxKindOf } from '../src/core/fx';
const dir = process.argv[2];
const s = newSong(4); s.drumChannel = 3;
s.patterns[0] = emptyPattern(32, 4);
s.instruments[1].digiDrums = starterKit(8000);
const c = (note: number, instrument = 0, effect = 0, param = 0) => ({ note, instrument, volume: 0, effect, param });
s.patterns[0].cells[0][0] = c(49, 1);
s.patterns[0].cells[0][3] = c(1, 1);
s.patterns[0].cells[8][1] = c(0, 1, parseEffectChar('Z'), 2);
s.patterns[0].cells[16][3] = c(3, 1);
s.patterns[0].cells[17][3] = c(2, 0);
s.patterns[0].cells[16][0] = c(49, 1, parseEffectChar('Q'), 0x34);   // SID voice starting in the frame of a drum trigger
s.patterns[0].cells[24][0] = c(49, 1);                                // ... and ending with a plain note
const r = renderSong(s);
const loop = Math.max(0, r.loopFrame);
const d = compactDrums(r.drums!);
const p = packStream(r.regs, r.nframes, loop, d, r.fx);
writeFileSync(`${dir}/song.h`, writeCHeader('song', p.data, r.nframes, loop, p.loopOffset, packDrumTable(d.drums)));
writeFileSync(`${dir}/ymplay.h`, replayerHeader('song', true, true));
let ref = '';
for (let f = 0; f < r.nframes; f++) {
  ref += `${f} ${d.trig[f]}`;
  for (let k = 0; k < 14; k++) ref += ' ' + (k === 13 && r.regs[f * 14 + 13] === 0xff ? 255 : r.regs[f * 14 + k]);
  ref += '\n';
}
writeFileSync(`${dir}/expected.txt`, ref);
writeFileSync(`${dir}/combo.sndh`, writeSndh(r.regs, r.nframes, loop, { title: 'combo', author: 'test', seconds: 12 }, r.drums, r.fx));
writeFileSync(`${dir}/combo.regs`, r.regs);
console.log(r.nframes, 'frames', JSON.stringify(fxEvents(r.fx!, r.nframes, loop).map((e) => [e.frame, fxKindOf(e.state), Math.round(fxHzOf(e.state))])));
