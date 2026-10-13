// builds a small song with Q / S / U timer effects for the SNDH check: npx tsx scripts/fx-test.ts <outdir>
import { writeFileSync } from 'node:fs';
import { newSong, emptyPattern, parseEffectChar } from '../src/tracker/types';
import { renderSong } from '../src/tracker/render';
import { writeSndh } from '../src/export/sndh';
import { fxEvents, fxKindOf, fxHzOf } from '../src/core/fx';
const dir = process.argv[2];
const s = newSong(3);
s.patterns[0] = emptyPattern(48, 3);
s.speed = 6; s.bpm = 125;
s.instruments[2].useHardEnv = true; s.instruments[2].hardEnvShape = 12; s.instruments[2].hardEnvAutoPeriod = false; s.instruments[2].hardEnvPeriod = 2000;
const c = (note: number, instrument = 0, effect = 0, param = 0) => ({ note, instrument, volume: 0, effect, param });
const E = parseEffectChar;
s.patterns[0].cells[0][0] = c(49, 1, E('Q'), 0x34);     // SID voice, rows 0..7
s.patterns[0].cells[8][0] = c(49, 1);                   // plain note ends it
s.patterns[0].cells[12][1] = c(49, 1, E('S'), 0x24);    // sinus-SID on voice B, rows 12..23
s.patterns[0].cells[24][1] = c(49, 1);
s.patterns[0].cells[28][2] = c(49, 2, E('U'), 0x28);    // sync-buzzer on voice C
s.patterns[0].cells[40][2] = c(49, 2);
const r = renderSong(s);
writeFileSync(`${dir}/fx.regs`, r.regs);
writeFileSync(`${dir}/fx.sndh`, writeSndh(r.regs, r.nframes, Math.max(0, r.loopFrame), { title: 'fx', author: 'test', seconds: 12 }, r.drums, r.fx));
const ev = fxEvents(r.fx!, r.nframes, Math.max(0, r.loopFrame));
writeFileSync(`${dir}/fx.json`, JSON.stringify({ nframes: r.nframes, loop: Math.max(0, r.loopFrame), events: ev.map((e) => ({ frame: e.frame, kind: fxKindOf(e.state), hz: fxHzOf(e.state) })) }));
console.log(r.nframes, 'frames', JSON.stringify(ev.map((e) => [e.frame, fxKindOf(e.state), Math.round(fxHzOf(e.state))])), r.warnings.join('; '));
