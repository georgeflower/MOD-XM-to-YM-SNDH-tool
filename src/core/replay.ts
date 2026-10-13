/**
 * Tick-accurate tracker replayer (XM + ProTracker MOD) that produces, for every 50 Hz frame,
 * the sounding state of every channel: instrument, sample position, effective period/rate and loudness.
 * Only what is needed to reproduce *what you hear* is modelled (no stereo, no filters).
 */
import type { Cell, Module, Sample } from './types';
import { xmPeriodOf, xmRateOf, amigaPeriodOf, amigaRateOf, PT_NOTE_BASE } from './pitch';
import { ended } from './samples';

export const FPS = 50;

export interface ChanState {
  inst: number;
  ksmp: number;
  smp: Sample;
  /** effective period (arpeggio / vibrato applied) */
  period: number;
  /** sample playback rate in Hz */
  rate: number;
  /** 0..1 channel loudness before sample data amplitude */
  vol: number;
  /** ticks since trigger */
  age: number;
  /** sample position (frames) at the start of this tick */
  pos: number;
  note: number;
  /** playback rate of the plain note (no vibrato / arpeggio / slides): rate / noteRate = pitch bend */
  noteRate: number;
}

/** one played pattern row: where it sits in the frame list and the timing it ran at */
export interface RowLog { order: number; pat: number; row: number; frame: number; len: number; speed: number; bpm: number }

export interface ReplayResult {
  frames: (ChanState | null)[][];
  /** every row in the order it was played (pattern jumps / breaks / loops unrolled) */
  rows: RowLog[];
  /** frame index at which each order position starts (first visit) */
  orderFrame: Map<number, number>;
  /** frame to loop back to */
  loopFrame: number;
  warnings: Map<string, number>;
}

class Ch {
  inst = 0; smp: Sample | null = null; ksmp = 0; note = 0;
  period = 0; basePeriod = 0; vol = 0; envTick = 0; fade = 32768; keyoff = false;
  pos = 0; active = false; age = 0;
  porta = 0; vslide = 0; vibSpeed = 0; vibDepth = 0; vibPos = 0; arp = 0; avPos = 0; avAmp = 0;
  tpTarget = 0; tpSpeed = 0; volSlide = 0;
  rowEff = 0; rowPar = 0; rowVib = false; delay = 0; delayCell: Cell | null = null;
  loopRow = 0; loopCount = 0; cutTick = -1; retrig = 0;
}

const VIB_SINE = Array.from({ length: 64 }, (_, i) => Math.sin((2 * Math.PI * i) / 64));

function envValue(ins: NonNullable<Module['instruments'][number]>, tick: number): number {
  const pts = ins.venv;
  if (!(ins.vflags & 1) || !pts.length) return 64.0;
  for (let k = 0; k < pts.length - 1; k++) {
    const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
    if (x0 <= tick && tick <= x1) return x1 === x0 ? y0 : y0 + ((y1 - y0) * (tick - x0)) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
}

export interface ReplayOptions {
  /** arpeggio tick order: 'xy' = base, +x, +y ; 'yx' = base, +y, +x */
  arpOrder?: 'xy' | 'yx';
  maxTicks?: number;
}

export function replay(m: Module, opts: ReplayOptions = {}): ReplayResult {
  const arpSeq = (opts.arpOrder ?? 'xy') === 'xy' ? [0, 1, 2] : [0, 2, 1];
  const maxTicks = opts.maxTicks ?? 120000;
  const nch = m.nch;
  const ch: Ch[] = Array.from({ length: nch }, () => new Ch());
  const amiga = m.amiga;
  let speed = m.speed, bpm = m.bpm;
  const warn = new Map<string, number>();
  const w = (k: string) => warn.set(k, (warn.get(k) ?? 0) + 1);

  const rateOf = (p: number) => (amiga ? amigaRateOf(p) : xmRateOf(p));
  const notePeriod = (note: number, s: Sample): number =>
    amiga ? amigaPeriodOf(note - PT_NOTE_BASE, s.modFine ?? 0) : xmPeriodOf(note - 1 + s.rel, s.fine);
  const clampP = (p: number) => (amiga ? Math.min(856 * 1.0, Math.max(113, p)) : Math.max(0, p));
  const slideUnit = amiga ? 1 : 4;

  const frames: (ChanState | null)[][] = [];
  const rowLog: RowLog[] = [];
  const orderFrame = new Map<number, number>();
  const visited = new Map<string, number>();
  let loopFrame = -1;
  let tclock = 0, nextFrame = 0, ticks = 0;
  let orderI = 0, rowI = 0;

  function trigger(c: Ch, cell: Cell, tonePorta: boolean) {
    const { note, inst } = cell;
    if (inst) {
      const ins = m.instruments[inst];
      if (ins && ins.samples.length) {
        c.inst = inst;
        if (!(note && note < 97) && c.smp) { c.vol = c.smp.vol; c.envTick = 0; c.fade = 32768; c.keyoff = false; }
      }
    }
    if (note && note < 97) {
      const ins = c.inst ? m.instruments[c.inst] : null;
      if (ins && ins.samples.length) {
        let ks = ins.keymap[note - 1] ?? 0;
        if (ks >= ins.samples.length) ks = 0;
        const s = ins.samples[ks];
        const per = notePeriod(note, s);
        if (tonePorta && c.active && c.smp) {
          c.tpTarget = per;
        } else {
          c.smp = s; c.ksmp = ks; c.note = note;
          c.basePeriod = c.period = per; c.tpTarget = per;
          c.vol = s.vol; c.envTick = 0; c.fade = 32768; c.keyoff = false;
          c.pos = 0; c.active = true; c.age = 0; c.vibPos = 0; c.avPos = 0; c.avAmp = 0;
          if (cell.eff === 9) c.pos = cell.par * 256;
        }
      } else {
        c.active = false;
      }
    } else if (note === 97) {
      c.keyoff = true;
      if (c.inst && !((m.instruments[c.inst]!.vflags) & 1)) c.vol = 0;
    }
  }

  function snapshot(c: Ch, t: number): ChanState | null {
    if (!c.active || !c.smp) return null;
    const ins = m.instruments[c.inst]!;
    let per = c.period;
    if (!amiga && ins.vib[2] > 0) {
      const vt = ins.vib[0];
      let wave = (c.avPos & 128) === 0 ? 1 : -1;
      if (vt === 0) wave = Math.sin((2 * Math.PI * (c.avPos & 255)) / 256);
      else if (vt === 2) wave = 1 - 2 * ((c.avPos & 255) / 255);
      else if (vt === 3) wave = -1 + 2 * ((c.avPos & 255) / 255);
      per = per - wave * c.avAmp * 4;
    }
    if (c.rowVib && c.vibDepth && c.vibSpeed) per = per + VIB_SINE[c.vibPos & 63] * c.vibDepth * (amiga ? 2 : 4);
    let perEff = per;
    if (c.arp) {
      const x = (c.arp >> 4) & 15, y = c.arp & 15;
      const off = [0, x, y][arpSeq[t % 3]];
      if (off) perEff = amiga ? amigaPeriodOf(c.note - PT_NOTE_BASE + off, c.smp.modFine ?? 0) : per - off * 64;
    }
    let v = c.vol / 64;
    v *= envValue(ins, c.envTick) / 64;
    v *= c.fade / 32768;
    return { inst: c.inst, ksmp: c.ksmp, smp: c.smp, period: perEff, rate: rateOf(perEff), vol: v, age: c.age, pos: c.pos, note: c.note, noteRate: rateOf(notePeriod(c.note, c.smp)) };
  }

  main: while (ticks < maxTicks) {
    if (orderI >= m.order.length) { loopFrame = orderFrame.get(m.restart) ?? 0; break; }
    if (rowI === 0 && !orderFrame.has(orderI)) orderFrame.set(orderI, nextFrame);
    const pat = m.patterns[m.order[orderI]];
    if (!pat) break;
    const row = pat[rowI];
    // loop detection (position + pattern-loop state)
    const sig = `${orderI}:${rowI}:${ch.map((c) => c.loopCount).join(',')}`;
    if (visited.has(sig)) { loopFrame = visited.get(sig)!; break; }
    visited.set(sig, nextFrame);
    const rl: RowLog = { order: orderI, pat: m.order[orderI], row: rowI, frame: frames.length, len: 0, speed, bpm };
    rowLog.push(rl);

    let posJump: number | null = null, brkRow: number | null = null, rowDelay = 0, loopTo: number | null = null;
    let tick = 0;
    while (tick < speed * (1 + rowDelay)) {
      const dt = 2.5 / bpm;
      for (let ci = 0; ci < nch; ci++) {
        const c = ch[ci];
        const cell = row[ci];
        const { note, vol: vcol, eff, par } = cell;
        if (tick === 0) {
          c.rowEff = eff; c.rowPar = par; c.volSlide = 0; c.delay = 0; c.cutTick = -1; c.retrig = 0;
          const isTP = eff === 3 || eff === 5 || (vcol >= 0xf0);
          const noteDelay = eff === 0xe && (par >> 4) === 0xd && (par & 15) > 0;
          if (noteDelay) { c.delay = par & 15; c.delayCell = cell; }
          else trigger(c, cell, isTP && !!note);
          // volume column
          let vib = false;
          if (vcol >= 0x10 && vcol <= 0x50) c.vol = vcol - 0x10;
          else if (vcol >= 0x60 && vcol <= 0x6f) c.volSlide = -(vcol & 15);
          else if (vcol >= 0x70 && vcol <= 0x7f) c.volSlide = vcol & 15;
          else if (vcol >= 0x80 && vcol <= 0x8f) c.vol = Math.max(0, c.vol - (vcol & 15));
          else if (vcol >= 0x90 && vcol <= 0x9f) c.vol = Math.min(64, c.vol + (vcol & 15));
          else if (vcol >= 0xa0 && vcol <= 0xaf) { if (vcol & 15) c.vibSpeed = vcol & 15; }
          else if (vcol >= 0xb0 && vcol <= 0xbf) { if (vcol & 15) c.vibDepth = vcol & 15; vib = true; }
          else if (vcol >= 0xf0) { if (vcol & 15) c.tpSpeed = (vcol & 15) * 16; }
          else if (vcol >= 0xc0 && vcol <= 0xef) { /* panning: ignored */ }
          c.arp = 0;
          switch (eff) {
            case 0x0: c.arp = par; break;
            case 0x1: case 0x2: if (par || amiga) c.porta = amiga ? par : par || c.porta; break;
            case 0x3: if (par) c.tpSpeed = par; break;
            case 0x4: case 0x6:
              if (eff === 0x4) { if (par >> 4) c.vibSpeed = par >> 4; if (par & 15) c.vibDepth = par & 15; }
              vib = true; break;
            case 0x5: break;
            case 0x9: break;
            case 0xa: if (par) c.vslide = par; break;
            case 0xc: c.vol = Math.min(64, par); break;
            case 0xf:
              if (par === 0) { /* stop: ignored */ } else if (par < 32) speed = par; else bpm = par;
              break;
            case 0xb: posJump = par; break;
            case 0xd: brkRow = (par >> 4) * 10 + (par & 15); break;
            case 0xe: {
              const x = par >> 4, y = par & 15;
              if (x === 0x1) c.period = clampP(c.period - y * slideUnit);
              else if (x === 0x2) c.period = clampP(c.period + y * slideUnit);
              else if (x === 0xa) c.vol = Math.min(64, c.vol + y);
              else if (x === 0xb) c.vol = Math.max(0, c.vol - y);
              else if (x === 0xc) c.cutTick = y;
              else if (x === 0x9) c.retrig = y;
              else if (x === 0x5 && amiga && c.smp) { c.smp.modFine = y > 7 ? y - 16 : y; }
              else if (x === 0x6) {
                if (y === 0) c.loopRow = rowI;
                else if (c.loopCount === 0) { c.loopCount = y; loopTo = c.loopRow; }
                else { c.loopCount--; if (c.loopCount > 0) loopTo = c.loopRow; }
              } else if (x === 0xe) rowDelay = y;
              else if (x === 0xd) { /* handled above */ }
              else if (x !== 0x0 && x !== 0x3 && x !== 0x4 && x !== 0x7 && x !== 0x8 && x !== 0xf) w('E' + x.toString(16));
              break;
            }
            case 0x7: case 0x8: case 0x10: break; // tremolo / pan / global: ignored
            default:
              if (eff) w('eff' + eff.toString(16));
          }
          c.rowVib = vib;
        } else {
          const e = c.rowEff;
          if (c.delay && tick === c.delay && c.delayCell) trigger(c, c.delayCell, false);
          if (e === 1) c.period = clampP(c.period - c.porta * slideUnit);
          else if (e === 2) c.period = clampP(c.period + c.porta * slideUnit);
          if (e === 3 || e === 5 || (e === 0 && false)) tonePortaStep(c);
          if (e === 5 || e === 6 || e === 0xa) {
            const x = c.vslide >> 4, y = c.vslide & 15;
            if (x) c.vol = Math.min(64, c.vol + x); else if (y) c.vol = Math.max(0, c.vol - y);
          }
          if (c.volSlide) c.vol = Math.max(0, Math.min(64, c.vol + c.volSlide));
          if (c.rowVib) c.vibPos = (c.vibPos + c.vibSpeed) & 63;
          if (c.cutTick === tick) c.vol = 0;
          if (c.retrig && tick % c.retrig === 0 && c.smp) c.pos = 0;
          if (c.tpSpeed && (c.volSlide === 0) && c.rowEff !== 3 && c.rowEff !== 5 && (/*vol col tone porta*/ false)) { /* noop */ }
        }
        // volume-column tone portamento runs on every tick
        if (tick > 0 && row[ci].vol >= 0xf0 && c.tpSpeed) tonePortaStep(c);
      }
      // ---- emit frames covering [tclock, tclock+dt)
      const snap: (ChanState | null)[] = [];
      for (let ci = 0; ci < nch; ci++) snap.push(snapshot(ch[ci], tick));
      while (nextFrame / FPS < tclock + dt - 1e-9) {
        if (nextFrame / FPS >= tclock - 1e-9) frames.push(snap);
        nextFrame++;
      }
      // ---- advance state to next tick
      for (let ci = 0; ci < nch; ci++) {
        const c = ch[ci];
        if (!c.active || !c.smp) continue;
        const ins = m.instruments[c.inst]!;
        c.pos += rateOf(c.period) * dt;
        c.age++;
        if (ended(c.smp, c.pos)) { /* stays active; silent via candidates */ }
        if (ins.vflags & 1 && ins.venv.length) {
          const pts = ins.venv;
          const susTick = ins.vflags & 2 && ins.vsus < pts.length ? pts[ins.vsus][0] : null;
          if (susTick !== null && !c.keyoff && c.envTick >= susTick) c.envTick = susTick;
          else {
            c.envTick++;
            if (ins.vflags & 4 && ins.vle < pts.length) {
              const le = pts[ins.vle][0];
              if (c.envTick > le && !(susTick !== null && !c.keyoff)) c.envTick = pts[ins.vls][0];
            }
          }
        }
        if (c.keyoff && ins.fade) c.fade = Math.max(0, c.fade - ins.fade);
        const [, vs, vd, vr] = ins.vib;
        if (vd) { c.avPos = (c.avPos + vr) & 255; c.avAmp = Math.min(vd, c.avAmp + vd / Math.max(1, vs)); }
      }
      tclock += dt;
      tick++;
      ticks++;
      if (ticks >= maxTicks) break main;
    }
    rl.len = frames.length - rl.frame; rl.speed = speed; rl.bpm = bpm;
    // ---- next row
    if (loopTo !== null && posJump === null && brkRow === null) { rowI = loopTo; continue; }
    if (posJump !== null) { orderI = posJump; rowI = brkRow ?? 0; }
    else if (brkRow !== null) { orderI++; rowI = brkRow; }
    else { rowI++; if (rowI >= pat.length) { orderI++; rowI = 0; } }
    if (orderI < m.order.length && rowI >= (m.patterns[m.order[orderI]]?.length ?? 0)) rowI = 0;
  }
  if (loopFrame < 0) loopFrame = 0;
  for (const [k, v] of warn) void k, v;
  return { frames, rows: rowLog, orderFrame, loopFrame, warnings: warn };

  function tonePortaStep(c: Ch) {
    if (!c.active) return;
    const step = c.tpSpeed * slideUnit;
    if (c.period > c.tpTarget) c.period = Math.max(c.tpTarget, c.period - step);
    else if (c.period < c.tpTarget) c.period = Math.min(c.tpTarget, c.period + step);
  }
}
