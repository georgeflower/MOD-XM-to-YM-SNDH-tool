/**
 * Arkos Tracker 3 export (.aks): the AY pattern editor's song as one subsong with one YM2149 (2 MHz, ABC), 50 Hz.
 *
 * An .aks is a zip holding one XML file (formatVersion 3.0). Notes, instruments, volume, 0xy arpeggios, 1xx/2xx slides,
 * 3xx glides, speed changes and the hardware envelope (buzzer, sync-buzzer, acid-style step tables) carry over; instruments are
 * baked into per-tick cells; a release tail becomes a second instrument that a note-off plays. What Arkos has no equivalent for is counted in `warnings` (vibrato effect,
 * digidrums, timer effects, sync-square, BPM changes); the 4xy vibrato becomes a pitch table. Step tables with fractional semitones get one instrument copy per note
 * (Arkos' pitch is in period units).
 *
 * Arkos facts used here (from the player source): note n sounds 440 * 2^((n - 57) / 12) Hz (so editor note n = Arkos n - 1);
 * the software period of a cell is the note's period, "SoftwareToHardware" with ratio r gives the envelope period
 * (software period >> r) so ratio 4 plays the envelope at the tone's pitch; "HardwareOnly" derives its period from
 * the note plus the secondary arpeggio (+4 octaves = envelope at the note's pitch); volume 16 means "envelope";
 * track volume SUBTRACTS (out = instrument volume - (15 - track volume)); effect values for slides are 8.8 fixed point.
 */
import {
  type Song, type Cell, type Instrument, NOTE_OFF, VOICES, channelsOf, EFFECT_LETTERS,
} from '../tracker/types';
import { bakeInstrument, clamp, logVol, gcd, type Tk } from '../export/bake';
import { noteToFreq } from '../tracker/types';
import { VIB_TABLE } from '../tracker/render';
import { zip } from '../export/zip';

export interface AksResult { xml: string; warnings: string[]; stats: { positions: number; patterns: number; tracks: number; instruments: number } }
export interface AksOptions { title?: string; author?: string; comment?: string }

type Link = 'noSoftwareNoHardware' | 'softwareOnly' | 'hardwareOnly' | 'softwareAndHardware' | 'softwareToHardware';
interface ICell { volume: number; noise: number; link: Link; arpNote: number; arpOct: number; pitch: number; ratio: number; hwEnv: number; secPeriod: number; secNote: number; secOct: number; retrig: boolean }
interface AInst { name: string; cells: ICell[]; loopStart: number; end: number; looping: boolean; retrig: boolean }

const MAX_CELLS = 255;

interface Compiled {
  main: AInst;
  /** the tail instrument for a note that has played `age` ticks; `pv` = the per-tick pitch of a per-note copy */
  release: ((age: number, pv?: number[]) => AInst) | null;
  /** step tables with fractional semitones: `copyFor(note)` is the instrument with the note's period correction (null = the plain one is close enough) */
  frac: boolean;
  copyFor: (note: number) => { key: string; inst: AInst; pv: number[] } | null;
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!)).replace(/[^\x09\x0a\x0d\x20-￿]/g, '');

/** split a (possibly negative) semitone offset into Arkos' note-in-octave + octave */
function splitSemi(n: number): { note: number; oct: number } {
  const oct = Math.floor(n / 12);
  return { note: n - oct * 12, oct };
}

const emptyCell = (): ICell => ({ volume: 0, noise: 0, link: 'noSoftwareNoHardware', arpNote: 0, arpOct: 0, pitch: 0, ratio: 4, hwEnv: 8, secPeriod: 0, secNote: 0, secOct: 0, retrig: false });

/** hardware part of a cell for an instrument that uses the envelope; returns false when the divisor cannot be expressed */
function hardLink(inst: Instrument, tone: boolean, warn: (k: string, m: string) => void, label: string): Pick<ICell, 'link' | 'ratio' | 'hwEnv' | 'secPeriod' | 'secNote' | 'secOct'> {
  const hwEnv = clamp(inst.hardEnvShape & 15, 8, 15) | 0;
  if (inst.hardEnvShape < 8) warn('shape:' + label, `${label}: envelope shape ${inst.hardEnvShape} is played as ${(inst.hardEnvShape < 4 ? 9 : 15)} (Arkos only has shapes 8-15)`);
  const shape = inst.hardEnvShape < 8 ? (inst.hardEnvShape < 4 ? 9 : 15) : hwEnv;
  if (!inst.hardEnvAutoPeriod && inst.hardEnvPeriod) {
    return { link: tone ? 'softwareAndHardware' : 'hardwareOnly', ratio: 4, hwEnv: shape, secPeriod: clamp(inst.hardEnvPeriod, 1, 0xffff), secNote: 0, secOct: 0 };
  }
  const div = Math.max(1, inst.hardEnvDivisor || 1);
  let k = Math.round(Math.log2(div));
  if (Math.abs(Math.log2(div) - k) > 1e-6) warn('div:' + label, `${label}: envelope divisor ${div} is not a power of two; played as ${2 ** k}`);
  k = clamp(k, 0, 4);
  // the editor derives the envelope period from the played note only (not from arpeggios, slides or the step table's
  // swept square), so the hardware period is independent of the software one
  if (tone) return { link: 'softwareAndHardware', ratio: 4, hwEnv: shape, secPeriod: 0, secNote: 0, secOct: 4 - k };
  return { link: 'hardwareOnly', ratio: 4, hwEnv: shape, secPeriod: 0, secNote: 0, secOct: 4 - k };
}

function compileInstrument(inst: Instrument, index: number, warn: (k: string, m: string) => void, rowTicks: number): Compiled {
  const label = `instrument ${index.toString(16).toUpperCase().padStart(2, '0')} "${inst.name}"`;
  const baked = bakeInstrument(inst, label, warn, MAX_CELLS, 'Arkos', 'period units', false, rowTicks);
  const { ticks, loopStart, looping, hard } = baked;
  if (inst.syncSquare) warn('syncsq:' + label, `${label}: sync-square is left out (Arkos has no equivalent)`);

  const hl = hard ? hardLink(inst, true, warn, label) : null;
  const hlNoTone = hard ? hardLink(inst, false, warn, label) : null;
  /** one baked tick -> one Arkos cell; `vol` overrides the tick's level (release tails) */
  const cellOf = (k: Tk, vol = k.vol, pitch = -Math.round(k.pitch)): ICell => {
    const c = emptyCell();
    c.noise = k.noise;
    const sp = splitSemi(k.semi);
    c.arpNote = sp.note; c.arpOct = sp.oct;
    c.pitch = pitch;                                             // Arkos subtracts the pitch: positive raises the sound
    if (hard && !k.plain) {
      if (vol === 0) { c.link = 'noSoftwareNoHardware'; c.volume = 0; c.noise = 0; }
      else {
        const h = k.tone ? hl! : hlNoTone!;
        c.link = h.link; c.ratio = h.ratio; c.hwEnv = h.hwEnv; c.secPeriod = h.secPeriod; c.secNote = h.secNote; c.secOct = h.secOct; c.volume = 15;
      }
    } else {
      c.volume = vol;
      c.link = k.tone ? 'softwareOnly' : 'noSoftwareNoHardware';
      if (!k.tone && !k.noise) c.volume = 0;
    }
    return c;
  };

  const cells = ticks.map((k) => cellOf(k));
  if (!cells.length) cells.push(emptyCell());
  const end = cells.length - 1;
  const ls = loopStart >= 0 ? Math.min(loopStart, end) : end;
  const main: AInst = { name: inst.name || `Instrument ${index}`, cells, loopStart: ls, end, looping, retrig: hard };

  // Arkos has no release phase: a note-off plays a second instrument that holds the sustained sound and runs the tail
  // (the level steps the editor plays after a note-off, ending in silence). It does not retrigger the hardware envelope.
  let release: Compiled['release'] = null;
  const n = ticks.length, cyc = loopStart >= 0 ? n - loopStart : 1;
  // the sustained part keeps cycling (arpeggio / pitch / vibrato) while the tail runs: `age` ticks have passed since the note started
  const idx = (t: number) => (t < n ? t : loopStart >= 0 ? loopStart + ((t - loopStart) % cyc) : n - 1);
  if (baked.release.length && n) {
    release = (age, pv) => {
      const rc = baked.release.map((v, j) => { const ti = idx(age + j); return cellOf(ticks[ti], v, pv ? pv[ti] : undefined); });
      return { name: `${inst.name || `Instrument ${index}`} (release)`, cells: rc, loopStart: rc.length - 1, end: rc.length - 1, looping: true, retrig: false };
    };
  }
  // step tables with fractional semitones: Arkos' pitch is in period units, so a per-note copy carries the correction
  const frac = ticks.some((t) => Math.abs(t.frac) > 0.02);
  const periodOf = (note: number, semi = 0) => 2_000_000 / (16 * noteToFreq(note) * 2 ** (semi / 12));
  const copyFor = (note: number) => {
    if (!frac) return null;
    const pn = Math.round(periodOf(note));
    const pv = ticks.map((k) => Math.round(Math.round(periodOf(note + k.semi)) - pn / 2 ** ((k.semi + k.frac) / 12)) - Math.round(k.pitch));
    if (pv.every((v, i) => Math.abs(v - cells[i].pitch) <= 1)) return null;
    return { key: pv.join(','), pv, inst: { ...main, cells: cells.map((c, i) => ({ ...c, pitch: pv[i] })) } };
  };
  return { main, release, frac, copyFor };
}

// ------------------------------------------------------------------------------------------------ patterns

interface ACell { index: number; note: number | null; instrument: number | null; effects: { name: string; value: number }[] }
interface ChState { vs: number; vd: number; vp: number; vkey: string; note: number; age: number; inst: number; last: number; vol15: number; arp: boolean; slide: boolean; vol64: number }

const FX = (c: string) => EFFECT_LETTERS.indexOf(c) + 1;

export function songToAks(song: Song, opts: AksOptions = {}): AksResult {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const warn = (k: string, m: string) => { if (!seen.has(k)) { seen.add(k); warnings.push(m); } };
  const counts = new Map<string, number>();
  const unsup = (text: string) => counts.set(text, (counts.get(text) ?? 0) + 1);

  const nch = Math.min(VOICES, channelsOf(song));
  if (channelsOf(song) > VOICES) warn('chan', `channels ${VOICES + 1}+ (drum channel / extra columns) are not exported`);

  // ---- instruments used by the song (index 0 is Arkos' empty instrument)
  const used = new Set<number>();
  for (const p of song.patterns) for (const row of p.cells) for (let c = 0; c < nch; c++) if (row[c]?.instrument) used.add(row[c].instrument);
  const instMap = new Map<number, number>();
  const comp = new Map<number, Compiled>();
  const relVariant = new Map<string, number>();
  const insts: AInst[] = [{ name: 'Empty', cells: [emptyCell()], loopStart: 0, end: 0, looping: true, retrig: false }];
  for (const i of [...used].sort((a, b) => a - b)) {
    const inst = song.instruments[i];
    if (!inst) continue;
    if (insts.length > 254) { warn('inst', 'more than 254 instruments: the extra ones are left out'); break; }
    instMap.set(i, insts.length);
    const ci = compileInstrument(inst, i, warn, song.speed || 6);
    insts.push(ci.main);
    comp.set(i, ci);
  }
  const addInst = (r: AInst, key: string, map: Map<string, number>): number => {
    let ix = map.get(key);
    if (ix === undefined) {
      if (insts.length > 254) { warn('inst', 'more than 254 instruments (incl. per-note copies and release tails): the extra ones use the plain instrument / silence'); return -1; }
      ix = insts.length; insts.push(r); map.set(key, ix);
    }
    return ix;
  };
  const copies = new Map<string, number>();
  // vibrato (4xy): a pitch table that replays the editor's sine, including its stall on the first tick of every row
  const pitchTabs: number[][] = [];
  const pitchKey = new Map<string, number>();
  const vibratoTable = (vs: number, vd: number, pos0: number, n: number): number => {
    const key = `${vs},${vd},${pos0 & 63},${n}`;
    let ix = pitchKey.get(key);
    if (ix !== undefined) return ix;
    if (pitchTabs.length >= 254) { warn('pitchfull', 'more than 254 vibrato tables: further vibrato phases are left out'); return 0; }
    const step = (vs * (n - 1)) % 64;
    let T = n * (64 / gcd(64, step || 64));
    if (!vs) T = 1;
    if (T > MAX_CELLS) { warn('vibcut', `vibrato (4xy): a vibrato cycle longer than ${MAX_CELLS} ticks is cut`); T = MAX_CELLS; }
    const vals: number[] = [];
    for (let t = 0; t < T; t++) {
      const idx = vs ? t - Math.ceil(t / n) : 0;
      vals.push(-Math.round(VIB_TABLE[(pos0 + vs * idx) & 63] * vd / 128));       // Arkos subtracts the pitch table value
    }
    pitchTabs.push(vals);
    ix = pitchTabs.length;                                                 // table 0 is the empty one
    pitchKey.set(key, ix);
    return ix;
  };
  /** the instrument to play editor note `note` with: the plain one, or its copy with the note's period correction */
  const playIndex = (ii: number, note: number): number => {
    const base = instMap.get(ii)!;
    const cp = comp.get(ii)?.copyFor(note);
    if (!cp) return base;
    const ix = addInst(cp.inst, `${ii}:${cp.key}`, copies);
    return ix < 0 ? base : ix;
  };
  /** the release instrument for editor instrument `ii` when its note has been playing for `age` ticks (identical tails are shared) */
  const releaseFor = (ii: number, note: number, age: number): number => {
    const c = comp.get(ii);
    if (!c?.release) return 0;
    const cp = c.copyFor(note);
    const r = c.release(age, cp?.pv);
    const ix = addInst(r, JSON.stringify(r.cells), relVariant);
    return ix < 0 ? 0 : ix;
  };

  // ---- tracks
  const tracks: ACell[][] = [];
  const trackKey = new Map<string, number>();
  const speedTracks: { index: number; value: number }[][] = [];
  const speedKey = new Map<string, number>();
  const addTrack = (cells: ACell[]): number => {
    const key = JSON.stringify(cells);
    let ix = trackKey.get(key);
    if (ix === undefined) { ix = tracks.length; tracks.push(cells); trackKey.set(key, ix); }
    return ix;
  };
  const addSpeed = (cells: { index: number; value: number }[]): number => {
    const key = JSON.stringify(cells);
    let ix = speedKey.get(key);
    if (ix === undefined) { ix = speedTracks.length; speedTracks.push(cells); speedKey.set(key, ix); }
    return ix;
  };

  const st: ChState[] = Array.from({ length: nch }, () => ({ vs: 0, vd: 0, vp: 0, vkey: '', note: 0, age: 0, inst: 0, last: -1, vol15: 15, arp: false, slide: false, vol64: 64 }));
  let speed = song.speed || 6;
  const initialSpeed = speed;
  const positions: { pattern: number; height: number }[] = [];
  const patterns: { tracks: number[]; speed: number }[] = [];

  for (let oi = 0; oi < song.order.length; oi++) {
    const pat = song.patterns[song.order[oi]];
    if (!pat) continue;
    let height = pat.rows;
    // pattern break (Dxx) ends this pattern early
    for (let r = 0; r < pat.rows; r++) {
      for (let c = 0; c < nch; c++) {
        const cell = pat.cells[r][c];
        if (cell.effect === FX('D')) { height = r + 1; if (((cell.param >> 4) * 10 + (cell.param & 15)) > 0) warn('dstart', 'pattern breaks that start the next pattern in the middle are exported as starting at its first row'); }
        if (cell.effect === FX('B')) warn('jump', 'position jumps (Bxx) are not exported (Arkos has no jump effect; the order list is played straight)');
      }
      if (height === r + 1) break;
    }
    const perChan: ACell[][] = Array.from({ length: nch }, () => []);
    const spd: { index: number; value: number }[] = [];
    for (let r = 0; r < height; r++) {
      const rowOuts: ACell[] = [];
      const vibCmd: (number | undefined)[] = [];
      const vibOff: boolean[] = [];
      for (let c = 0; c < nch; c++) {
        const cell: Cell = pat.cells[r][c];
        const s = st[c];
        const out: ACell = { index: r, note: null, instrument: null, effects: [] };
        const eff = cell.effect ? EFFECT_LETTERS[cell.effect - 1] : '';
        const p = cell.param;
        const noteOn = cell.note > 0 && cell.note < NOTE_OFF;
        const porta3 = eff === '3';
        if (cell.note === NOTE_OFF || (eff === 'K' && !noteOn && s.last >= 0)) {
          // note-off / key-off: the instrument's release tail (or silence)
          if (s.last >= 0) { out.note = s.last; out.instrument = releaseFor(s.inst, s.note, s.age); if (cell.note === NOTE_OFF) s.vol64 = 64; }
        } else if (noteOn) {
          const ar = cell.note - 1;
          if (ar < 0 || ar > 127) { warn('noterange', 'notes outside the Arkos range 0-127 are left out'); }
          else if (porta3 && s.last >= 0) {
            out.note = ar;                                             // glide target: no instrument, keeps playing
            s.last = ar;
          } else {
            const ii = cell.instrument ? cell.instrument : s.inst;
            const ai = ii ? instMap.get(ii) : undefined;
            if (ai === undefined) unsup('notes without an instrument');
            else {
              out.note = ar; out.instrument = playIndex(ii, cell.note); s.inst = ii; s.last = ar; s.age = 0; s.note = cell.note; if (s.vkey) vibOff[c] = true; s.vs = s.vd = s.vp = 0; s.vkey = '';
              if (cell.instrument) s.vol64 = 64;
            }
          }
        } else if (cell.instrument && instMap.has(cell.instrument)) {
          s.inst = cell.instrument;                                    // instrument without a note: only selects (the editor restarts, Arkos cannot)
          unsup('instrument columns without a note');
        }
        // volume column / C effect
        if (cell.volume >= 0x10 && cell.volume <= 0x50) s.vol64 = cell.volume - 0x10;
        if (eff === 'C') s.vol64 = clamp(p, 0, 64);
        const v15 = logVol(s.vol64);
        const volNeeded = (out.note !== null || cell.volume || eff === 'C') && v15 !== s.vol15;
        const effs: { name: string; value: number }[] = [];
        if (volNeeded) { effs.push({ name: 'volume', value: v15 }); s.vol15 = v15; }
        // arpeggio (not persistent in the editor, persistent in Arkos)
        if (eff === '0' && p) {
          effs.push({ name: 'arpeggio3Notes', value: p }); s.arp = true;
        } else if (s.arp && eff !== '0') { effs.push({ name: 'arpeggio3Notes', value: 0 }); s.arp = false; }
        else if (s.arp && eff === '0' && !p) { effs.push({ name: 'arpeggio3Notes', value: 0 }); s.arp = false; }
        // slides
        const perTick = (x: number) => clamp(Math.round(((x * Math.max(1, speed - 1)) / Math.max(1, speed)) * 256), 0, 0xffff);
        if ((eff === '1' || eff === '2') && p) { effs.push({ name: eff === '1' ? 'pitchUp' : 'pitchDown', value: perTick(p) }); s.slide = true; }
        else if (s.slide && !(eff === '1' || eff === '2')) { effs.push({ name: 'pitchUp', value: 0 }); s.slide = false; }
        if (eff === '3' && out.note !== null && out.instrument === null) effs.push({ name: 'pitchGlide', value: perTick(p || 1) });
        else if (eff === '3') unsup('tone portamento without a new note');
        // speed
        if (eff === 'F') {
          if (p === 0) { /* stop */ unsup('F00 stop'); }
          else if (p < 0x20) { speed = p; spd.push({ index: r, value: p }); }
          else warn('bpm', `tempo (BPM) changes are not exported (Arkos plays at one fixed replay frequency); the first BPM, ${song.bpm}, is used`);
        }
        // everything else
        if (eff && !'01234BCDFK'.includes(eff)) {
          const names: Record<string, string> = { '5': 'vibrato + volume slide', '6': 'volume slide', '7': 'tremolo', '8': 'tremolo', 'A': 'volume slide', 'E': 'extended effects (Exy)', 'G': 'global volume', 'H': 'global volume slide', 'L': 'envelope position', 'M': 'envelope period', 'P': 'envelope divisor', 'R': 'retrigger', 'T': 'effect T', 'X': 'envelope shape', 'Y': 'envelope period', 'Q': 'timer effects (Q/S/U)', 'S': 'timer effects (Q/S/U)', 'U': 'timer effects (Q/S/U)', 'Z': 'digidrums (Z)' };
          if (!(eff === '3' || eff === '1' || eff === '2' || eff === '4')) unsup(names[eff] ?? `effect ${eff}`);
        }
        out.effects = effs;
        rowOuts[c] = out;
        if (eff === '4') vibCmd[c] = p;
      }
      // vibrato (4xy): needs the row's final speed, so it runs after all channels of the row
      for (let c = 0; c < nch; c++) {
        const s = st[c], vc = vibCmd[c];
        const bi = song.instruments[s.inst];
        if (bi && bi.vibratoDepth > 0 && bi.vibratoSpeed > 0) { if (vc !== undefined) unsup('vibrato (4xy) on an instrument with built-in vibrato'); continue; }
        if (vc !== undefined) { if ((vc >> 4) & 15) s.vs = (vc >> 4) & 15; if (vc & 15) s.vd = vc & 15; }
        if (s.vd > 0) {
          const key = `${s.vs},${s.vd},${speed}`;
          if (key !== s.vkey) { rowOuts[c].effects.push({ name: 'pitchTable', value: vibratoTable(s.vs, s.vd, s.vp, speed) }); s.vkey = key; }
          else if (vibOff[c]) rowOuts[c].effects.push({ name: 'pitchTable', value: 0 });
          s.vp += s.vs * (speed - 1);
        } else if (vibOff[c]) rowOuts[c].effects.push({ name: 'pitchTable', value: 0 });      // a new note ends the editor's vibrato; Arkos' table keeps running
      }
      for (let c = 0; c < nch; c++) { const o = rowOuts[c]; if (o.note !== null || o.instrument !== null || o.effects.length) perChan[c].push(o); }
      for (const x of st) x.age += speed;                              // ticks since the note started (the row lasted `speed` ticks)
    }
    const tix = perChan.map((cells) => addTrack(cells));
    const sx = addSpeed(spd);
    patterns.push({ tracks: tix, speed: sx });
    positions.push({ pattern: patterns.length - 1, height });
  }

  for (const [t, n] of counts) warnings.push(`not exported: ${t} (${n}×)`);
  if (!positions.length) warnings.push('the song is empty');

  // ---- XML
  const L: string[] = [];
  const w = (s: string) => L.push(s);
  const rate = Math.round(song.bpm * 0.4 * 100) / 100;
  w('<?xml version="1.0" encoding="UTF-8"?>\n');
  w('<song xmlns:aks="https://www.julien-nevo.com/arkostracker/ArkosTrackerSong"\n      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="https://www.julien-nevo.com/arkostracker/schema/at3">');
  w('  <formatVersion>3.0</formatVersion>');
  w(`  <title>${esc(opts.title ?? song.name ?? '')}</title>`);
  w(`  <author>${esc(opts.author ?? song.author ?? '')}</author>`);
  w('  <composer></composer>');
  w(`  <comment>${esc(opts.comment ?? 'made with MOD-XM-to-YM-SNDH-tool')}</comment>`);
  w('  <creationDateMs>' + Date.now() + '</creationDateMs>');
  w('  <modificationDateMs>' + Date.now() + '</modificationDateMs>');
  w('  <instruments>');
  insts.forEach((ins, i) => {
    w('    <instrument>');
    w(`      <name>${esc(ins.name)}</name>`);
    w(`      <colorArgb>${i === 0 ? 4290822336 : 4289374752}</colorArgb>`);
    w('      <type>psg</type>');
    w(`      <speed>${i === 0 ? 255 : 0}</speed>`);
    w(`      <isRetrig>${ins.retrig}</isRetrig>`);
    w(`      <loopStartIndex>${ins.loopStart}</loopStartIndex>`);
    w(`      <endIndex>${ins.end}</endIndex>`);
    w(`      <isLooping>${ins.looping}</isLooping>`);
    w('      <isSfxExported>true</isSfxExported>');
    w('      <cells>');
    for (const c of ins.cells) {
      w('        <cell>');
      w(`          <volume>${c.volume}</volume>`);
      w(`          <noise>${c.noise}</noise>`);
      w('          <primaryPeriod>0</primaryPeriod>');
      w(`          <primaryArpeggioNoteInOctave>${c.arpNote}</primaryArpeggioNoteInOctave>`);
      w(`          <primaryArpeggioOctave>${c.arpOct}</primaryArpeggioOctave>`);
      w(`          <primaryPitch>${c.pitch}</primaryPitch>`);
      w(`          <link>${c.link}</link>`);
      w(`          <ratio>${c.ratio}</ratio>`);
      w(`          <hardwareEnvelope>${c.hwEnv}</hardwareEnvelope>`);
      w(`          <secondaryPeriod>${c.secPeriod}</secondaryPeriod>`);
      w(`          <secondaryArpeggioNoteInOctave>${c.secNote}</secondaryArpeggioNoteInOctave>`);
      w(`          <secondaryArpeggioOctave>${c.secOct}</secondaryArpeggioOctave>`);
      w('          <secondaryPitch>0</secondaryPitch>');
      w(`          <isRetrig>${c.retrig}</isRetrig>`);
      w('        </cell>');
    }
    w('      </cells>');
    w('    </instrument>');
  });
  w('  </instruments>');
  const expr = (arp: boolean) => `    <expression>\n      <name>Empty</name>\n      <isArpeggio>${arp}</isArpeggio>\n      <speed>0</speed>\n      <shift>0</shift>\n      <loopStartIndex>0</loopStartIndex>\n      <endIndex>0</endIndex>\n      <values>\n        <value>0</value>\n      </values>\n    </expression>`;
  w('  <arpeggios>\n' + expr(true) + '\n  </arpeggios>');
  const pitchXml = pitchTabs.map((vals, i) => `    <expression>\n      <name>Vibrato ${i + 1}</name>\n      <isArpeggio>false</isArpeggio>\n      <speed>0</speed>\n      <shift>0</shift>\n      <loopStartIndex>0</loopStartIndex>\n      <endIndex>${vals.length - 1}</endIndex>\n      <values>\n${vals.map((v) => `        <value>${v}</value>`).join('\n')}\n      </values>\n    </expression>`);
  w('  <pitches>\n' + [expr(false), ...pitchXml].join('\n') + '\n  </pitches>');
  w('  <subsongs>');
  w('    <subsong>');
  w(`      <title>${esc(song.name || 'Main')}</title>`);
  w(`      <initialSpeed>${initialSpeed}</initialSpeed>`);
  w('      <digiChannel>0</digiChannel>');
  w('      <highlightSpacing>4</highlightSpacing>');
  w('      <secondaryHighlight>4</secondaryHighlight>');
  w(`      <loopStartPosition>${clamp(song.restartPos, 0, Math.max(0, positions.length - 1))}</loopStartPosition>`);
  w(`      <endPosition>${Math.max(0, positions.length - 1)}</endPosition>`);
  w(`      <replayFrequencyHz>${rate}</replayFrequencyHz>`);
  w('      <psgs>\n        <psg>\n          <type>ym</type>\n          <frequencyHz>2000000</frequencyHz>\n          <referenceFrequencyHz>440</referenceFrequencyHz>\n          <samplePlayerFrequencyHz>11025</samplePlayerFrequencyHz>\n          <mixingOutput>ABC</mixingOutput>\n        </psg>\n      </psgs>');
  w('      <tracks>');
  tracks.forEach((cells, ti) => {
    w('        <track>');
    w(`          <index>${ti}</index>`);
    for (const c of cells) {
      w('          <cell>');
      w(`            <index>${c.index}</index>`);
      if (c.note !== null) w(`            <note>${c.note}</note>`);
      if (c.instrument !== null) w(`            <instrument>${c.instrument}</instrument>`);
      c.effects.forEach((e, k) => {
        w('            <effect>');
        w(`              <index>${k}</index>`);
        w(`              <name>${e.name}</name>`);
        w(`              <logicalValue>${e.value}</logicalValue>`);
        w('            </effect>');
      });
      w('          </cell>');
    }
    w('        </track>');
  });
  w('      </tracks>');
  w('      <speedTracks>');
  speedTracks.forEach((cells, si) => {
    w('        <speedTrack>');
    w(`          <index>${si}</index>`);
    for (const c of cells) w(`          <cell>\n            <index>${c.index}</index>\n            <value>${c.value}</value>\n          </cell>`);
    w('        </speedTrack>');
  });
  w('      </speedTracks>');
  w('      <eventTracks/>');
  w('      <positions>');
  for (const p of positions) {
    w('        <position>');
    w(`          <patternIndex>${p.pattern}</patternIndex>`);
    w(`          <height>${p.height}</height>`);
    w('          <markerName></markerName>');
    w('          <markerColor>4282400896</markerColor>');
    w('          <transpositions/>');
    w('        </position>');
  }
  w('      </positions>');
  w('      <patterns>');
  for (const p of patterns) {
    w('        <pattern>');
    for (const t of p.tracks) w(`          <trackIndexes>\n            <trackIndex>${t}</trackIndex>\n          </trackIndexes>`);
    w(`          <speedTrackIndex>\n            <trackIndex>${p.speed}</trackIndex>\n          </speedTrackIndex>`);
    w('          <eventTrackIndex>\n            <trackIndex>0</trackIndex>\n          </eventTrackIndex>');
    w('          <colorArgb>4286611584</colorArgb>');
    w('        </pattern>');
  }
  w('      </patterns>');
  w('    </subsong>');
  w('  </subsongs>');
  w('</song>\n');
  return { xml: L.join('\n'), warnings, stats: { positions: positions.length, patterns: patterns.length, tracks: tracks.length, instruments: insts.length - 1 } };
}

/** the .aks container: a zip with the XML inside */
export function aksFile(xml: string, name = 'song'): Uint8Array {
  return zip([{ name: `${name.replace(/[^A-Za-z0-9 _.-]/g, '_') || 'song'}.aks`, data: xml }]);
}
