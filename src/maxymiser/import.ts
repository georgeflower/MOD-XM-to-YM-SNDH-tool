/**
 * maxYMiser (.MYS song + .MYV voice bank, or a single .MYI) -> pattern song.
 *
 * Timing is 1:1 with the editor (one replay call = one tick, TC = BPM x 0.4), so each maxYMiser instrument can be
 * "played" tick by tick and written out as a step table:  volume, semitone offset (arpeggio, vibrato, fixed pitch and
 * coarse detune folded in), noise and tone per tick.  Buzzer sounds use the editor's hardware-envelope instrument
 * instead (with arpeggio / pitch macros), digidrum instruments become `digiDrums` + a Z effect, and instruments with a
 * SID / sync-buzzer timer get a Q / S / U effect on every note (timer rate = the note's frequency x the waveform steps).
 *
 * A maxYMiser cell has two effect slots, an editor cell has one: timer / digidrum triggers win over speed changes,
 * these over buzzer shape, vibrato, arpeggio and slides; what does not fit is counted in the warnings.
 */
import { type Song, type Instrument, type Cell, type StepSeq, NOTE_OFF, NUM_CHANNELS, defaultInstrument, emptyCell, emptyPattern, newSong, noteToFreq, parseEffectChar } from '../tracker/types';
import type { DrumSample } from '../core/drums';
import { fxParamForHz } from '../core/fx';
import { freqToYmPeriod } from '../tracker/render';
import { type MymBank, type MymSeq, type MymSong, type MymInstrumentFile, INST, MYM_ROWS, decodeBank, decodeSong, decodeInstrument } from './format';

const MIX_TONE = 0x0100, MIX_NOISE = 0x1000;
const MAX_STEPS = 512;
const ZERO_SEQ: MymSeq = { values: [0], length: 1, repeat: 0 };

export interface MymImport { song: Song; warnings: string[]; stats: { orders: number; patterns: number; instruments: number; drums: number } }

/** 4-bit YM level of a signed 8-bit sample byte (the replayer's own thresholds, not a linear scale) */
export function dacLevel(byte: number): number {
  const s = byte & 255;
  if (s < 8) return 13;
  if (s < 83) return 14;
  if (s < 128) return 15;
  const th = [128, 129, 130, 131, 133, 134, 136, 139, 143, 149, 158, 171, 190, 217];
  let level = 0;
  for (let i = 0; i < th.length; i++) { if (s < th[i]) break; level = i; }
  return level;
}

const i8 = (v: number) => ((v & 255) << 24) >> 24;
const i16 = (v: number) => ((v & 0xffff) << 16) >> 16;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const hex2 = (n: number) => (n & 255).toString(16).toUpperCase().padStart(2, '0');
const fxc = (b: number) => (b ? String.fromCharCode(b) : '');

// ------------------------------------------------------------------ sequences

const seqOf = (bank: MymBank, id: number): MymSeq => {
  const s = bank.sequences[id];
  return s && s.length > 0 ? s : ZERO_SEQ;
};
/** raw 16-bit value of a sequence `t` replay calls after the instrument started */
function seqValue(s: MymSeq, speed: number, t: number): number {
  const len = Math.max(1, Math.min(s.length, s.values.length || 1));
  const rep = Math.min(s.repeat, len - 1);
  let pos = Math.floor(t / Math.max(1, speed));
  if (pos >= len) pos = len - rep > 1 ? rep + ((pos - len) % (len - rep)) : len - 1;
  return s.values[pos] ?? 0;
}
/** ticks before the sequence is periodic, and the period (1 = it holds its last value) */
function seqShape(s: MymSeq, speed: number): { intro: number; period: number } {
  const len = Math.max(1, Math.min(s.length, s.values.length || 1));
  const rep = Math.min(s.repeat, len - 1);
  return len - rep <= 1 ? { intro: (len - 1) * speed, period: 1 } : { intro: rep * speed, period: (len - rep) * speed };
}

// ------------------------------------------------------------------ instruments

interface Built {
  inst: Instrument;
  kind: 'step' | 'hard' | 'digi';
  /** timer effect of the sound: 0 none, 5 SID, 11 sync-buzzer */
  timer: 0 | 5 | 11;
  tim: MymSeq | null;
  wave: number;
  /** digidrum parameters (sample slot 1..8, rate register, volume step of the first tick) */
  digi?: { sample: number; rate: number; vol: number };
  nameOf: string;
}

interface Ctx {
  bank: MymBank;
  warn: (key: string, msg: string) => void;
  refNote: (slot: number) => number;
}

const SILENT_SEQ: StepSeq = { steps: [{ vol: 0, semi: 0, noise: 0, tone: false }], loopFrom: 0, velocity: false, release: 0 };

function isEmptyRecord(r: Uint8Array): boolean {
  return !r[INST.volSeq] && !r[INST.mixSeq] && !r[INST.arpSeq] && !r[INST.name];
}

function buildInstrument(slot: number, r: Uint8Array, cx: Ctx): Built {
  const { bank, warn } = cx;
  const label = `instrument ${hex2(slot)}`;
  let nm = '';
  for (let i = 0; i < 16 && r[i]; i++) nm += r[i] >= 32 && r[i] < 127 ? String.fromCharCode(r[i]) : '?';
  nm = nm.trim();
  const sp = Math.max(1, r[INST.seqSpeed] || 1);
  const vol = seqOf(bank, r[INST.volSeq]), mix = r[INST.mixSeq] ? seqOf(bank, r[INST.mixSeq]) : { values: [MIX_TONE], length: 1, repeat: 0 };
  const arp = seqOf(bank, r[INST.arpSeq]), vib = seqOf(bank, r[INST.vibSeq]), noise = seqOf(bank, r[INST.noiseSeq]);
  const fix = seqOf(bank, r[INST.fixSeq]), tim = seqOf(bank, r[INST.timSeq]);
  const hasArp = !!r[INST.arpSeq], hasVib = !!r[INST.vibSeq], hasFix = !!r[INST.fixSeq], hasNoise = !!r[INST.noiseSeq];
  const instAtt = r[INST.volume];

  // one period of everything: intro (longest) + least common multiple of the loop lengths
  const seqs = [vol, mix, ...(hasArp ? [arp] : []), ...(hasVib ? [vib] : []), ...(hasNoise ? [noise] : []), ...(hasFix ? [fix] : [])];
  let intro = 0, period = 1;
  for (const s of seqs) { const sh = seqShape(s, sp); intro = Math.max(intro, sh.intro); period = Math.min(MAX_STEPS, (period * sh.period) / gcd(period, sh.period)); }
  let n = intro + period;
  if (n > MAX_STEPS) { warn('long:' + slot, `${label}: its sequences do not repeat within ${MAX_STEPS} ticks; cut`); n = MAX_STEPS; }
  n = Math.max(1, n);

  const mixAt = (t: number) => seqValue(mix, sp, t);
  let timer: 0 | 5 | 11 = 0, isDigi = false, buzz = false;
  const kinds = new Set<number>();
  for (let t = 0; t < n; t++) {
    const w = mixAt(t);
    kinds.add(w & 15);
    if (w & 0x00f0) buzz = true;
  }
  if (kinds.has(13)) isDigi = true;
  else if (kinds.has(5)) timer = 5;
  else if (kinds.has(11)) timer = 11;
  for (const k of kinds) if (k && k !== 13 && k !== 5 && k !== 11) warn('timer' + k + ':' + slot, `${label}: timer effect type ${k} is not supported by the replayer this tool targets (v1.29): ignored`);

  const base = defaultInstrument(nm || `Instrument ${slot}`);
  const wave = r[INST.wave] & 15;
  const timSeq = timer || isDigi ? tim : null;

  if (isDigi) {
    const inst = { ...base, seq: { ...SILENT_SEQ, steps: SILENT_SEQ.steps.map((s) => ({ ...s })) }, digiDrums: [] as DrumSample[] };
    const v0 = clamp(i16(seqValue(vol, sp, 0)), 0, 15);
    return { inst, kind: 'digi', timer: 0, tim: null, wave, digi: { sample: r[INST.sample], rate: r[INST.sampleRate], vol: Math.max(0, v0 - instAtt) }, nameOf: nm };
  }

  const maskOk = (mask: number, tone: boolean, bz: boolean, tm: boolean) => (mask & 4 && tone) || (mask & 2 && bz) || (mask & 1 && tm);
  const ref = cx.refNote(slot);
  const P = freqToYmPeriod(noteToFreq(ref));
  const semiOf = (t: number, tone: boolean, bz: boolean, tm: boolean): number => {
    let semi = 0;
    let per = P;
    const fixV = hasFix && maskOk(r[INST.fixMask], tone, bz, tm) ? seqValue(fix, sp, t) & 0xffff : 0xffff;
    let fixed = fixV !== 0xffff && fixV > 0;
    if (fixed) per = fixV;
    else if (!hasFix && maskOk(r[INST.fixMask], tone, bz, tm) && maskOk(r[INST.detuneMask], tone, bz, tm)) {   // "fixed de-tune": coarse:fine is the period
      const fp = (r[INST.detuneCoarse] << 8) | r[INST.detuneFine];
      if (fp > 0) { fixed = true; per = fp; }
    }
    else if (hasArp && maskOk(r[INST.arpMask], tone, bz, tm)) semi += i16(seqValue(arp, sp, t));
    if (hasVib && maskOk(r[INST.vibMask], tone, bz, tm)) per = Math.max(1, per - i16(seqValue(vib, sp, t)));
    if (per !== P) semi += 12 * Math.log2(P / per);
    if (r[INST.detuneMask] & 4 && tone && !fixed) semi += i8(r[INST.detuneCoarse]);
    return Math.round(semi * 1000) / 1000;
  };

  if (buzz) {
    // hardware-envelope sound
    const w0 = mixAt(0);
    const tone = !!(w0 & MIX_TONE), noiseOn = !!(w0 & MIX_NOISE);
    const inst: Instrument = { ...base, adsr: { ...base.adsr, useAdsr: false }, useHardEnv: true, hardEnvShape: wave, toneEnabled: tone, syncBuzz: tone, noiseEnabled: noiseOn, noisePeriod: noiseOn ? Math.max(1, hasNoise ? seqValue(noise, sp, 0) & 31 : 0) : 16, volRelease: [0] };
    if (timer === 11 && tim.values.length) inst.hardEnvShape = tim.values[0] & 15;
    // volume sequences do not shape a buzzer: any non-zero step is on
    const env: number[] = [];
    for (let t = 0; t < n; t++) env.push(clamp(i16(seqValue(vol, sp, t)) - instAtt, 0, 15) > 0 ? 15 : 0);
    const z = env.indexOf(0);
    inst.volEnv = z >= 0 ? env.slice(0, z + 1) : env.slice(0, Math.max(1, Math.min(env.length, intro + 1)));
    // arpeggio / pitch macros: the editor reads a macro entry before stepping it, so entry j plays at tick j + 1
    const arpV: number[] = [], pitchV: number[] = [];
    const total = Math.min(MAX_STEPS, n);
    for (let t = 1; t <= total; t++) {
      arpV.push(hasArp && maskOk(r[INST.arpMask], tone, true, false) ? i16(seqValue(arp, sp, t)) : 0);
      pitchV.push(hasVib && maskOk(r[INST.vibMask], tone, true, false) ? -i16(seqValue(vib, sp, t)) : 0);
    }
    if (arpV.some((x) => x)) inst.arpMacro = arpV;
    if (pitchV.some((x) => x)) inst.pitchMacro = pitchV;
    if (hasFix && r[INST.fixMask] & 2) {
      const f = fix.values[0] & 0xffff;
      if (f && f !== 0xffff) { inst.hardEnvAutoPeriod = false; inst.hardEnvPeriod = f; }
    } else if (r[INST.detuneMask] & 2) {
      const c = i8(r[INST.detuneCoarse]);
      if (c < 0 && c % 12 === 0 && -c / 12 <= 5) inst.hardEnvDivisor = 2 ** (-c / 12);
    }
    if (kinds.size > 1 && [...kinds].some((k) => k !== (w0 & 15))) warn('mixchg:' + slot, `${label}: the mixer changes over time; the first step is used`);
    return { inst, kind: 'hard', timer, tim: timSeq, wave: inst.hardEnvShape, nameOf: nm };
  }

  // tone / noise sound as a step table
  const steps: StepSeq['steps'] = [];
  let mixVaries = false;
  for (let t = 0; t < n; t++) {
    const w = mixAt(t);
    const tone = !!(w & MIX_TONE), noiseOn = !!(w & MIX_NOISE), tm = (w & 15) !== 0;
    if (w !== mixAt(0)) mixVaries = true;
    steps.push({
      vol: clamp(i16(seqValue(vol, sp, t)) - instAtt, 0, 15),
      semi: semiOf(t, tone, false, tm),
      noise: noiseOn ? Math.max(1, hasNoise ? seqValue(noise, sp, t) & 31 : 0) : 0,
      tone,
    });
  }
  void mixVaries;
  const inst: Instrument = { ...base, seq: { steps, loopFrom: intro, velocity: true, release: 0 } };
  return { inst, kind: 'step', timer, tim: timSeq, wave, nameOf: nm };
}

// ------------------------------------------------------------------ vibrato effect

/** 4xy of a vibrato sequence: x = phase step per tick (64 = one cycle), y = depth (amplitude = y / 2 period units) */
function vibratoParam(s: MymSeq, instSpeed: number, warn: () => void): number {
  const len = Math.max(1, Math.min(s.length, s.values.length));
  const vals = s.values.slice(0, len).map(i16);
  const amp = Math.max(...vals.map(Math.abs));
  if (!amp) return 0;
  const cycle = Math.max(2, (len - Math.min(s.repeat, len - 1)) * instSpeed);
  const x = clamp(Math.round(64 / cycle), 1, 15), y = clamp(Math.round(amp * 2), 1, 15);
  if (amp * 2 > 15) warn();
  return (x << 4) | y;
}

// ------------------------------------------------------------------ song

interface Track {
  inst: number;            // bank slot 1..32 (0 = none)
  att: number;             // attenuation of the voice
  active: boolean;
  arp: number;             // X parameter in force (0 = off)
  slide: number;           // H rate in force (signed, 0 = off)
  porta: number;           // P rate in force
  transpose: number;
  vib: number;             // 4xy currently loaded for the note (0 = the instrument's own)
  masks: number[];         // porta, arp, vib, transpose, fix, detune component masks in force
  fine: number;            // E (fine detune) in force
  lastNote: number;        // tracker note last played
  digiRate: number; digiSample: number;
  wave: number;
}

interface Cand { eff: string; p: number; prio: number; persist?: boolean }

export function maxymiserToSong(mys: Uint8Array, myv: Uint8Array | null, title = ''): MymImport {
  const ms = decodeSong(mys);
  const bank = myv ? decodeBank(myv) : null;
  return convertSong(ms, bank, title);
}

export function convertSong(ms: MymSong, bank0: MymBank | null, title = ''): MymImport {
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (k: string, m: string) => { if (!warned.has(k)) { warned.add(k); warnings.push(m); } };
  const counts = new Map<string, number>();
  const note = (text: string) => counts.set(text, (counts.get(text) ?? 0) + 1);
  if (!bank0) warn('nobank', 'no .MYV voice bank given: the instruments are left at the defaults');
  const bank: MymBank = bank0 ?? { version: 0, instruments: Array.from({ length: 32 }, () => new Uint8Array(64)), sequences: [ZERO_SEQ], samples: [], sampleVersion: 1 };

  // ---- song positions (looping "jam" patterns are jumped over, as the player does outside jam mode)
  const positions: number[] = [];
  let restart = 0;
  for (let i = 0; i < ms.length; i++) {
    const o = ms.orders[i];
    if (o.slice(0, 4).includes(0xfd)) { warn('jam', 'looping (jam) patterns in the song list are skipped'); if (i < ms.repeat) restart--; continue; }
    positions.push(i);
  }
  restart = positions.findIndex((p) => p >= ms.repeat);
  if (restart < 0) restart = 0;
  if (!positions.length) throw new Error('maxYMiser: the song list is empty');
  if (positions.some((p) => ms.orders[p][3] !== 0xff && ms.orders[p][3] < ms.patterns.length)) warn('dma', 'the STe DMA track (sampled sound) is not imported');

  const tc = clamp(ms.state[14] || 50, 50, 200);
  const bpm = Math.round(tc * 2.5);
  if (bpm > 255) warn('bpm', `replay rate ${tc} Hz = ${bpm} BPM; the BPM box of the editor stops at 255 (the song still plays at ${bpm})`);
  const speed0 = Math.max(2, ms.state[13] || 6);

  // first note each instrument is played with (fixed-pitch sounds are written relative to it)
  const firstNote = new Map<number, number>();
  for (const p of positions) {
    for (let t = 0; t < 3; t++) {
      const id = ms.orders[p][t];
      const pat = ms.patterns[id];
      if (!pat) continue;
      for (const c of pat) if (c.note >= 12 && c.inst && !firstNote.has(c.inst)) firstNote.set(c.inst, c.note - 11);
    }
  }
  const cx: Ctx = { bank, warn, refNote: (slot) => clamp(firstNote.get(slot) ?? 49, 1, 96) };

  // ---- instruments
  const built = new Map<number, Built>();
  let top = 0;
  bank.instruments.forEach((r, i) => { if (!isEmptyRecord(r)) top = i + 1; });
  const song = newSong(3);
  song.instruments = [song.instruments[0]];
  song.patterns = [];
  for (let slot = 1; slot <= Math.max(top, 1); slot++) {
    const r = bank.instruments[slot - 1];
    if (isEmptyRecord(r)) { song.instruments.push(defaultInstrument(`Instrument ${slot}`)); continue; }
    const b = buildInstrument(slot, r, cx);
    built.set(slot, b);
    song.instruments.push(b.inst);
  }
  const variants = new Map<string, number>();
  const variantOf = (slot: number, shift: number): number => {
    const key = `${slot}/${shift}`;
    let idx = variants.get(key);
    if (idx === undefined) {
      const base = song.instruments[slot];
      const copy: Instrument = { ...base, name: `${base.name} ${shift > 0 ? '+' : ''}${shift}`.slice(0, 24), seq: { ...base.seq!, steps: base.seq!.steps.map((x) => ({ ...x, semi: Math.round((x.semi + shift) * 1000) / 1000 })) } };
      song.instruments.push(copy);
      idx = song.instruments.length - 1;
      variants.set(key, idx);
    }
    return idx;
  };
  const drumCache = new Map<string, number>();
  let drumCount = 0;
  const drumFor = (slot: number, sample: number, rate: number, att: number): number => {
    const b = built.get(slot)!;
    const key = `${slot}/${sample}/${rate}/${att}`;
    const hit = drumCache.get(key);
    if (hit !== undefined) return hit;
    const smp = bank.samples[sample - 1];
    const lvl = clamp(b.digi!.vol - att, 0, 15);
    const pcm = new Uint8Array(smp ? smp.pcm.length : 0);
    for (let i = 0; i < pcm.length; i++) pcm[i] = lvl === 0 ? 0 : Math.max(0, dacLevel(smp.pcm[i]) + lvl - 15);
    const rateHz = 2_457_600 / (4 * Math.max(1, rate));
    if (!smp || !pcm.length) warn('nosmp:' + slot, `instrument ${hex2(slot)}: digidrum sample ${sample} is empty`);
    const drums = b.inst.digiDrums!;
    drums.push({ name: `${b.nameOf || 'drum'}${drums.length ? ' ' + (drums.length + 1) : ''}`.slice(0, 24), pcm, rateHz });
    drumCount++;
    drumCache.set(key, drums.length);
    return drums.length;                                         // 1-based: the Z parameter
  };

  // ---- patterns
  let speed = speed0;
  const tracks: Track[] = Array.from({ length: 3 }, () => ({ inst: 0, att: 0, active: false, arp: 0, slide: 0, porta: 0, transpose: 0, vib: 0, masks: [0, 0, 0, 0, 0, 0], fine: 0, lastNote: 0, digiRate: 0, digiSample: 0, wave: 0 }));
  const perTick = (p: number) => (speed > 1 ? clamp(Math.round((p * speed) / (speed - 1)), 1, 255) : clamp(p, 1, 255));
  const patKey = new Map<string, number>();
  const order: number[] = [];

  const attVolume = (b: Built | undefined, att: number): number => {
    if (b?.kind === 'hard') return 0x10 + (att >= 15 ? 0 : 64);
    if (b?.kind === 'step') return 0x10 + (att >= 15 ? 0 : Math.round(64 * Math.pow(2, -att / 2)));
    return 0x10 + (att >= 15 ? 0 : 64);
  };

  const timerCand = (b: Built, mNote: number): Cand | null => {
    const f = noteToFreq(mNote);
    if (!(f > 0)) return null;
    if (b.timer === 11) { const p = fxParamForHz(f); return p ? { eff: 'U', p, prio: 0 } : null; }
    if (b.timer === 5) {
      const t = b.tim ?? ZERO_SEQ;
      const n = Math.max(1, Math.min(16, t.length));
      const lv = new Set(t.values.slice(0, n).map((v) => 15 - Math.min(15, v & 15)));
      if (lv.size > 2) { warn('sidwave:' + b.nameOf, `instrument "${b.nameOf}": a SID waveform with more than two levels is played as a sine`); const p = fxParamForHz(f); return p ? { eff: 'S', p, prio: 0 } : null; }
      if (n !== 2 || lv.size !== 2) warn('sidpw:' + b.nameOf, `instrument "${b.nameOf}": a SID waveform that is not a plain square is played as a square`);
      const p = fxParamForHz(f * 2);
      return p ? { eff: 'Q', p, prio: 0 } : null;
    }
    return null;
  };

  for (const pos of positions) {
    const o = ms.orders[pos];
    const lanes: Cell[][] = [];
    let rows = MYM_ROWS;
    // pattern break: any track, either effect slot, ends the pattern after that row
    for (let t = 0; t < 3; t++) {
      const pat = o[t] < ms.patterns.length ? ms.patterns[o[t]] : null;
      if (!pat) continue;
      for (let r = 0; r < MYM_ROWS; r++) if (pat[r].fx1 === 0x42 || pat[r].fx2 === 0x42) { rows = Math.min(rows, r + 1); break; }
    }
    const lanes0: Cell[][] = [[], [], []];
    for (let r = 0; r < rows; r++) {                      // row by row: a speed change affects every track from its row on
      for (let t = 0; t < 3; t++) {
        const id = o[t];
        const pat = id < ms.patterns.length ? ms.patterns[id] : null;
        const lane = lanes0[t];
        const st = tracks[t];
        {
        const out = emptyCell();
        lane.push(out);
        let m = pat ? pat[r] : null;
        if (!m && id === 0xfe && r === 0) m = { note: 1, inst: 0, vol: 0, fx1: 0, p1: 0, fx2: 0, p2: 0 };
        if (!m) { // empty row: only persistent effects continue
          if (st.active) { const c = persistent(st); if (c) { out.effect = parseEffectChar(c.eff); out.param = c.p; } }
          continue;
        }
        const fx: [string, number][] = [];
        if (m.fx1) fx.push([fxc(m.fx1), m.p1]);
        if (m.fx2) fx.push([fxc(m.fx2), m.p2]);
        const has = (ch: string) => fx.find((f) => f[0] === ch);
        const cands: Cand[] = [];

        // --- state-changing effects first
        const sp = has('S'); if (sp && sp[1] >= 2) { speed = sp[1]; cands.push({ eff: 'F', p: sp[1], prio: 1 }); }
        const tr = has('T'); if (tr && st.masks[3]) st.transpose = i8(tr[1]);
        for (const [e1, v1] of fx) if (e1 >= '1' && e1 <= '6') st.masks[e1.charCodeAt(0) - 49] = v1 & 7;
        const dr = has('R'); if (dr) st.digiRate = dr[1];
        const dg = has('G'); if (dg) st.digiSample = dg[1];
        const wv = has('W'); if (wv) st.wave = wv[1] & 15;

        // --- note / instrument column (what the replayer does: an instrument column restarts the voice, even without a note)
        let trigger = false, mNote = 0, fresh = false;
        const portaFx = has('P');
        const instCol = m.inst && built.has(m.inst) ? m.inst : 0;
        if (m.inst && !instCol) note('instrument columns of empty slots');
        const hasNote = m.note >= 2;
        if (hasNote) {
          const raw = m.note - 11 + st.transpose;
          mNote = clamp(raw, 1, 96);
          if (raw < 1 || raw > 96) note('notes outside the editor\'s range (C-1..B-8) are clamped');
        }
        if (m.note === 1) {
          out.note = NOTE_OFF; st.active = false; st.arp = 0; st.slide = 0; st.porta = 0; st.vib = 0; st.fine = 0; st.lastNote = 0;
        } else if (hasNote && portaFx && st.active && st.masks[0]) {
          out.note = mNote; st.lastNote = mNote;                           // legato: slide from the old pitch
          if (instCol) { out.instrument = instCol; st.inst = instCol; }
        } else if (hasNote || instCol) {
          const slot = instCol || st.inst;
          const nn = hasNote ? mNote : st.lastNote;
          if (!slot || !built.has(slot)) note('notes before any instrument is chosen');
          else if (!nn) { st.inst = slot; out.instrument = slot; }          // an instrument with nothing to restart
          else {
            if (hasNote && !instCol) note('notes without an instrument column (maxYMiser only changes pitch, the editor restarts the instrument)');
            out.note = nn; out.instrument = slot; st.inst = slot; trigger = true; fresh = !!instCol;
            st.active = true; st.lastNote = nn; mNote = nn;
            if (instCol) { st.arp = 0; st.slide = 0; st.porta = 0; st.vib = 0; st.att = 0; st.transpose = 0; st.fine = 0; }
            const bb = built.get(slot)!;
            if (instCol) { st.masks = Array.from(bank.instruments[slot - 1].subarray(INST.portaMask, INST.detuneMask + 1)); }
            if (instCol) { st.digiRate = bb.digi?.rate ?? 0; st.digiSample = bb.digi?.sample ?? 0; st.wave = bb.wave; }
            if (dr) st.digiRate = dr[1];
            if (dg) st.digiSample = dg[1];
            if (wv) st.wave = wv[1] & 15;
          }
        }
        const b = st.inst ? built.get(st.inst) : undefined;
        const E = has('E'); if (E && st.masks[5]) st.fine = i8(E[1]);

        // --- volume column: any non-zero byte sets the attenuation (low nibble) until the next instrument column
        if (m.vol) st.att = m.vol & 15;
        if (b && b.kind !== 'digi' && (m.vol || (out.instrument && st.att > 0))) out.volume = attVolume(b, st.att);

        // --- fine detune: step tables get a copy of the instrument tuned for this note, anything else a fine slide
        if (st.fine && b && b.kind === 'step' && trigger && (st.masks[5] & 4)) {
          const per = freqToYmPeriod(noteToFreq(mNote));
          const shift = Math.round(12 * Math.log2(per / Math.max(1, per - st.fine)) * 50) / 50;
          if (shift) out.instrument = variantOf(st.inst, shift);
        } else if (st.fine && b && b.kind === 'hard' && E) {
          cands.push({ eff: 'E', p: (st.fine > 0 ? 0x10 : 0x20) | Math.min(15, Math.abs(st.fine)), prio: 2 });
        } else if (E && !trigger && b && b.kind === 'step') {
          cands.push({ eff: 'E', p: (st.fine > 0 ? 0x10 : 0x20) | Math.min(15, Math.abs(st.fine)), prio: 2 });
        }
        void fresh;

        // --- instrument-driven triggers
        if (trigger && b) {
          if (b.kind === 'digi') {
            const idx = drumFor(st.inst, st.digiSample, st.digiRate, st.att);
            cands.push({ eff: 'Z', p: idx, prio: 0 });
          } else if (b.timer) {
            const c = timerCand(b, mNote);
            if (c) cands.push(c);
          }
        }

        // --- the rest of the effects
        for (const [e, p] of fx) {
          switch (e) {
            case 'S': case 'T': case 'R': case 'G': case 'B': case 'W': break;
            case 'X': {
              if (!st.masks[1]) break;
              st.arp = p;
              if (p) {
                let hi = (p >> 4) & 15, lo = p & 15;
                if (hi === 15) hi = lo; else if (lo === 15) lo = hi;      // two-step arpeggio
                st.arp = (hi << 4) | lo;
                cands.push({ eff: '0', p: st.arp, prio: 5 });
              }
              break;
            }
            case 'H': {
              if (!st.masks[0]) break;
              const v = i8(p);
              st.slide = v; st.porta = 0;
              if (v) cands.push({ eff: v > 0 ? '1' : '2', p: perTick(Math.abs(v)), prio: 6 });
              break;
            }
            case 'P': {
              if (!st.masks[0]) break;
              st.porta = p; st.slide = 0;
              if (p) cands.push({ eff: '3', p: perTick(p), prio: 4 });
              break;
            }
            case 'V': {
              if (!p || !st.masks[2]) break;
              const key = (p << 8) | speedOf(st.inst);
              if (st.vib !== key) {
                const par = vibratoParam(seqOf(bank, p), speedOf(st.inst), () => warn('vibdepth', 'vibrato sequences deeper than the editor\'s 4xy vibrato (about 7 period units) are shortened'));
                if (par) cands.push({ eff: '4', p: par, prio: 4 });
                st.vib = key;
              }
              break;
            }
            case 'M': {
              const sq = seqOf(bank, p);
              if (sq.values.some((v) => v & 0x00f0) && b && b.kind !== 'hard') cands.push({ eff: 'X', p: st.wave & 15, prio: 3 });
              else if (!sq.values.some((v) => v & 0x00f0) && b?.kind === 'hard') note('mixer sequence changes (M) that switch a buzzer off');
              break;
            }
            case 'E': break;
            case 'D': case 'C': case 'Y': case 'Z': case 'U': case 'O': note(`effect ${e} (coarse detune, sync, timer allocation, noise transpose, microwire)`); break;
            case 'A': case 'F': case 'I': case 'L': case 'N': case 'Q': note(`sequence-switching effects (A F I L N Q)`); break;
            case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9': case '0': break;
            default: note(`unknown effect ${e}`);
          }
        }
        if (wv && b && !(b.kind === 'hard' && st.wave === b.wave) && b.kind !== 'digi') cands.push({ eff: 'X', p: st.wave & 15, prio: 3 });
        { const pc = persistent(st); if (pc && st.active && !cands.some((c) => c.prio >= 5)) cands.push(pc); }
        cands.sort((a, c) => a.prio - c.prio);
        if (cands[0]) { out.effect = parseEffectChar(cands[0].eff); out.param = cands[0].p; }
        const dropped = cands.slice(1).filter((c) => !c.persist);
        if (dropped.length) note(`effects that did not fit in the editor's single effect slot (${[...new Set(dropped.map((c) => c.eff))].join(' ')})`);
        }
      }
    }
    lanes.push(...lanes0);
    const pat = emptyPattern(rows, NUM_CHANNELS);
    for (let r = 0; r < rows; r++) for (let t = 0; t < 3; t++) pat.cells[r][t] = lanes[t][r];
    const key = JSON.stringify(pat.cells);
    let idx = patKey.get(key + rows);
    if (idx === undefined) { idx = song.patterns.length; song.patterns.push(pat); patKey.set(key + rows, idx); }
    order.push(idx);
  }

  function speedOf(slot: number): number { return Math.max(1, bank.instruments[slot - 1]?.[INST.seqSpeed] || 1); }
  /** effects that continue from row to row in maxYMiser but have to be repeated in the editor */
  function persistent(st: Track): Cand | null {
    if (st.arp) return { eff: '0', p: st.arp, prio: 5, persist: true };
    if (st.slide) return { eff: st.slide > 0 ? '1' : '2', p: perTick(Math.abs(st.slide)), prio: 6, persist: true };
    return null;
  }

  song.name = title.replace(/\.[^.]*$/, '').slice(0, 32) || 'maxYMiser song';
  song.bpm = bpm; song.speed = speed0;
  song.order = order; song.restartPos = clamp(restart, 0, order.length - 1);
  song.channelCount = 3; song.drumChannel = -1;
  for (const [text, n] of counts) warn('c:' + text, `not imported: ${text}${n > 1 ? ` (${n}×)` : ''}`);
  return { song, warnings, stats: { orders: order.length, patterns: song.patterns.length, instruments: built.size, drums: drumCount } };
}

// ------------------------------------------------------------------ .MYI

/** a single maxYMiser instrument as an editor instrument (digidrum instruments keep the sample the file carries) */
export function myiToInstrument(f: MymInstrumentFile | Uint8Array): { inst: Instrument; warnings: string[] } {
  const file = f instanceof Uint8Array ? decodeInstrument(f) : f;
  const warnings: string[] = [];
  const bank: MymBank = { version: 0, instruments: [], sequences: [ZERO_SEQ], samples: [], sampleVersion: 1 };
  const rec = new Uint8Array(64);
  rec.set(file.inst.subarray(0, 48));
  file.sequences.slice(0, 7).forEach((s, i) => { bank.sequences.push(s); rec[[INST.volSeq, INST.arpSeq, INST.vibSeq, INST.mixSeq, INST.noiseSeq, INST.fixSeq, INST.timSeq][i]] = i + 1; });
  bank.instruments = [rec];
  if (file.sample && file.sample.length) bank.samples = [{ pcm: file.sample, params: new Uint8Array(4) }];
  const cx: Ctx = { bank, warn: (_k, m) => warnings.push(m), refNote: () => 49 };
  const b = buildInstrument(1, rec, cx);
  if (b.kind === 'digi' && b.digi) {
    const smp = file.sample ?? new Uint8Array(0);
    const lvl = b.digi.vol;
    const pcm = Uint8Array.from(smp, (x) => (lvl === 0 ? 0 : Math.max(0, dacLevel(x) + lvl - 15)));
    b.inst.digiDrums = [{ name: b.nameOf || 'drum', pcm, rateHz: 2_457_600 / (4 * Math.max(1, b.digi.rate)) }];
  }
  if (b.timer) warnings.push(`this instrument uses a ${b.timer === 5 ? 'SID' : 'sync-buzzer'} timer: put a ${b.timer === 5 ? 'Q' : 'U'} effect next to its notes`);
  return { inst: b.inst, warnings };
}
