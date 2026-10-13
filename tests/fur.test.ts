import { describe, it, expect } from 'vitest';
import { songToFur, furName } from '../src/furnace/fur';
import { bakeInstrument } from '../src/export/bake';
import { newSong, emptyPattern, defaultInstrument, parseEffectChar, type Song, type Instrument } from '../src/tracker/types';

// ---- a small reader for the file layout (the same fields Furnace's own loader reads for format 228)
class R {
  p = 0;
  constructor(public b: Uint8Array) {}
  u8() { return this.b[this.p++]; }
  u16() { const v = this.b[this.p] | (this.b[this.p + 1] << 8); this.p += 2; return v; }
  u32() { const v = (this.b[this.p] | (this.b[this.p + 1] << 8) | (this.b[this.p + 2] << 16) | (this.b[this.p + 3] << 24)) >>> 0; this.p += 4; return v; }
  f32() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4).getFloat32(0, true); this.p += 4; return v; }
  str() { let s = ''; while (this.b[this.p]) s += String.fromCharCode(this.b[this.p++]); this.p++; return s; }
  tag(n = 4) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.p++]); return s; }
}
interface Mac { code: number; vals: number[]; loop: number; rel: number; instant: boolean }
interface Row { note?: number; ins?: number; vol?: number; fx: [number, number][] }

function parse(bytes: Uint8Array) {
  const r = new R(bytes);
  expect(r.tag(16)).toBe('-Furnace module-');
  const version = r.u16(); r.u16();
  const infoPtr = r.u32();
  r.p = infoPtr;
  expect(r.tag()).toBe('INFO'); r.u32();
  r.u8(); const speed1 = r.u8(); const speed2 = r.u8(); r.u8();
  const hz = r.f32(); const patLen = r.u16(); const ordLen = r.u16(); r.u8(); r.u8();
  const insCount = r.u16(); r.u16(); r.u16(); const patCount = r.u32();
  const chips = Array.from({ length: 32 }, () => r.u8());
  r.p += 64;
  const flagPtrs = Array.from({ length: 32 }, () => r.u32());
  const name = r.str(), author = r.str(); const tuning = r.f32();
  r.p += 20;
  const insPtr = Array.from({ length: insCount }, () => r.u32());
  const patPtr = Array.from({ length: patCount }, () => r.u32());
  const nch = 3;
  const orders = Array.from({ length: nch }, () => Array.from({ length: ordLen }, () => r.u8()));
  const effCols = Array.from({ length: nch }, () => r.u8());
  // flags
  r.p = flagPtrs[0]; expect(r.tag()).toBe('FLAG'); r.u32(); const flags = r.str();
  // instruments
  const insts = insPtr.map((ptr) => {
    r.p = ptr;
    expect(r.tag()).toBe('INS2'); const size = r.u32(); const end = r.p + size;
    r.u16(); const type = r.u16();
    let iname = ''; const macros: Mac[] = [];
    while (r.p < end) {
      const code = r.tag(2);
      if (code === 'EN') break;
      const len = r.u16(); const fend = r.p + len;
      if (code === 'NA') iname = r.str();
      else if (code === 'MA') {
        const hl = r.u16();
        while (r.p < fend) {
          const start = r.p;
          const mc = r.u8();
          if (mc === 255) break;
          const n = r.u8(), loop = r.u8(), rel = r.u8(), mode = r.u8(), ws = r.u8(); r.u8(); r.u8();
          expect(mode).toBe(0);
          r.p = start + hl;
          const vals: number[] = [];
          for (let i = 0; i < n; i++) {
            const size = ws >> 6;
            if (size === 0) vals.push(r.u8()); else if (size === 1) { const v = r.u8(); vals.push(v > 127 ? v - 256 : v); } else { const v = r.u16(); vals.push(v > 32767 ? v - 65536 : v); }
          }
          macros.push({ code: mc, vals, loop, rel, instant: !!(ws & 8) });
        }
      }
      r.p = fend;
    }
    return { name: iname, type, macros };
  });
  // patterns
  const pats = patPtr.map((ptr) => {
    r.p = ptr;
    expect(r.tag()).toBe('PATN'); r.u32();
    const sub = r.u8(), ch = r.u8(), index = r.u16(); r.str();
    const rows: Row[] = Array.from({ length: patLen }, () => ({ fx: [] }));
    for (let j = 0; j < patLen; j++) {
      const mask = r.u8();
      if (mask === 0xff) break;
      if (mask & 128) { j += (mask & 127) + 1; continue; }
      let em = 0;
      if (mask & 32) em |= r.u8();
      if (mask & 64) em |= r.u8() << 8;
      if (mask & 8) em |= 1;
      if (mask & 16) em |= 2;
      const row = rows[j];
      if (mask & 1) row.note = r.u8();
      if (mask & 2) row.ins = r.u8();
      if (mask & 4) row.vol = r.u8();
      for (let k = 0; k < 8; k++) {
        const e = em & (1 << (2 * k)) ? r.u8() : -1;
        const v = em & (2 << (2 * k)) ? r.u8() : 0;
        if (e >= 0) row.fx.push([e, v]);
      }
    }
    return { sub, ch, index, rows };
  });
  const song = { version, speed1, speed2, hz, patLen, ordLen, chips, name, author, tuning, orders, effCols, flags, insts, pats };
  return song;
}

const c = (note: number, instrument = 0, effect = '', param = 0, volume = 0) => ({ note, instrument, volume, effect: effect ? parseEffectChar(effect) : 0, param });
function mk(rows = 16): Song {
  const s = newSong(3);
  s.patterns = [emptyPattern(rows, 3)];
  s.instruments[1] = { ...defaultInstrument('lead'), adsr: { useAdsr: true, attack: 0, decay: 0, sustain: 12, release: 0 } };
  return s;
}
const rowsOf = (f: ReturnType<typeof parse>, ch: number, order = 0) => f.pats.find((p) => p.ch === ch && p.index === f.orders[ch][order])!.rows;

describe('Furnace .fur export', () => {
  it('writes the 228 layout for one AY chip', () => {
    const s = mk(); s.name = 'My tune'; s.author = 'Me'; s.speed = 5; s.bpm = 150;
    s.patterns[0].cells[0][0] = c(49, 1);
    const f = parse(songToFur(s).bytes);
    expect(f.version).toBe(228);
    expect(f.chips[0]).toBe(0x80); expect(f.chips[1]).toBe(0);
    expect(f.flags).toContain('chipType=1'); expect(f.flags).toContain('clockSel=3');
    expect(f.name).toBe('My tune'); expect(f.author).toBe('Me');
    expect(f.hz).toBeCloseTo(60, 3);
    expect(f.speed1).toBe(5);
    expect(f.tuning).toBe(440);
    expect(f.patLen).toBe(16); expect(f.ordLen).toBe(1);
    expect(f.insts[0].type).toBe(6); expect(f.insts[0].name).toBe('lead');
  });

  it('maps notes (editor note n = Furnace n + 59), instruments and the volume column', () => {
    const s = mk();
    const p = s.patterns[0].cells;
    p[0][0] = c(49, 1);                               // C-4: Furnace note 108
    p[2][0] = c(0, 0, '', 0, 0x30);                   // volume 32 -> a lower AY step
    p[4][0] = c(53, 0);                               // same instrument, no instrument byte
    p[8][0] = c(97);                                  // note off
    const f = parse(songToFur(s).bytes);
    const rows = rowsOf(f, 0);
    expect(rows[0].note).toBe(108); expect(rows[0].ins).toBe(0);
    expect(rows[2].vol).toBeGreaterThan(0); expect(rows[2].vol).toBeLessThan(15);
    expect(rows[4].note).toBe(112); expect(rows[4].ins).toBeUndefined();
    expect(rows[8].note).toBe(180);                   // no release tail: plain note off
  });

  it('bakes an ADSR instrument into volume / wave macros and keeps a release tail as the macro release', () => {
    const s = mk();
    s.instruments[1].adsr = { useAdsr: true, attack: 0, decay: 4, sustain: 6, release: 4 };
    s.patterns[0].cells[0][0] = c(49, 1); s.patterns[0].cells[8][0] = c(97);
    const f = parse(songToFur(s).bytes);
    const vol = f.insts[0].macros.find((m) => m.code === 0)!;
    const wave = f.insts[0].macros.find((m) => m.code === 3)!;
    expect(wave.vals[0]).toBe(1);                      // tone only
    expect(vol.vals[0]).toBe(15);                      // starts at full level
    expect(vol.rel).toBeLessThan(vol.vals.length - 1); // there is a tail after the release point
    expect(vol.instant).toBe(true);
    expect(vol.vals[vol.vals.length - 1]).toBe(0);     // and it ends silent
    expect(rowsOf(f, 0)[8].note).toBe(181);            // note release, not note off
  });

  it('writes the buzzer: wave bit 2, envelope shape, auto-envelope ratio', () => {
    const s = mk();
    s.instruments[1] = { ...defaultInstrument('buzz'), useHardEnv: true, hardEnvShape: 10, toneEnabled: false, hardEnvDivisor: 2 };
    s.patterns[0].cells[0][0] = c(37, 1);
    const f = parse(songToFur(s).bytes);
    const m = (code: number) => f.insts[0].macros.find((x) => x.code === code)?.vals;
    expect(m(3)![0]).toBe(4);                          // envelope bit only
    expect(m(6)).toEqual([10]);                        // R13 shape
    expect(m(7)).toEqual([1]); expect(m(8)).toEqual([2]);   // auto-envelope num / den
    expect(m(14)).toEqual([1]);                        // phase reset: R13 is rewritten on every note
  });

  it('gives a step table with fractional semitones one copy per note, carrying the period correction', () => {
    const s = mk();
    s.instruments[1] = { ...defaultInstrument('tuned'), seq: { steps: [{ vol: 15, semi: 0.4, noise: 0, tone: true }], loopFrom: 0, velocity: false, release: 0 } };
    s.patterns[0].cells[0][0] = c(49, 1); s.patterns[0].cells[4][0] = c(61, 1);
    const f = parse(songToFur(s).bytes);
    expect(f.insts.length).toBe(2);
    const pitch = f.insts.map((i) => i.macros.find((m) => m.code === 4)?.vals[0] ?? 0);
    // C-4 is period ~478: 0.4 semitone sharper is ~10 units lower; one octave up halves it
    expect(pitch[0]).toBeGreaterThan(5); expect(pitch[1]).toBeGreaterThan(2); expect(pitch[0]).toBeGreaterThan(pitch[1]);
    const rows = rowsOf(f, 0);
    expect(rows[0].ins).toBe(0); expect(rows[4].ins).toBe(1);
  });

  it('carries arpeggios, slides, vibrato, speed and flow effects', () => {
    const s = mk(16);
    s.patterns.push(emptyPattern(8, 3)); s.order = [0, 1];
    const p = s.patterns[0].cells;
    p[0][0] = c(49, 1, '0', 0x37);
    p[2][0] = c(0, 0, '1', 0x04);
    p[4][0] = c(0, 0, '4', 0x46);
    p[6][1] = c(49, 1, 'F', 3);
    p[8][1] = c(49, 1, 'F', 150);
    p[10][2] = c(0, 0, 'D', 0);
    const f = parse(songToFur(s).bytes);
    const ch0 = rowsOf(f, 0);
    expect(ch0[0].fx).toContainEqual([0x00, 0x37]);
    expect(ch0[1].fx).toContainEqual([0x00, 0x00]);   // the editor's arpeggio ends with the row, Furnace's does not
    expect(ch0[2].fx).toContainEqual([0x01, 0x04]);
    expect(ch0[3].fx).toContainEqual([0x01, 0x00]);
    expect(ch0[4].fx).toContainEqual([0xe4, 1]);       // vibrato range: one register-period unit per two depth steps
    expect(ch0[4].fx).toContainEqual([0x04, 0x46]);
    const all = [0, 1, 2].flatMap((c2) => rowsOf(f, c2).flatMap((r) => r.fx));
    expect(all).toContainEqual([0x0f, 3]);
    expect(all).toContainEqual([0xf0, 150]);
    expect(all).toContainEqual([0x0d, 0]);
    expect(f.patLen).toBe(11);                         // the first pattern stops at its break row, the second has 8
  });

  it('pads shorter patterns with a jump to the next one and loops back to the restart position', () => {
    const s = mk(16);
    s.patterns.push(emptyPattern(8, 3)); s.order = [0, 1]; s.restartPos = 1;
    s.patterns[0].cells[0][0] = c(49, 1);
    const f = parse(songToFur(s).bytes);
    expect(f.patLen).toBe(16);
    const last0 = [0, 1, 2].flatMap((ch) => rowsOf(f, ch, 0)[15].fx);
    expect(last0).toEqual([]);                          // the full-length pattern needs nothing
    const short = [0, 1, 2].flatMap((ch) => rowsOf(f, ch, 1)[7].fx);
    expect(short).toContainEqual([0x0b, 1]);            // last order: jump to the restart position
  });

  it('counts what has no Furnace equivalent', () => {
    const s = mk();
    s.patterns[0].cells[0][0] = c(49, 1, 'Z', 1);
    s.patterns[0].cells[2][0] = c(0, 0, 'Q', 0x10);
    s.instruments[1].syncSquare = true;
    const r = songToFur(s);
    expect(r.warnings.join('\n')).toMatch(/digidrums/);
    expect(r.warnings.join('\n')).toMatch(/timer effects/);
    expect(r.warnings.join('\n')).toMatch(/sync-square/);
  });

  it('shares identical channel patterns and names the file', () => {
    const s = mk(8);
    s.patterns[0].cells[0][0] = c(49, 1);
    s.order = [0, 0, 0];
    const r = songToFur(s);
    const f = parse(r.bytes);
    expect(f.ordLen).toBe(3);
    expect(new Set(f.orders[0]).size).toBe(1);
    expect(r.stats.patterns).toBeLessThanOrEqual(3);
    expect(furName('a/b c')).toBe('a_b c.fur');
  });
});

describe('instrument baking for other trackers', () => {
  const inst = (o: Partial<Instrument>): Instrument => ({ ...defaultInstrument('x'), ...o });
  const noWarn = () => {};

  it('keeps the built-in vibrato phase stall on the first tick of each row', () => {
    const v = inst({ vibratoSpeed: 4, vibratoDepth: 8, adsr: { useAdsr: true, attack: 0, decay: 0, sustain: 15, release: 0 } });
    const free = bakeInstrument(v, 'v', noWarn, 255, 'T').ticks.map((t) => t.pitch);
    const rows = bakeInstrument(v, 'v', noWarn, 255, 'T', 'period units', true, 6).ticks.map((t) => t.pitch);
    expect(rows.slice(0, 7)).toEqual(free.slice(0, 7));         // identical until the second row starts
    expect(rows[7]).not.toBe(free[7]);                          // then the editor's phase waits one tick
    expect(rows.length).toBeGreaterThan(free.length);           // and the cycle is a whole number of rows, longer than 16 ticks
  });

  it('starts a step table release one tick in, holds a volume release table\'s last value', () => {
    const q = inst({ seq: { steps: [{ vol: 15, semi: 0, noise: 0, tone: true }], loopFrom: 0, velocity: false, release: 3 } });
    expect(bakeInstrument(q, 'q', noWarn, 255, 'T').release).toEqual([8, 4, 0]);
    const r = inst({ adsr: { useAdsr: false, attack: 0, decay: 0, sustain: 15, release: 0 }, volEnv: [15], volRelease: [10, 6, 2] });
    expect(bakeInstrument(r, 'r', noWarn, 255, 'T').release.length).toBe(2);
  });
});
