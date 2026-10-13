// builds a small song with digidrums for the SNDH check: npx tsx scripts/drum-test.ts <outdir>
import { writeFileSync } from 'node:fs';
import { newSong, emptyPattern, parseEffectChar } from '../src/tracker/types';
import { renderSong } from '../src/tracker/render';
import { writeSndh } from '../src/export/sndh';
import { starterKit, compactDrums } from '../src/core/drums';
const dir = process.argv[2];
const s = newSong(4); s.drumChannel = 3;
s.patterns[0] = emptyPattern(32, 4);
s.instruments[1].digiDrums = starterKit(8000);
const c = (note: number, instrument = 0, effect = 0, param = 0) => ({ note, instrument, volume: 0, effect, param });
s.patterns[0].cells[0][0] = c(49, 1);
s.patterns[0].cells[0][3] = c(1, 1);                                   // kick on the drum channel (voice C)
s.patterns[0].cells[8][1] = c(0, 1, parseEffectChar('Z'), 2);          // snare via Z on voice B
s.patterns[0].cells[16][3] = c(3, 1);                                  // hi-hat on voice C
s.patterns[0].cells[17][3] = c(2, 0);                                  // snare cuts the hat
const r = renderSong(s);
const d = compactDrums(r.drums!);
writeFileSync(`${dir}/drums.regs`, r.regs);
writeFileSync(`${dir}/drums.json`, JSON.stringify({ nframes: r.nframes, loop: Math.max(0, r.loopFrame), trig: Array.from(r.drums!.trig), drums: d.drums.map((x) => ({ name: x.name, rate: x.rateHz, pcm: Array.from(x.pcm) })) }));
writeFileSync(`${dir}/drums.sndh`, writeSndh(r.regs, r.nframes, Math.max(0, r.loopFrame), { title: 'drums', author: 'test', seconds: 12 }, r.drums));
console.log(r.nframes, 'frames', d.drums.map((x) => `${x.name}:${x.pcm.length}@${Math.round(x.rateHz)}`).join(' '));
