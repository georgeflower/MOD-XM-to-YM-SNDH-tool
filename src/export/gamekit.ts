// Game kit: packed stream + C header (+ digidrum table) + ymplay.h replayer (with the drum engine when needed).
import { packStream } from './stream';
import { packDrumTable } from './drumtable';
import { writeCHeader } from './cheader';
import { replayerHeader } from './replayer';
import { type DrumTrack, compactDrums, hasDrums } from '../core/drums';
import { type FxTrack, hasFx } from '../core/fx';

export function gameKitFiles(base: string, regs: Uint8Array, nframes: number, loopFrame: number, drumTrack?: DrumTrack | null, fxTrack?: FxTrack | null): { name: string; data: string }[] {
  const dt = hasDrums(drumTrack) ? compactDrums(drumTrack) : null;
  const fx = hasFx(fxTrack) ? fxTrack : null;
  const p = packStream(regs, nframes, loopFrame, dt, fx);
  const table = dt ? packDrumTable(dt.drums) : null;
  const n = base.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const readme = [
    `Packed YM2149 stream, ${nframes} frames @ 50 Hz, ${p.data.length} bytes${table ? `, ${dt!.drums.length} digidrum(s), table ${table.length} bytes` : ''}.`,
    'See the comment at the top of ymplay.h.',
    '',
    table
      ? `Digidrums: call ymdrum_init(${n}_drums) once and ymdrum_exit() at the end, both in supervisor mode.\n` +
        'They use MFP Timer D (vector $110, level 6); nothing else may use Timer D while the music plays.\n' +
        'Call ymplay_step(); ymplay_write(); every 50 Hz tick from supervisor mode. ymplay_write() leaves the volume\n' +
        'register of the voice that plays a drum alone; if you write the PSG yourself, do the same (see ymdrum_busy()).\n'
      : 'No digidrums in this song.\n',
    fx
      ? 'Timer effects (Q SID voice / S sinus-SID / U sync-buzzer): the same engine as the digidrums, on MFP Timer A (vector $134,\n' +
        `level 6; nothing else may use Timer A). Call ymdrum_init(${table ? n + '_drums' : '0'}) once and ymdrum_exit() at the end, both in supervisor mode.\n` +
        'ymplay_write() keeps the register shadow the interrupt needs and leaves the volume register of the voice an effect drives\n' +
        'alone (ymfx_voice()); if you write the PSG yourself see ymplay_write(). Only one effect runs at a time.\n'
      : 'No timer effects in this song.\n',
  ].join('\n');
  return [
    { name: `${base}.h`, data: writeCHeader(base, p.data, nframes, loopFrame, p.loopOffset, table) },
    { name: 'ymplay.h', data: replayerHeader(base, !!table, !!fx) },
    { name: 'README.txt', data: readme },
  ];
}
