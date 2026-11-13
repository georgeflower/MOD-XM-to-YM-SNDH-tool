import { describe, it, expect } from 'vitest';
import { isSpc, spcTags, SpcPlayer } from '../src/import/spc';
import { spcToModule } from '../src/import/spcModule';
import { convert } from '../src/core/convert';
import { loadModule } from '../src/core/load';

/**
 * A synthetic SPC (no game music in the repository): a 16-sample sine wave as a looped BRR sample on voice 0, and a small
 * SPC700 program that waits for timer 0 (50 Hz) and plays A4, C5, E5, A3, half a second each, over and over.
 */
const PITCH = [0x0385, 0x0430, 0x0546, 0x01c3];          // 7.8125 * P / 16 Hz: 440, 523, 659, 220
function buildSpc(withTags = true): Uint8Array {
  const f = new Uint8Array(0x10200);
  const sig = 'SNES-SPC700 Sound File Data v0.30';
  for (let i = 0; i < sig.length; i++) f[i] = sig.charCodeAt(i);
  f[0x21] = 26; f[0x22] = 26; f[0x23] = withTags ? 26 : 27; f[0x24] = 30;
  const ram = f.subarray(0x100, 0x10100), dsp = f.subarray(0x10100, 0x10180);
  // BRR sample at $0300, directory at $0200
  const nyb = [0, 3, 5, 6, 7, 6, 5, 3, 0, -3, -5, -6, -7, -6, -5, -3].map((v) => v & 15);
  ram[0x300] = 0xc3;                                           // range 12, filter 0, loop + end
  for (let i = 0; i < 8; i++) ram[0x301 + i] = (nyb[i * 2] << 4) | nyb[i * 2 + 1];
  ram[0x200] = 0x00; ram[0x201] = 0x03; ram[0x202] = 0x00; ram[0x203] = 0x03;
  PITCH.forEach((p, i) => { ram[0x600 + i] = p & 255; ram[0x610 + i] = p >> 8; });
  // program at $0400
  const code: number[] = [];
  const dspw = (reg: number, val: number) => code.push(0x8f, reg, 0xf2, 0x8f, val, 0xf3);
  dspw(0x0c, 0x7f); dspw(0x1c, 0x7f); dspw(0x2c, 0); dspw(0x3c, 0); dspw(0x6c, 0x20); dspw(0x5d, 0x02);
  dspw(0x00, 0x7f); dspw(0x01, 0x7f); dspw(0x04, 0); dspw(0x05, 0); dspw(0x07, 0x7f);
  code.push(0x8f, 160, 0xfa, 0x8f, 0x01, 0xf1);               // timer 0: 8 kHz / 160 = 50 Hz, on
  code.push(0xcd, 0x00);                                       // MOV X,#0
  const next = code.length;
  code.push(0x8d, 25);                                         // MOV Y,#25
  const wait = code.length;
  code.push(0xe4, 0xfd);                                       // MOV A,$FD
  code.push(0xf0, (wait - (code.length + 2)) & 255);           // BEQ wait
  code.push(0xfe, (wait - (code.length + 2)) & 255);           // DBNZ Y,wait
  code.push(0xf5, 0x00, 0x06, 0x8f, 0x02, 0xf2, 0xc4, 0xf3);   // pitch low from table
  code.push(0xf5, 0x10, 0x06, 0x8f, 0x03, 0xf2, 0xc4, 0xf3);   // pitch high
  code.push(0x8f, 0x4c, 0xf2, 0x8f, 0x01, 0xf3);               // KON voice 0
  code.push(0x3d, 0xc8, 0x04);                                 // INC X ; CMP X,#4
  code.push(0xd0, (next - (code.length + 2)) & 255);           // BNE next
  code.push(0xcd, 0x00, 0x2f, (next - (code.length + 4)) & 255); // MOV X,#0 ; BRA next
  ram.set(code, 0x400);
  f[0x25] = 0x00; f[0x26] = 0x04; f[0x2b] = 0xef;             // PC = $0400, SP
  ram[0xf1] = 0x00;
  if (withTags) {
    const put = (o: number, s: string) => { for (let i = 0; i < s.length; i++) f[o + i] = s.charCodeAt(i); };
    put(0x2e, 'Test tone'); put(0x4e, 'Synthetic'); put(0x6e, 'tests'); put(0xa9, '010'); put(0xac, '01000'); put(0xb1, 'Nobody');
  }
  return f;
}

describe('SNES SPC import', () => {
  it('recognises SPC files by content and reads the tags', () => {
    const f = buildSpc();
    expect(isSpc(f)).toBe(true);
    expect(isSpc(new Uint8Array(70000))).toBe(false);
    const t = spcTags(f);
    expect(t).toMatchObject({ title: 'Test tone', game: 'Synthetic', artist: 'Nobody', seconds: 10, fadeMs: 1000 });
    expect(spcTags(buildSpc(false)).title).toBe('');
  });

  it('the SPC700 program drives the DSP: a 440 Hz sine comes out of the emulator', () => {
    const p = new SpcPlayer(buildSpc());
    const n = 32000;
    const out = new Int16Array(n * 2);
    p.run(n, out);
    let peak = 0; for (let i = 0; i < out.length; i += 2) peak = Math.max(peak, Math.abs(out[i]));
    expect(peak).toBeGreaterThan(8000);
    // the first note starts after 0.5 s: count rising zero crossings in 0.6..0.9 s (9600 samples at 439.9 Hz = 132)
    let c = 0; for (let i = 19200; i < 28800; i++) if (out[(i - 1) * 2] < 0 && out[i * 2] >= 0) c++;
    expect(c).toBeGreaterThanOrEqual(130); expect(c).toBeLessThanOrEqual(134);
    expect(p.cpu.stopped).toBe(false);
  });

  it('becomes a module: one instrument, the four notes on voice 0, on the 50 Hz grid', () => {
    const r = spcToModule(buildSpc(), { seconds: 4 });
    const m = r.module;
    expect(m.kind).toBe('spc');
    expect(m.nch).toBe(8);
    expect(m.instruments.filter(Boolean).length).toBe(1);
    expect(m.instruments[1]!.samples[0].data.length).toBe(16);
    const notes: { row: number; note: number }[] = [];
    m.patterns.forEach((pat, pi) => pat.forEach((row, ri) => { const c = row[0]; if (c.note > 0 && c.note < 97) notes.push({ row: pi * 64 + ri, note: c.note }); }));
    expect(notes.map((n) => n.note).slice(0, 5)).toEqual([58, 61, 65, 46, 58]);      // A4 C5 E5 A3 A4
    // half a second apart = 25 frames (the first row of the song is the speed row)
    expect(notes[1].row - notes[0].row).toBeGreaterThanOrEqual(24);
    expect(notes[1].row - notes[0].row).toBeLessThanOrEqual(26);
    expect(r.info.notes[0]).toBeGreaterThanOrEqual(5);
    expect(r.info.notes.slice(1).every((x) => x === 0)).toBe(true);
    expect(r.pcm.length).toBe(4 * 50 * 640 * 2);
  });

  it('goes through the normal converter: the tone period matches the played pitch', () => {
    const r = spcToModule(buildSpc(), { seconds: 3.5 });
    const out = convert(r.module, {});
    expect(out.nframes).toBeGreaterThan(170);
    // the first note (A4, 440 Hz) starts after 0.5 s; YM tone period = 2e6 / (16 * 440) = 284
    const periods: number[] = [];
    for (let v = 0; v < 3; v++) {
      const vol = out.regs[40 * 14 + 8 + v] & 15;
      if (vol) periods.push(out.regs[40 * 14 + 2 * v] | ((out.regs[40 * 14 + 2 * v + 1] & 15) << 8));
    }
    expect(periods.some((p) => Math.abs(p - 284) <= 3)).toBe(true);
    // 4th note (from 2.0 s) is A3 (220 Hz, period 568)
    const f2 = 120;
    const p2: number[] = [];
    for (let v = 0; v < 3; v++) { const vol = out.regs[f2 * 14 + 8 + v] & 15; if (vol) p2.push(out.regs[f2 * 14 + 2 * v] | ((out.regs[f2 * 14 + 2 * v + 1] & 15) << 8)); }
    expect(p2.some((p) => Math.abs(p - 568) <= 6)).toBe(true);
  });

  it('the module loader still refuses an SPC (it has its own path) and the start offset skips ahead', () => {
    expect(() => loadModule(buildSpc())).toThrow();
    const a = spcToModule(buildSpc(), { seconds: 2, startSeconds: 0.7 });
    const first = a.module.patterns[0][2][0];
    expect(first.note).toBe(0);                    // A4 started before the start point: nothing is keyed on at the very beginning
    const notes: number[] = [];
    a.module.patterns.forEach((pat) => pat.forEach((row) => { if (row[0].note > 0 && row[0].note < 97) notes.push(row[0].note); }));
    expect(notes[0]).toBe(61);                     // C5 is the first new note
  });
});
