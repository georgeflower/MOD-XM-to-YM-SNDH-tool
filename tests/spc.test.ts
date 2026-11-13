import { describe, it, expect } from 'vitest';
import { isSpc, spcTags, SpcPlayer } from '../src/import/spc';
import { spcToModule, findLoop, findStep } from '../src/import/spcModule';
import { replay } from '../src/core/replay';
import { convert } from '../src/core/convert';
import { loadModule } from '../src/core/load';

/**
 * A synthetic SPC (no game music in the repository): a 16-sample sine wave as a looped BRR sample on voice 0, and a small
 * SPC700 program that waits for timer 0 (50 Hz) and plays A4, C5, E5, A3, half a second each, over and over.
 */
const PITCH = [0x0385, 0x0430, 0x0546, 0x01c3];          // 7.8125 * P / 16 Hz: 440, 523, 659, 220
function buildSpc(withTags = true, echo = false): Uint8Array {
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
  dspw(0x0c, 0x7f); dspw(0x1c, 0x7f); dspw(0x5d, 0x02);
  if (echo) {
    // echo: 80 ms delay (EDL 5), buffer at $8000, first FIR tap only, EVOL half, no feedback, voice 0 echoed
    dspw(0x6d, 0x80); dspw(0x7d, 5); dspw(0x0f, 0x7f); dspw(0x0d, 0); dspw(0x2c, 0x40); dspw(0x3c, 0x40); dspw(0x4d, 0x01); dspw(0x6c, 0x00);
  } else { dspw(0x2c, 0); dspw(0x3c, 0); dspw(0x6c, 0x20); }
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
    const r = spcToModule(buildSpc(), { seconds: 4, loop: false });
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
    const r = spcToModule(buildSpc(), { seconds: 3.5, loop: false });
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
    const a = spcToModule(buildSpc(), { seconds: 2, startSeconds: 0.7, loop: false });
    const first = a.module.patterns[0][2][0];
    expect(first.note).toBe(0);                    // A4 started before the start point: nothing is keyed on at the very beginning
    const notes: number[] = [];
    a.module.patterns.forEach((pat) => pat.forEach((row) => { if (row[0].note > 0 && row[0].note < 97) notes.push(row[0].note); }));
    expect(notes[0]).toBe(61);                     // C5 is the first new note
  });

  const noteRows = (m: ReturnType<typeof spcToModule>['module'], ch: number) => {
    const out: { row: number; note: number; cell: (typeof m.patterns)[0][0][0] }[] = [];
    let base = 0;
    for (const pi of m.order) { const pat = m.patterns[pi]; pat.forEach((row, ri) => { const c = row[ch]; if (c.note > 0 && c.note < 97) out.push({ row: base + ri, note: c.note, cell: c }); }); base += pat.length; }
    return out;
  };

  it('finds the loop point: the module ends at the loop end and restarts at the loop start', () => {
    const r = spcToModule(buildSpc());
    expect(r.info.loop).not.toBeNull();
    const { start, end } = r.info.loop!;
    expect(end - start).toBeCloseTo(2, 1);              // 4 notes of half a second
    expect(start).toBeGreaterThan(0.4); expect(start).toBeLessThan(0.6);
    expect(r.info.seconds).toBeCloseTo(end, 1);
    expect(r.module.restart).toBeGreaterThan(0);
    // the restart pattern begins with the first note of the loop
    expect(r.module.patterns[r.module.order[r.module.restart]][0][0].note).toBe(58);
    const out = convert(r.module, {});
    expect(Math.abs(out.loopFrame - start * 50)).toBeLessThanOrEqual(3);
    expect(Math.abs(out.nframes - end * 50)).toBeLessThanOrEqual(3);
    expect(r.pcmLoop).toBeCloseTo(start, 2);
    expect(r.pcm.length / 2 / 32000).toBeCloseTo(end, 1);
  });

  it('findLoop: shortest period with the earliest start; a repeated bar inside the intro is not the loop', () => {
    const ev: { t: number; key: string }[] = [];
    // intro 0..10 s (a bar of 1 s repeated), then a 6 s loop of 6 different notes, recorded for 60 s
    for (let t = 0; t < 10; t++) ev.push({ t: t * 32000, key: 'intro' });
    for (let t = 10; t < 60; t++) ev.push({ t: t * 32000 + ((t * 37) % 5) * 20, key: 'n' + ((t - 10) % 6) });
    const lp = findLoop(ev, 60 * 32000)!;
    expect(lp.start).toBe(10 * 32000);
    expect(Math.abs(lp.len - 6 * 32000)).toBeLessThan(200);
    expect(findLoop(ev.filter((e) => e.t < 20 * 32000), 20 * 32000)).toBeNull();     // not heard long enough yet
  });

  it('findStep: the grid of a song with a little timing jitter', () => {
    const T = 0.125 * 32000, times: number[] = [];
    for (let k = 0; k < 400; k++) if (k % 3 !== 1) times.push(1000 + k * T + ((k * 13) % 7) * 10);
    const g = findStep(times)!;
    expect(g.T).toBeCloseTo(T, -1);
    expect(g.fit).toBeGreaterThan(0.95);
  });

  it('rows per step: one row per grid step, notes every other row, the DSP envelope as instrument envelope', () => {
    const r = spcToModule(buildSpc(), { rows: 'step', loop: false, seconds: 10 });
    expect(r.info.rows).toBe('step');
    expect(r.info.stepMs).toBeCloseTo(250, -1);
    const n = noteRows(r.module, 0);
    expect(n.map((x) => x.note).slice(0, 5)).toEqual([58, 61, 65, 46, 58]);
    expect(n[1].row - n[0].row).toBe(2);
    expect(n[2].row - n[1].row).toBe(2);
    expect(r.module.bpm).toBe(125);
    expect(r.module.instruments[1]!.vflags & 1).toBe(1);
    // the same pitches come out of the converter
    const out = convert(r.module, {});
    const at = (f: number) => [0, 1, 2].filter((v) => out.regs[f * 14 + 8 + v] & 15).map((v) => out.regs[f * 14 + 2 * v] | ((out.regs[f * 14 + 2 * v + 1] & 15) << 8));
    expect(at(40).some((p) => Math.abs(p - 284) <= 3)).toBe(true);
    expect(at(120).some((p) => Math.abs(p - 568) <= 6)).toBe(true);
  });

  it('echo becomes a Low-priority echo channel: the notes of voice 0, 4 frames (80 ms) later, quieter', () => {
    const r = spcToModule(buildSpc(true, true), { loop: false, seconds: 4 });
    expect(r.info.echo).toBe(true);
    expect(r.info.echoVoices).toEqual([0]);
    expect(r.module.nch).toBe(9);
    expect(r.prio).toEqual({ 8: -3 });
    const dry = noteRows(r.module, 0), wet = noteRows(r.module, 8);
    expect(wet.map((x) => x.note).slice(0, 4)).toEqual(dry.map((x) => x.note).slice(0, 4));
    expect(wet[0].row - dry[0].row).toBe(4);
    expect(wet[0].cell.vol - 0x10).toBeLessThan(dry[0].cell.vol - 0x10);
    const off = spcToModule(buildSpc(true, true), { loop: false, seconds: 4, echoNotes: false });
    expect(off.module.nch).toBe(8);
  });

  it('a muted voice is left out of the module and of the original preview', () => {
    const r = spcToModule(buildSpc(), { loop: false, seconds: 2, voiceOff: [true] });
    expect(noteRows(r.module, 0).length).toBe(0);
    let peak = 0; for (let i = 0; i < r.pcm.length; i++) peak = Math.max(peak, Math.abs(r.pcm[i]));
    expect(peak).toBe(0);
    expect(r.info.voicesUsed[0]).toBe(true);
  });

  it('a delayed note (EDx) takes the volume column on the delayed tick', () => {
    const m = spcToModule(buildSpc(), { loop: false, seconds: 1 }).module;
    const pat = m.patterns[0];
    for (const row of pat) for (const c of row) Object.assign(c, { note: 0, inst: 0, vol: 0, eff: 0, par: 0 });
    Object.assign(pat[1][0], { eff: 0x0f, par: 2 });
    Object.assign(pat[4][0], { note: 58, inst: 1, vol: 0x10 + 20, eff: 0x0e, par: 0xd1 });
    const rp = replay(m, {});
    const v = rp.frames.map((f) => f[0]?.vol ?? 0).filter((x) => x > 0);
    expect(v[0]).toBeCloseTo(20 / 64, 3);
  });
});
