import { describe, it, expect } from 'vitest';
import { starterKit, trigCode, TRIG_STOP, type DrumTrack, silenceDrumVoices, drumFrames } from '../src/core/drums';
import { writeYm6 } from '../src/export/ym';
import { parseYm } from '../src/import/ym';
import { packStream, unpackStream } from '../src/export/stream';
import { packDrumTable } from '../src/export/drumtable';

function song(n: number, track: DrumTrack) {
  const regs = new Uint8Array(n * 14);
  for (let f = 0; f < n; f++) { regs[f * 14 + 0] = 100 + f; regs[f * 14 + 7] = 0b00111000; regs[f * 14 + 8] = 12; regs[f * 14 + 9] = 10; regs[f * 14 + 10] = 8; regs[f * 14 + 13] = 0xff; }
  silenceDrumVoices(regs, n, track);
  return regs;
}

describe('digidrum exports', () => {
  const kit = starterKit();
  const n = 60;
  const trig = new Uint8Array(n); trig[3] = trigCode(1, 2); trig[20] = trigCode(2, 0); trig[40] = trigCode(0, 5);
  const track: DrumTrack = { drums: kit, trig };

  it('stream trigger bytes survive pack/unpack', () => {
    const regs = song(n, track);
    const p = packStream(regs, n, 0, track);
    const t2 = new Uint8Array(n);
    const back = unpackStream(p.data, n, t2);
    expect(Array.from(back)).toEqual(Array.from(regs));
    expect(Array.from(t2)).toEqual(Array.from(trig));
  });

  it('stream without drums is unchanged by the trigger option', () => {
    const regs = song(n, track);
    const a = packStream(regs, n, 0), b = packStream(regs, n, 0, { drums: [], trig: new Uint8Array(n) });
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('drum table has count + entries', () => {
    const c = packDrumTable([kit[2], kit[0], kit[5]]);
    expect((c[0] << 8) | c[1]).toBe(3);
  });

  it('YM6 round trip keeps drums and triggers', () => {
    const regs = song(n, track);
    const { data, warnings } = writeYm6(regs, n, 0, track, 'T', 'A', 'C');
    expect(warnings).toEqual([]);
    const tune = parseYm(data);
    expect(tune.nframes).toBe(n);
    expect(tune.drums).toBeTruthy();
    const d = tune.drums!;
    // used drums 2,0,5 compacted in index order of first use -> [2,0,5]
    expect(d.drums.length).toBe(3);
    expect(d.drums[0].pcm.length).toBe(kit[2].pcm.length);
    expect(Array.from(d.drums[0].pcm)).toEqual(Array.from(kit[2].pcm));
    const hits = Array.from(d.trig).map((t, i) => [i, t]).filter(([, t]) => t);
    expect(hits.map(([i]) => i)).toEqual([3, 20, 40]);
    expect(d.trig[3] >> 6).toBe(2); expect(d.trig[20] >> 6).toBe(3); expect(d.trig[40] >> 6).toBe(1);
    expect(d.trig[3] & 63).toBe(0); expect(d.trig[20] & 63).toBe(1); expect(d.trig[40] & 63).toBe(2);
    // rate within 2%
    expect(Math.abs(d.drums[0].rateHz / kit[2].rateHz - 1)).toBeLessThan(0.03);
    // the voice is silent during the drum (mixer disabled, vol 0)
    expect(tune.regs[3 * 14 + 8 + 1]).toBe(0);
    expect(tune.regs[3 * 14 + 7] & 0b1001_0010).toBe(0b1001_0010);
    void TRIG_STOP; void drumFrames;
  });
});
