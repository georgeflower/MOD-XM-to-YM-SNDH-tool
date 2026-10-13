import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadModule } from '../src/core/load';
import { convert } from '../src/core/convert';
import { packStream, unpackStream } from '../src/export/stream';
import { writeYm5 } from '../src/export/ym';
import { renderYm } from '../src/export/ymemu';

const mod = loadModule(new Uint8Array(readFileSync('fixtures/OLGIENG.XM')));
const res = convert(mod, {});

describe('exporters', () => {
  it('stream round-trips bit-exact', () => {
    const { data } = packStream(res.regs, res.nframes, res.loopFrame);
    const back = unpackStream(data, res.nframes);
    expect(Buffer.from(back).equals(Buffer.from(res.regs))).toBe(true);
  });
  it('stream matches the python packer size', () => {
    const { data } = packStream(res.regs, res.nframes, res.loopFrame);
    expect(data.length).toBeGreaterThan(1000);
  });
  it('YM5 header is well formed', () => {
    const ym = writeYm5(res.regs, res.nframes, res.loopFrame, 't', 'a', 'c');
    expect(Buffer.from(ym.subarray(0, 4)).toString()).toBe('YM5!');
    expect(Buffer.from(ym.subarray(ym.length - 4)).toString()).toBe('End!');
  });
  it('emulator output is finite and non-silent', () => {
    const pcm = renderYm(res.regs.subarray(0, 14 * 500), 500);
    let pk = 0;
    for (const v of pcm) { expect(Number.isFinite(v)).toBe(true); pk = Math.max(pk, Math.abs(v)); }
    expect(pk).toBeGreaterThan(0.01);
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync as wf, readFileSync as rf } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCHeader } from '../src/export/cheader';
import { replayerHeader } from '../src/export/replayer';
import { writeSndh } from '../src/export/sndh';

describe('game replayer', () => {
  it('C replayer reproduces the register image (host gcc)', () => {
    const { data, loopOffset } = packStream(res.regs, res.nframes, res.loopFrame);
    const dir = mkdtempSync(join(tmpdir(), 'ymplay-'));
    wf(join(dir, 'song.h'), writeCHeader('song', data, res.nframes, res.loopFrame, loopOffset));
    wf(join(dir, 'ymplay.h'), replayerHeader('song'));
    wf(join(dir, 't.c'), `#include <stdio.h>
#include "song.h"
#include "ymplay.h"
int main(void){ int f; ymplay_start(song_data, SONG_FRAMES, SONG_LOOP_FRAME, SONG_LOOP_OFFSET);
  for (f = 0; f < SONG_FRAMES + 50; f++) { ymplay_step(); fwrite(ymplay_reg, 1, 14, stdout); } return 0; }`);
    execFileSync('gcc', ['-O1', '-o', join(dir, 't'), join(dir, 't.c')]);
    const out = execFileSync(join(dir, 't'), { maxBuffer: 1 << 28 });
    expect(Buffer.from(res.regs).equals(out.subarray(0, res.nframes * 14))).toBe(true);
    // wrap-around: after the end we are back at the loop frame
    const lf = res.loopFrame;
    expect(out.subarray(res.nframes * 14, (res.nframes + 5) * 14).equals(Buffer.from(res.regs.subarray(lf * 14, (lf + 5) * 14)))).toBe(true);
  });
  it('SNDH header is well formed', () => {
    const s = writeSndh(res.regs, res.nframes, res.loopFrame, { title: 'T', author: 'A' });
    expect(Buffer.from(s.subarray(12, 16)).toString()).toBe('SNDH');
    expect(s.length % 2).toBe(0);
    const text = Buffer.from(s.subarray(0, 120)).toString('latin1');
    expect(text).toContain('HDNS');
    expect(text).toContain('TC50');
  });
});
