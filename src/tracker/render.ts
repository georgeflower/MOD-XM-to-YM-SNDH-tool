/**
 * Pattern song -> YM2149 register frames (50 Hz).
 *
 * A port of the YM Tracker's player (tick logic, effects, ADSR, hardware envelope) as a pure
 * function: no Web Audio, it just produces the register dump that every exporter here consumes.
 * Ticks run at the song tempo (2.5/BPM s); frames are sampled from them at 50 Hz, so a song with
 * BPM 125 is exactly one tick per frame (what Atari ST players do).
 *
 * DigiDrums (effect Zxx, or notes on the drum channel) come out as a DrumTrack next to the registers:
 * one trigger code per frame, and the drum's voice is silenced in the registers while the sample plays.
 * The ST has one drum timer, so a new drum cuts the one before it.
 *
 * Timer effects Q (SID voice), S (sinus-SID) and U (sync-buzzer) come out as an FxTrack (one packed state per frame):
 * the registers keep the voice's normal volume / envelope, the track says which MFP timer modulates it.
 * The ST has one timer for this, so one effect plays at a time.
 *
 * Not rendered (reported as warnings): channels >= 3 (second chip).
 */
import {
  type Song, type Cell, type Instrument, NOTE_OFF, noteToFreq, channelsOf, drumChannelOf, VOICES, EFFECT_LETTERS,
} from './types';
import { type DrumSample, type DrumTrack, drumFrames, trigCode, TRIG_STOP, MAX_DRUMS } from '../core/drums';
import { type FxTrack, type FxKind, FX_SID, FX_SINUS, FX_SYNC, FX_LETTERS, fxSetting, packFx } from '../core/fx';

export const NREGS = 14;
const FPS = 50;
const MAX_FRAMES = FPS * 60 * 20;

// YM2149 amplitude table (relative); the tracker's volume column is *linear*, so map back to the nearest step.
const YM_AMP = [0.0, 0.00465, 0.00686, 0.01007, 0.01471, 0.02153, 0.03154, 0.04616,
  0.06754, 0.09891, 0.14475, 0.21184, 0.31, 0.4536, 0.66355, 0.97087];
export const LINEAR_TO_YM_VOL: Uint8Array = (() => {
  const t = new Uint8Array(65);
  for (let k = 1; k <= 64; k++) {
    const target = (k / 64) * YM_AMP[15];
    let best = 0, bd = Infinity;
    for (let i = 0; i < 16; i++) { const d = Math.abs(YM_AMP[i] - target); if (d < bd) { bd = d; best = i; } }
    t[k] = best;
  }
  return t;
})();

const clampV = (n: number) => Math.max(0, Math.min(0x40, Math.trunc(n)));
export function freqToYmPeriod(freq: number, clock = 2_000_000): number {
  if (freq <= 0) return 0;
  return Math.max(1, Math.min(4095, Math.round(clock / (16 * freq))));
}
export const VIB_TABLE = new Int8Array(64);
for (let i = 0; i < 64; i++) VIB_TABLE[i] = Math.round(Math.sin((i / 64) * Math.PI * 2) * 64);

const FXN = (l: string) => EFFECT_LETTERS.indexOf(l) + 1;
const FX_M = FXN('M'), FX_P = FXN('P'), FX_R = FXN('R'), FX_X = FXN('X'), FX_Y = FXN('Y');
const FX_Q = FXN('Q'), FX_S = FXN('S'), FX_U = FXN('U'), FX_Z = FXN('Z');

interface Chan {
  active: boolean; note: number; origNote: number; targetNote: number;
  instrument: Instrument | null; instIdx: number;
  volume: number; envPos: number; released: boolean; releasePos: number;
  adsrPhase: 'a' | 'd' | 's' | 'r' | 'off'; adsrLevel: number; adsrTick: number; adsrReleaseStart: number;
  period: number; periodOffset: number; arpPos: number; pitchPos: number;
  portaUp: number; portaDown: number; tonePortaSpeed: number; tonePortaTarget: number;
  vibratoSpeed: number; vibratoDepth: number; vibratoPos: number;
  tremoloSpeed: number; tremoloDepth: number; tremoloPos: number; tremoloOffset: number;
  volSlide: number; arpeggio: number; retrig: number; retrigVolChange: number;
  noteCutTick: number; noteDelayTick: number; delayedCell: Cell | null;
  loopRow: number; loopCount: number;
  forceHardEnv: boolean; hardEnvShape: number; hardEnvPeriodOverride: number; hardEnvDivisorOverride: number; hardEnvShapeDirty: boolean;
  freshTrigger: boolean;
  /** active timer effect (Q / S / U with its parameter), null = none */
  fx: { kind: FxKind; param: number } | null;
  // step-table instruments
  seqPos: number; relTick: number; relStart: number;
}
const newChan = (): Chan => ({
  active: false, note: 0, origNote: 0, targetNote: 0, instrument: null, instIdx: 0,
  volume: 0x40, envPos: 0, released: false, releasePos: 0,
  adsrPhase: 'off', adsrLevel: 0, adsrTick: 0, adsrReleaseStart: 0,
  period: 0, periodOffset: 0, arpPos: 0, pitchPos: 0,
  portaUp: 0, portaDown: 0, tonePortaSpeed: 0, tonePortaTarget: 0,
  vibratoSpeed: 0, vibratoDepth: 0, vibratoPos: 0,
  tremoloSpeed: 0, tremoloDepth: 0, tremoloPos: 0, tremoloOffset: 0,
  volSlide: 0, arpeggio: 0, retrig: 0, retrigVolChange: 0,
  noteCutTick: -1, noteDelayTick: -1, delayedCell: null, loopRow: 0, loopCount: -1,
  forceHardEnv: false, hardEnvShape: 0, hardEnvPeriodOverride: 0, hardEnvDivisorOverride: 0, hardEnvShapeDirty: true,
  freshTrigger: false, fx: null, seqPos: 0, relTick: 0, relStart: 0,
});

function hardEnvPeriodFor(ch: Chan, inst: Instrument): number {
  if (ch.hardEnvPeriodOverride) return ch.hardEnvPeriodOverride;
  if (inst.useHardEnv && !inst.hardEnvAutoPeriod && inst.hardEnvPeriod) return inst.hardEnvPeriod;
  const f = noteToFreq(ch.note);
  const div = Math.max(1, ch.hardEnvDivisorOverride || inst.hardEnvDivisor || 1);
  return f > 0 ? Math.max(1, Math.min(65535, Math.round((2_000_000 / (256 * f)) * div))) : 1;
}

function startAdsr(ch: Chan) {
  ch.adsrPhase = 'a'; ch.adsrLevel = 0; ch.adsrTick = 0; ch.adsrReleaseStart = 0;
  const inst = ch.instrument;
  if (inst?.adsr.useAdsr) {
    if (inst.adsr.attack <= 0) {
      ch.adsrLevel = 15; ch.adsrPhase = 'd';
      if (inst.adsr.decay <= 0) { ch.adsrLevel = inst.adsr.sustain; ch.adsrPhase = 's'; }
    }
  }
}
function stepAdsr(ch: Chan) {
  const inst = ch.instrument;
  if (!inst || !inst.adsr.useAdsr) return;
  const { attack, decay, sustain, release } = inst.adsr;
  switch (ch.adsrPhase) {
    case 'a':
      if (attack <= 0) { ch.adsrLevel = 15; ch.adsrPhase = 'd'; ch.adsrTick = 0; }
      else {
        ch.adsrTick++; ch.adsrLevel = Math.min(15, (ch.adsrTick / attack) * 15);
        if (ch.adsrTick >= attack) { ch.adsrLevel = 15; ch.adsrPhase = 'd'; ch.adsrTick = 0; }
      }
      break;
    case 'd':
      if (decay <= 0) { ch.adsrLevel = sustain; ch.adsrPhase = 's'; }
      else {
        ch.adsrTick++; ch.adsrLevel = 15 - (15 - sustain) * Math.min(1, ch.adsrTick / decay);
        if (ch.adsrTick >= decay) { ch.adsrLevel = sustain; ch.adsrPhase = 's'; }
      }
      break;
    case 's': ch.adsrLevel = sustain; break;
    case 'r':
      if (release <= 0) { ch.adsrLevel = 0; ch.adsrPhase = 'off'; ch.active = false; }
      else {
        ch.adsrTick++; ch.adsrLevel = Math.max(0, ch.adsrReleaseStart * (1 - ch.adsrTick / release));
        if (ch.adsrTick >= release) { ch.adsrLevel = 0; ch.adsrPhase = 'off'; ch.active = false; }
      }
      break;
  }
}

export interface RenderOptions {
  /** per-channel mute (editing aid) */
  mute?: boolean[];
  /** start at this order position / row (default: song start) */
  fromOrder?: number;
  fromRow?: number;
  /** stop after this many frames */
  maxFrames?: number;
  /** keep playing through the loop point once (default: stop at the first repeat) */
  noLoopStop?: boolean;
}

export interface RowMark { order: number; row: number; frame: number }
export interface RenderResult {
  regs: Uint8Array;
  nframes: number;
  /** frame the song loops back to, -1 = song ends */
  loopFrame: number;
  rows: RowMark[];
  warnings: string[];
  /** digidrum samples and triggers, when the song plays any */
  drums?: DrumTrack;
  /** timer effects (Q / S / U), one packed state per frame, when the song uses any */
  fx?: FxTrack;
}

export function renderSong(song: Song, opt: RenderOptions = {}): RenderResult {
  const drumCh = drumChannelOf(song);
  const toneChannels = drumCh >= 0 ? channelsOf(song) - 1 : channelsOf(song);
  const nCh = Math.min(VOICES, toneChannels);
  const chans: Chan[] = Array.from({ length: VOICES }, newChan);
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (k: string, msg: string) => { if (!warned.has(k)) { warned.add(k); warnings.push(msg); } };
  if (toneChannels > VOICES) warn('chips', `channels ${VOICES + 1}..${toneChannels} (second chip) are not rendered`);

  let speed = Math.max(1, song.speed), bpm = Math.max(32, song.bpm);
  let orderPos = Math.max(0, Math.min(song.order.length - 1, opt.fromOrder ?? 0));
  let row = opt.fromRow ?? 0;
  let tick = 0;
  let globalVolume = 0x40, globalVolSlide = 0;
  let posJump: number | null = null, patternBreak: number | null = null;
  let stopRequested = false;

  // ---- output
  const maxFrames = Math.min(MAX_FRAMES, opt.maxFrames ?? MAX_FRAMES);
  const out: number[] = [];
  const rows: RowMark[] = [];
  const cur = new Uint8Array(NREGS);          // register state held across frames
  cur[7] = 0xff;
  let pendingShape = -1;
  let tickTime = 0;                           // seconds
  let nextFrame = 0;
  const visited = new Map<string, number>();
  let loopFrame = -1;

  const isMuted = (c: number) => !!opt.mute?.[c];

  // ---- digidrums: a trigger is "pending" until the frame it lands in is emitted
  const drumTable: DrumSample[] = [];
  const drumIdx = new Map<DrumSample, number>();
  const trigOut: number[] = [];
  const fxOut: number[] = [];
  let fxVoice = -1;
  interface DrumHit { voice: number; drum: DrumSample | null; owner: 'z' | 'chan' }
  let pendingHit: DrumHit | null = null;
  let live: { voice: number; owner: 'z' | 'chan'; endFrame: number } | null = null;
  function hitDrum(voice: number, d: DrumSample, owner: 'z' | 'chan') {
    if (!d.pcm.length) return;
    if (!drumIdx.has(d)) {
      if (drumTable.length >= MAX_DRUMS) { warn('drums63', `more than ${MAX_DRUMS} different digidrums: the extra ones are not played`); return; }
      drumIdx.set(d, drumTable.length); drumTable.push(d);
    }
    pendingHit = { voice, drum: d, owner };
  }
  function stopDrum(voice: number) {
    if (live?.voice === voice || pendingHit?.voice === voice) pendingHit = { voice, drum: null, owner: 'z' };
  }

  function triggerCell(c: number, cell: Cell) {
    const ch = chans[c];
    const isTonePorta = cell.effect === 4 || cell.effect === 6;
    if (cell.instrument) {
      const inst = song.instruments[cell.instrument];
      if (inst) {
        ch.instrument = inst; ch.instIdx = cell.instrument;
        if (cell.note !== NOTE_OFF) ch.volume = 0x40;
        if (!isTonePorta) { ch.envPos = 0; ch.released = false; ch.releasePos = 0; }
      }
    }
    if (cell.note > 0 && cell.note !== NOTE_OFF && ((live?.voice === c && live.owner === 'z') || (pendingHit?.voice === c && pendingHit.owner === 'z'))) stopDrum(c);
    if (cell.note === NOTE_OFF) {
      release(ch);
      ch.retrig = 0; ch.retrigVolChange = 0; ch.noteCutTick = -1;
    } else if (cell.note > 0) {
      if (isTonePorta && ch.active) {
        ch.tonePortaTarget = freqToYmPeriod(noteToFreq(cell.note));
        ch.targetNote = cell.note;
      } else {
        ch.note = cell.note; ch.origNote = cell.note;
        ch.period = freqToYmPeriod(noteToFreq(cell.note));
        ch.active = true; ch.released = false; ch.envPos = 0; ch.releasePos = 0;
        ch.vibratoPos = 0; ch.tremoloPos = 0; ch.tremoloOffset = 0; ch.arpPos = 0; ch.pitchPos = 0; ch.periodOffset = 0;
        ch.forceHardEnv = false; ch.hardEnvPeriodOverride = 0; ch.hardEnvDivisorOverride = 0; ch.hardEnvShapeDirty = true;
        ch.portaUp = 0; ch.portaDown = 0; ch.tonePortaSpeed = 0; ch.tonePortaTarget = 0;
        ch.vibratoSpeed = 0; ch.vibratoDepth = 0; ch.tremoloSpeed = 0; ch.tremoloDepth = 0;
        ch.volSlide = 0; ch.arpeggio = 0; ch.retrig = 0; ch.noteCutTick = -1;
        ch.seqPos = 0; ch.relTick = 0; ch.fx = null;       // a new note ends a timer effect unless the cell sets one again
        startAdsr(ch);
        ch.freshTrigger = true;
        if (ch.instrument && ch.instrument.vibratoDepth > 0) {
          ch.vibratoSpeed = ch.instrument.vibratoSpeed; ch.vibratoDepth = ch.instrument.vibratoDepth;
        }
      }
    }
    if (cell.volume >= 0x10 && cell.volume <= 0x50) ch.volume = cell.volume - 0x10;
    if (cell.effect) applyEffect(c, cell.effect, cell.param);
    if (cell.effect !== 1) {
      if (ch.arpeggio && ch.origNote) ch.period = freqToYmPeriod(noteToFreq(ch.origNote));
      ch.arpeggio = 0;
    }
    if (cell.effect !== 2) ch.portaUp = 0;
    if (cell.effect !== 3) ch.portaDown = 0;
  }

  function release(ch: Chan) {
    ch.released = true; ch.releasePos = 0;
    if (ch.instrument?.seq) { ch.relTick = 0; ch.relStart = lastSeqLevel(ch); }
    if (ch.instrument?.adsr.useAdsr && ch.adsrPhase !== 'off' && ch.adsrPhase !== 'r') {
      ch.adsrPhase = 'r'; ch.adsrReleaseStart = ch.adsrLevel; ch.adsrTick = 0;
    }
  }

  function applyEffect(c: number, eff: number, p: number) {
    const ch = chans[c];
    switch (eff) {
      case 1: ch.arpeggio = p; break;
      case 2: if (p) ch.portaUp = p; break;
      case 3: if (p) ch.portaDown = p; break;
      case 4: if (p) ch.tonePortaSpeed = p; break;
      case 5: { const x = (p >> 4) & 15, y = p & 15; if (x) ch.vibratoSpeed = x; if (y) ch.vibratoDepth = y; break; }
      case 6: case 7: if (p) ch.volSlide = p; break;
      case 8: { const x = (p >> 4) & 15, y = p & 15; if (x) ch.tremoloSpeed = x; if (y) ch.tremoloDepth = y; break; }
      case 11: if (p) ch.volSlide = p; break;
      case 12: posJump = p; break;
      case 13: ch.volume = clampV(p); break;
      case 14: patternBreak = (p >> 4) * 10 + (p & 15); break;
      case 15: {
        const sub = (p >> 4) & 15, v = p & 15;
        switch (sub) {
          case 0x1: ch.period = Math.max(1, ch.period - v); break;
          case 0x2: ch.period = Math.min(4095, ch.period + v); break;
          case 0x6:
            if (v === 0) ch.loopRow = row;
            else {
              if (ch.loopCount < 0) ch.loopCount = v;
              if (ch.loopCount > 0) { ch.loopCount--; posJump = orderPos; patternBreak = ch.loopRow; }
              else ch.loopCount = -1;
            }
            break;
          case 0x9: ch.retrig = v; break;
          case 0xA: ch.volume = clampV(ch.volume + v); break;
          case 0xB: ch.volume = clampV(ch.volume - v); break;
          case 0xC: if (v > 0) ch.noteCutTick = v; break;
        }
        break;
      }
      case 16:
        if (p === 0) stopRequested = true;
        else if (p < 0x20) speed = p; else bpm = p;
        break;
      case 17: globalVolume = clampV(p); break;
      case 18: if (p) globalVolSlide = p; break;
      case 19: release(ch); break;
      case 20: if (ch.instrument) ch.envPos = Math.min(p, ch.instrument.volEnv.length - 1); break;
      case FX_M: ch.hardEnvPeriodOverride = (ch.hardEnvPeriodOverride & 0xff00) | (p & 0xff); break;
      case FX_P: ch.hardEnvDivisorOverride = Math.max(1, p); break;
      case FX_R: {
        const x = (p >> 4) & 15, y = p & 15;
        if (y > 0) { ch.retrig = y; ch.retrigVolChange = x; }
        else if (p === 0) ch.hardEnvShapeDirty = true;
        break;
      }
      case FX_X: ch.forceHardEnv = true; ch.hardEnvShape = p & 15; ch.hardEnvShapeDirty = true; break;
      case FX_Y: ch.hardEnvPeriodOverride = (ch.hardEnvPeriodOverride & 0x00ff) | ((p & 0xff) << 8); break;
      case FX_Q: ch.fx = p ? { kind: FX_SID, param: p } : null; break;
      case FX_S: ch.fx = p ? { kind: FX_SINUS, param: p } : null; break;
      case FX_U: ch.fx = p ? { kind: FX_SYNC, param: p } : null; break;
      case FX_Z: {
        if (p === 0) { stopDrum(c); break; }
        const d = ch.instrument?.digiDrums?.[p - 1];
        if (d) hitDrum(c, d, 'z'); else warn(`Z${p}`, `Z${p.toString(16).toUpperCase().padStart(2, '0')}: instrument ${ch.instIdx.toString(16).toUpperCase().padStart(2, '0')} has no digidrum ${p}`);
        break;
      }
    }
  }

  function processRow() {
    const patIdx = song.order[orderPos] ?? 0;
    const pat = song.patterns[patIdx];
    const rowCells = pat?.cells[row];
    if (!rowCells) return;
    for (let c = 0; c < nCh; c++) {
      const cell = rowCells[c];
      const ch = chans[c];
      ch.delayedCell = null; ch.noteDelayTick = -1;
      if (cell.effect === 15 && ((cell.param >> 4) & 15) === 0xD) {
        ch.noteDelayTick = cell.param & 15; ch.delayedCell = cell; continue;
      }
      triggerCell(c, cell);
    }
    if (drumCh >= 0 && rowCells[drumCh]) drumChannelCell(rowCells[drumCh]);
  }

  /** drum channel: a note picks digidrum (note-1) of the cell's instrument and plays it on voice C */
  let drumInst = 1;
  function drumChannelCell(cell: Cell) {
    if (cell.instrument && song.instruments[cell.instrument]) drumInst = cell.instrument;
    if (cell.note === NOTE_OFF) { stopDrum(VOICES - 1); return; }
    if (cell.note <= 0 || isMuted(drumCh)) return;
    const bank = song.instruments[drumInst]?.digiDrums ?? [];
    if (!bank.length) { warn('nobank', `drum channel: instrument ${drumInst.toString(16).toUpperCase().padStart(2, '0')} has no digidrums`); return; }
    hitDrum(VOICES - 1, bank[(cell.note - 1) % bank.length], 'chan');
  }

  /** the level a step-table instrument is at right now (before release scaling) */
  function seqStep(ch: Chan) {
    const sq = ch.instrument!.seq!;
    const n = sq.steps.length;
    if (!n) return null;
    let i = ch.seqPos;
    if (i >= n) {
      if (sq.loopFrom < 0 || sq.loopFrom >= n) return null;
      i = sq.loopFrom + ((i - sq.loopFrom) % (n - sq.loopFrom));
    }
    return sq.steps[i];
  }
  function lastSeqLevel(ch: Chan): number {
    const s = seqStep(ch);
    return s ? s.vol : 0;
  }

  function processTick() {
    if (tick > 0 && globalVolSlide) {
      const up = (globalVolSlide >> 4) & 15, dn = globalVolSlide & 15;
      if (up) globalVolume = clampV(globalVolume + up); else if (dn) globalVolume = clampV(globalVolume - dn);
    }
    for (let c = 0; c < VOICES; c++) {
      const dch = chans[c];
      if (dch.delayedCell && dch.noteDelayTick === tick) {
        const cell = dch.delayedCell; dch.delayedCell = null; dch.noteDelayTick = -1;
        triggerCell(c, { ...cell, effect: 0, param: 0 });
      }
    }
    for (const ch of chans) {
      if (!ch.active) continue;
      if (ch.noteCutTick >= 0 && tick >= ch.noteCutTick) { ch.volume = 0; ch.noteCutTick = -1; }
      if (ch.retrig > 0 && tick > 0 && tick % ch.retrig === 0) {
        ch.envPos = 0; ch.released = false; ch.releasePos = 0; ch.vibratoPos = 0; ch.tremoloPos = 0;
        ch.period = freqToYmPeriod(noteToFreq(ch.origNote)); ch.periodOffset = 0; ch.seqPos = 0; ch.relTick = 0;
        startAdsr(ch); ch.freshTrigger = true;
        switch (ch.retrigVolChange) {
          case 1: ch.volume = clampV(ch.volume - 1); break;
          case 2: ch.volume = clampV(ch.volume - 2); break;
          case 3: ch.volume = clampV(ch.volume - 4); break;
          case 4: ch.volume = clampV(ch.volume - 8); break;
          case 5: ch.volume = clampV(ch.volume - 16); break;
          case 6: ch.volume = clampV(Math.floor(ch.volume * 2 / 3)); break;
          case 7: ch.volume = clampV(Math.floor(ch.volume / 2)); break;
          case 9: ch.volume = clampV(ch.volume + 1); break;
          case 0xA: ch.volume = clampV(ch.volume + 2); break;
          case 0xB: ch.volume = clampV(ch.volume + 4); break;
          case 0xC: ch.volume = clampV(ch.volume + 8); break;
          case 0xD: ch.volume = clampV(ch.volume + 16); break;
          case 0xE: ch.volume = clampV(Math.floor(ch.volume * 3 / 2)); break;
          case 0xF: ch.volume = clampV(ch.volume * 2); break;
        }
      }
      if (ch.arpeggio) {
        const x = (ch.arpeggio >> 4) & 15, y = ch.arpeggio & 15;
        const sp = Math.max(1, ch.instrument?.arpSpeed ?? 1);
        const n = ch.origNote + [0, x, y][Math.floor(tick / sp) % 3];
        ch.period = freqToYmPeriod(noteToFreq(n));
      }
      if (tick > 0) {
        if (ch.portaUp) ch.period = Math.max(1, ch.period - ch.portaUp);
        if (ch.portaDown) ch.period = Math.min(4095, ch.period + ch.portaDown);
        if (ch.tonePortaTarget && ch.tonePortaSpeed > 0) {
          if (ch.period < ch.tonePortaTarget) ch.period = Math.min(ch.tonePortaTarget, ch.period + ch.tonePortaSpeed);
          else if (ch.period > ch.tonePortaTarget) ch.period = Math.max(ch.tonePortaTarget, ch.period - ch.tonePortaSpeed);
        }
        if (ch.volSlide) {
          const up = (ch.volSlide >> 4) & 15, dn = ch.volSlide & 15;
          if (up) ch.volume = clampV(ch.volume + up); else if (dn) ch.volume = clampV(ch.volume - dn);
        }
      }
      const im = ch.instrument;
      if (im && im.arpMacro.length && !ch.arpeggio && !ch.tonePortaTarget) {
        const off = im.arpMacro[ch.arpPos % im.arpMacro.length] ?? 0;
        if (off !== 0 || im.arpMacro.length > 1) ch.period = freqToYmPeriod(noteToFreq(ch.origNote + off));
      }
      let macroPitch = 0;
      if (im && im.pitchMacro.length) macroPitch = im.pitchMacro[ch.pitchPos % im.pitchMacro.length] ?? 0;
      if (ch.vibratoDepth) {
        ch.periodOffset = VIB_TABLE[ch.vibratoPos & 63] * ch.vibratoDepth / 128 + macroPitch;
        if (tick > 0) ch.vibratoPos += ch.vibratoSpeed;
      } else ch.periodOffset = macroPitch;
      if (ch.tremoloDepth) {
        ch.tremoloOffset = VIB_TABLE[ch.tremoloPos & 63] * ch.tremoloDepth / 64;
        if (tick > 0) ch.tremoloPos += ch.tremoloSpeed;
      } else ch.tremoloOffset = 0;
      if (ch.instrument && !ch.freshTrigger) {
        const inst = ch.instrument;
        if (inst.seq) {
          ch.seqPos++;
          if (ch.released) ch.relTick++;
        } else if (inst.adsr.useAdsr) stepAdsr(ch);
        else if (ch.released && inst.volRelease.length) { if (ch.releasePos < inst.volRelease.length) ch.releasePos++; }
        else if (inst.volEnv.length) { if (ch.envPos < inst.volEnv.length - 1) ch.envPos++; }
        if (inst.arpMacro.length > 1) ch.arpPos = (ch.arpPos + 1) % inst.arpMacro.length;
        if (inst.pitchMacro.length > 1) ch.pitchPos = (ch.pitchPos + 1) % inst.pitchMacro.length;
      }
      ch.freshTrigger = false;
    }
  }

  /** compute the 14 registers for the current tick into `r` */
  function collect(r: Uint8Array) {
    let mixer = 0x3f;
    let noiseP = -1;
    let envShape = -1, envPeriod = 0, envDirty = false;
    for (let c = 0; c < VOICES; c++) {
      const ch = chans[c];
      const off = () => { mixer |= (1 << c) | (8 << c); r[8 + c] = 0; };
      if (c >= nCh || c === drumCh || !ch.active || !ch.instrument || isMuted(c)) { off(); if (ch.hardEnvShapeDirty && !ch.active) ch.hardEnvShapeDirty = false; continue; }
      const inst = ch.instrument;
      let per = Math.round(ch.period + ch.periodOffset);
      let toneOn = inst.toneEnabled, noiseOn = inst.noiseEnabled, np = inst.noisePeriod;
      let volByte: number;
      if (inst.seq) {
        const st = seqStep(ch);
        if (!st) { ch.active = ch.released ? false : ch.active; off(); continue; }
        let lvl = st.vol;
        if (inst.seq.velocity) {
          const v = (clampV(ch.volume + Math.round(ch.tremoloOffset)) / 64) * (globalVolume / 64);
          lvl += v > 0 ? 2 * Math.log2(v) : -99;
        } else if (ch.volume === 0) lvl = 0;
        if (ch.released) {
          const rel = inst.seq.release;
          lvl = rel > 0 ? lvl * Math.max(0, 1 - (ch.relTick + 1) / (rel + 1)) : 0;
          if (ch.relTick >= rel) { ch.active = false; off(); continue; }
        }
        volByte = Math.max(0, Math.min(15, Math.round(lvl)));
        if (st.semi) per = Math.round((ch.period + ch.periodOffset) / Math.pow(2, st.semi / 12));
        toneOn = st.tone; noiseOn = st.noise > 0; np = st.noise;
        if (volByte === 0) { off(); continue; }
        if (inst.useHardEnv || ch.forceHardEnv) {
          // buzzer + step table: the steps gate the sound and drive the tone / noise (acid bass: buzzer at the note, square swept above it)
          volByte = 0x10;
          envShape = ch.forceHardEnv ? ch.hardEnvShape : inst.hardEnvShape; envPeriod = hardEnvPeriodFor(ch, inst);
          envDirty ||= ch.hardEnvShapeDirty; ch.hardEnvShapeDirty = false;
        }
      } else {
        let env = 15;
        if (inst.adsr.useAdsr) env = ch.adsrLevel;
        else if (ch.released && inst.volRelease.length) env = inst.volRelease[Math.min(ch.releasePos, inst.volRelease.length - 1)];
        else if (inst.volEnv.length) env = inst.volEnv[Math.min(ch.envPos, inst.volEnv.length - 1)];
        const chVol = clampV(ch.volume + Math.round(ch.tremoloOffset));
        const linear = Math.max(0, Math.min(64, Math.round((Math.max(0, Math.min(15, env)) / 15) * (chVol / 64) * (globalVolume / 64) * 64)));
        volByte = LINEAR_TO_YM_VOL[linear];
        if (inst.useHardEnv || ch.forceHardEnv) {
          if (linear === 0) { volByte = 0; mixer |= (1 << c) | (8 << c); ch.hardEnvShapeDirty = false; r[8 + c] = 0; continue; }
          volByte = 0x10;
          const shape = ch.forceHardEnv ? ch.hardEnvShape : inst.hardEnvShape;
          envShape = shape; envPeriod = hardEnvPeriodFor(ch, inst);
          envDirty ||= ch.hardEnvShapeDirty; ch.hardEnvShapeDirty = false;
          if (!inst.syncBuzz) toneOn = false;
        } else if (!inst.adsr.useAdsr && env === 0) {
          ch.active = false; off(); continue;
        }
      }
      per = Math.max(1, Math.min(4095, per));
      r[2 * c] = per & 0xff; r[2 * c + 1] = per >> 8;
      if (toneOn) mixer &= ~(1 << c);
      if (noiseOn) { mixer &= ~(8 << c); noiseP = np & 31; }
      r[8 + c] = volByte;
    }
    r[7] = 0xc0 | mixer;
    if (noiseP >= 0) r[6] = noiseP;
    if (envShape >= 0) { r[11] = envPeriod & 0xff; r[12] = (envPeriod >> 8) & 0xff; }
    r[13] = envShape >= 0 && envDirty ? envShape & 15 : 0xff;
  }

  // ---- main loop
  const regs = new Uint8Array(NREGS);
  regs.set(cur);
  let first = true;
  let ended = false;
  while (!ended && nextFrame < maxFrames) {
    if (tick === 0) {
      const key = `${orderPos}:${row}`;
      if (!opt.noLoopStop && visited.has(key) && !first) { loopFrame = visited.get(key)!; break; }
      visited.set(key, nextFrame);
      first = false;
      posJump = null; patternBreak = null;
      processRow();
      rows.push({ order: orderPos, row, frame: nextFrame });
      if (stopRequested) { stopRequested = false; ended = true; break; }
    }
    processTick();
    collect(regs);
    // emit every frame whose time falls inside this tick
    const dt = 2.5 / bpm;
    let emitted = false;
    while (nextFrame / FPS < tickTime + dt - 1e-9 && nextFrame < maxFrames) {
      if (nextFrame / FPS >= tickTime - 1e-9) {
        const f = Uint8Array.from(regs);
        if (pendingShape >= 0 && f[13] === 0xff) f[13] = pendingShape;
        pendingShape = -1;
        const fi = out.length / NREGS;
        let tg = 0;
        if (pendingHit) {
          const h: DrumHit = pendingHit; pendingHit = null;
          if (h.drum) { tg = trigCode(h.voice, drumIdx.get(h.drum)!); live = { voice: h.voice, owner: h.owner, endFrame: fi + drumFrames(h.drum) }; }
          else if (live) { tg = trigCode(h.voice, TRIG_STOP); live = null; }
        }
        if (live && fi >= live.endFrame) live = null;
        if (live) { f[8 + live.voice] = 0; f[7] |= (1 << live.voice) | (8 << live.voice); }   // the sample owns the voice
        trigOut.push(tg);
        // timer effect: the voice must be audible and not owned by a digidrum; only one effect can run at a time
        const fxCand: number[] = [];
        for (let c = 0; c < nCh; c++) {
          if (!chans[c].fx || isMuted(c) || (live && live.voice === c) || (f[8 + c] & 31) === 0) continue;
          fxCand.push(c);
        }
        const fxv = fxCand.includes(fxVoice) ? fxVoice : fxCand.length ? fxCand[0] : -1;   // keep the running one
        const many = fxCand.length > 1;
        if (many) warn('fxmany', 'timer effects (Q/S/U) on several voices at once: only one runs at a time (the ST has one spare timer), the others are ignored');
        let fxs = 0;
        if (fxv >= 0) {
          const cf = chans[fxv].fx!;
          const st = fxSetting(cf.kind, fxv, cf.param);
          if (st) {
            fxs = packFx(st);
            if (st.clamped) warn(`fxrate${cf.kind}${cf.param}`, `${FX_LETTERS[cf.kind]}${cf.param.toString(16).toUpperCase().padStart(2, '0')}: the timer cannot run that fast / slow, it plays at about ${Math.round(st.hz)} Hz`);
          }
        }
        fxVoice = fxv;
        fxOut.push(fxs);
        for (let k = 0; k < NREGS; k++) out.push(f[k]);
        emitted = true;
      }
      nextFrame++;
    }
    if (!emitted && regs[13] !== 0xff) pendingShape = regs[13];   // a slow tick-skip must not swallow an envelope restart
    // keep sticky registers (held across ticks)
    cur.set(regs);
    regs[13] = 0xff;
    tickTime += dt;
    tick++;
    if (tick >= speed) {
      tick = 0;
      let jumped = false;
      if (posJump !== null || patternBreak !== null) {
        jumped = true;
        if (posJump !== null) { orderPos = posJump; row = patternBreak ?? 0; }
        else { orderPos = orderPos + 1; row = patternBreak ?? 0; }
      } else row++;
      const pat = song.patterns[song.order[orderPos] ?? 0];
      if (row >= (pat?.rows ?? 64)) {
        row = 0;
        if (!jumped) orderPos++;
      }
      if (orderPos >= song.order.length) orderPos = Math.min(song.restartPos, song.order.length - 1);
      if (orderPos < 0) orderPos = 0;
    }
  }
  const nframes = out.length / NREGS;
  const drums = drumTable.length && trigOut.some((t) => t) ? { drums: drumTable, trig: Uint8Array.from(trigOut) } : undefined;
  const fx = fxOut.some((x) => x) ? Uint32Array.from(fxOut) : undefined;
  return { regs: Uint8Array.from(out), nframes, loopFrame, rows, warnings, drums, fx };
}
