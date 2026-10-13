/**
 * Arkos Tracker 3 import (.aks): the first PSG of the first subsong becomes an AY pattern editor song.
 *
 * Instruments become step-table instruments (one step per 20 ms tick, as the editor's own step tables). What Arkos applies
 * per note on top of the instrument - arpeggio tables / inline arpeggios, pitch tables, a running volume slide, and period-unit
 * pitch offsets (which depend on the note) - is baked into a copy of the instrument for that note, simulated tick by tick the
 * way the Arkos player runs it. Slides and glides stay pattern effects (1xx / 2xx / 3xx), volume stays in the volume column.
 *
 * Not carried over (counted in `warnings`): sample (digi) instruments, FM, PSGs after the first, event tracks, forced
 * arpeggio / pitch-table / instrument speeds, arpeggio or pitch-table changes in the middle of a note, legacy (AT2) files.
 */
import { type Song, type Cell, type Instrument, defaultInstrument, emptyPattern, NOTE_OFF, EFFECT_LETTERS } from '../tracker/types';
import type { MacroStep } from '../core/convert';
import { unzip, isZip } from '../import/unzip';
import { clamp } from '../export/bake';

export interface AksImport { song: Song; warnings: string[]; stats: { positions: number; instruments: number; variants: number; chipHz: number } }

// ------------------------------------------------------------------------------------------------ XML

interface X { n: string; t: string; c: X[] }
const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unesc = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m));

function parseXml(src: string): X {
  const root: X = { n: '#', t: '', c: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.t += m[1];
    else if (m[3]) {
      if (m[2]) { if (stack.length > 1) stack.pop(); }
      else {
        const node: X = { n: m[3], t: '', c: [] };
        top.c.push(node);
        if (!m[4]) stack.push(node);
      }
    } else if (m[5] !== undefined) top.t += unesc(m[5]);
  }
  return root;
}
const kids = (x: X | undefined, n: string) => (x ? x.c.filter((k) => k.n === n) : []);
const kid = (x: X | undefined, n: string) => x?.c.find((k) => k.n === n);
const txt = (x: X | undefined, n: string, d = '') => { const k = kid(x, n); return k ? k.t.trim() : d; };
const num = (x: X | undefined, n: string, d = 0) => { const v = Number(txt(x, n, '')); return txt(x, n, '') !== '' && Number.isFinite(v) ? v : d; };

// ------------------------------------------------------------------------------------------------ model

type Link = 'noSoftwareNoHardware' | 'softwareOnly' | 'hardwareOnly' | 'softwareAndHardware' | 'softwareToHardware' | 'hardwareToSoftware';
interface ICell { volume: number; noise: number; period: number; arp: number; pitch: number; link: Link; ratio: number; hwEnv: number; secPeriod: number; secArp: number; secPitch: number }
interface AInst { name: string; type: string; speed: number; looping: boolean; loopStart: number; end: number; cells: ICell[] }
/** arpeggio / pitch table, shift already folded in */
interface Expr { values: number[]; speed: number; loopStart: number; end: number }

const readCell = (x: X): ICell => ({
  volume: num(x, 'volume'), noise: num(x, 'noise'),
  period: num(x, 'primaryPeriod'), arp: num(x, 'primaryArpeggioNoteInOctave') + 12 * num(x, 'primaryArpeggioOctave'), pitch: num(x, 'primaryPitch'),
  link: (txt(x, 'link', 'softwareOnly') as Link), ratio: num(x, 'ratio', 4), hwEnv: num(x, 'hardwareEnvelope', 8),
  secPeriod: num(x, 'secondaryPeriod'), secArp: num(x, 'secondaryArpeggioNoteInOctave') + 12 * num(x, 'secondaryArpeggioOctave'), secPitch: num(x, 'secondaryPitch'),
});
function readExpr(x: X): Expr {
  const shift = num(x, 'shift');
  const values = [...Array<number>(shift).fill(0), ...kids(kid(x, 'values'), 'value').map((v) => Number(v.t.trim()) || 0)];
  if (!values.length) values.push(0);
  return { values, speed: num(x, 'speed'), loopStart: num(x, 'loopStartIndex') + shift, end: Math.min(values.length - 1, num(x, 'endIndex') + shift) };
}
const exprKey = (e: Expr | null) => (e ? `${e.speed}/${e.loopStart}/${e.end}:${e.values.join(',')}` : '-');
const isFlat = (e: Expr | null) => !e || e.values.every((v) => v === 0);

/** the player's expression reader: a value is held `speed + 1` ticks; after the end it loops */
class Reader {
  idx = 0; tick = 0;
  constructor(private e: Expr | null) {}
  value() { const e = this.e; if (!e) return 0; if (this.idx > e.end) this.idx = 0; return e.values[this.idx] ?? 0; }
  advance() {
    const e = this.e; if (!e) return;
    if (++this.tick > e.speed) {
      this.tick = 0;
      if (++this.idx > e.end) this.idx = e.loopStart;
      if (this.idx > e.end) this.idx = 0;
    }
  }
  key() { return `${this.idx}.${this.tick}`; }
}

/** Arkos note -> software period on a chip running at `hz` (the player's PsgPeriod formula) */
const arkPeriod = (hz: number, note: number) => {
  const n = clamp(note, 0, 127);
  return Math.round(hz / 8 / (440 * 2 ** (Math.floor(n / 12) - 3 + (((n % 12) + 1 - 10) / 12))));
};

// ------------------------------------------------------------------------------------------------ tick-by-tick bake

const MAXT = 256;
interface BakeIn {
  inst: AInst; arp: Expr | null; pit: Expr | null;
  /** note (Arkos numbering) for period-unit pitch work; null = integer semitone steps only */
  note: number | null;
  /** bake the track volume: start value (0..15) and slide per tick in 8.8 units */
  vol: { v0: number; slide: number } | null;
  hz: number;
}
interface Baked { steps: MacroStep[]; loopFrom: number; hw: ICell | null }

function bake(b: BakeIn): Baked {
  const { inst } = b;
  const arpR = new Reader(b.arp), pitR = new Reader(b.pit);
  let line = 0, itick = 0, alive = true;
  let vol = b.vol ? b.vol.v0 * 256 : 15 * 256;
  const steps: MacroStep[] = [];
  const seen = new Map<string, number>();
  let loopFrom = -1;
  let hw: ICell | null = null;
  const isHard: boolean[] = [];
  for (let t = 0; t < MAXT; t++) {
    const key = `${alive ? `${line}.${itick}` : 'x'}|${arpR.key()}|${pitR.key()}|${b.vol ? vol : 0}`;
    const prev = seen.get(key);
    if (prev !== undefined) { loopFrom = prev; break; }
    seen.set(key, t);
    const a = arpR.value(); arpR.advance();
    if (b.vol) vol = clamp(vol + b.vol.slide, 0, 15 * 256);
    const pt = pitR.value(); pitR.advance();
    if (!alive) { steps.push({ vol: 0, semi: 0, noise: 0, tone: false }); isHard.push(false); continue; }
    const c = inst.cells[line] ?? inst.cells[inst.cells.length - 1];
    const soft = c.link === 'softwareOnly' || c.link === 'softwareAndHardware' || c.link === 'softwareToHardware' || c.link === 'hardwareToSoftware';
    const hard = c.link === 'hardwareOnly' || c.link === 'softwareAndHardware' || c.link === 'softwareToHardware' || c.link === 'hardwareToSoftware';
    let v = c.volume;
    if (hard) { v = 15; if (!hw) hw = c; } else {
      if (b.vol) v = clamp(c.volume - (15 - Math.floor(vol / 256)), 0, 15);
    }
    let semi = a + c.arp;
    if (b.note !== null && (c.period || c.pitch || pt)) {
      // period-unit offsets: express the final software period as a (fractional) pitch offset from the played note
      const base = arkPeriod(b.hz, b.note);
      const target = c.period ? c.period : clamp(arkPeriod(b.hz, b.note + a + c.arp) - c.pitch - pt, 1, 0xfff);
      semi = 12 * Math.log2(base / target);
    }
    const noise = c.noise > 0 ? clamp(c.noise, 1, 31) : 0;
    const tone = soft;
    steps.push({ vol: tone || noise || hard ? v : 0, semi, noise, tone });
    isHard.push(hard);
    // advance the instrument
    if (++itick > inst.speed) {
      itick = 0;
      if (++line > inst.end) { if (inst.looping) line = inst.loopStart; else alive = false; }
    }
  }
  if (loopFrom < 0) loopFrom = steps.length - 1;                 // longer than MAXT ticks: hold the last step
  // in an envelope instrument the plain-tone cells keep their own sound through the per-step `plain` flag
  if (hw) steps.forEach((st, i) => { if (!isHard[i]) st.plain = true; });
  return { steps, loopFrom, hw };
}

// ------------------------------------------------------------------------------------------------ import

interface TCell { note?: number; instrument?: number; effects: { name: string; value: number }[] }
interface Ch {
  inst: number;                      // Arkos instrument index; -1 = none / stopped
  base: number;                      // Arkos note; -1 none
  vol: number;                       // track volume * 256 (8.8)
  vslide: number;                    // volume slide per tick (8.8)
  pslide: number;                    // pitch slide per tick in period units * 256, positive = period up = pitch down
  arp: Expr | null; pit: Expr | null;
  edVol: number;                     // the editor channel's volume column state (0..64)
  baked: boolean;                    // the note's instrument carries the volume slide
  slideOn: boolean;
}
const FX = (c: string) => EFFECT_LETTERS.indexOf(c) + 1;
const v64 = (v15: number) => clamp(Math.round(64 * 2 ** ((v15 - 15) / 2)), 0, 64);

async function readXml(data: Uint8Array): Promise<string> {
  if (isZip(data)) {
    const files = await unzip(data);
    const f = files.find((e) => /\.(aks|xml)$/i.test(e.name)) ?? files[0];
    if (!f) throw new Error('the .aks archive is empty');
    return new TextDecoder().decode(f.data);
  }
  return new TextDecoder().decode(data);
}

export async function aksToSong(data: Uint8Array, fileName = ''): Promise<AksImport> {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const warn = (k: string, m: string) => { if (!seen.has(k)) { seen.add(k); warnings.push(m); } };
  const counts = new Map<string, number>();
  const unsup = (t: string) => counts.set(t, (counts.get(t) ?? 0) + 1);

  const doc = parseXml(await readXml(data));
  const root = kid(doc, 'song');
  if (!root) {
    if (doc.c.some((x) => /song$/i.test(x.n))) throw new Error('this is a song from Arkos Tracker 2 (legacy format); open it in Arkos Tracker 3 and save it again');
    throw new Error('not an Arkos Tracker song (no <song> element)');
  }
  const fv = txt(root, 'formatVersion');
  if (!fv || !fv.startsWith('3')) throw new Error(`Arkos Tracker format ${fv || 'of Arkos Tracker 2 (legacy)'} is not supported; open it in Arkos Tracker 3 and save it again`);

  // ---- instruments, tables
  const insts: AInst[] = kids(kid(root, 'instruments'), 'instrument').map((x) => {
    const cells = kids(kid(x, 'cells'), 'cell').map(readCell);
    return {
      name: txt(x, 'name'), type: txt(x, 'type', 'psg'), speed: clamp(num(x, 'speed'), 0, 255), looping: txt(x, 'isLooping', 'true') === 'true',
      loopStart: num(x, 'loopStartIndex'), end: clamp(num(x, 'endIndex'), 0, Math.max(0, cells.length - 1)), cells: cells.length ? cells : [readCell({ n: 'cell', t: '', c: [] })],
    };
  });
  const arps = kids(kid(root, 'arpeggios'), 'expression').map(readExpr);
  const pits = kids(kid(root, 'pitches'), 'expression').map(readExpr);

  // ---- subsong
  const sub = kid(kid(root, 'subsongs'), 'subsong');
  if (!sub) throw new Error('the song has no subsong');
  if (kids(kid(root, 'subsongs'), 'subsong').length > 1) warn('subs', 'only the first subsong is imported');
  const psgs = kids(kid(sub, 'psgs'), 'psg');
  const hz = num(psgs[0], 'frequencyHz', 1_000_000) || 1_000_000;
  if (psgs.length > 1) warn('psgs', `${psgs.length} PSGs: only the first one (3 channels) is imported`);
  if (txt(psgs[0], 'type') === 'ay' || hz !== 2_000_000) warn('clock', `the chip runs at ${hz / 1e6} MHz; pitches are kept, period-unit offsets are scaled to the 2 MHz of the editor`);
  const k = 2_000_000 / hz;
  const replay = num(sub, 'replayFrequencyHz', 50) || 50;
  const bpm = clamp(Math.round(replay / 0.4), 32, 255);
  if (Math.abs(bpm * 0.4 - replay) > 0.05) warn('hz', `replay frequency ${replay} Hz becomes ${bpm * 0.4} Hz (BPM ${bpm})`);
  let speed = clamp(num(sub, 'initialSpeed', 6), 1, 31);
  if (num(sub, 'initialSpeed', 6) > 31) warn('spd', 'speeds above 31 ticks per row are not possible in the editor');

  const tracks = new Map<number, Map<number, TCell>>();
  for (const t of kids(kid(sub, 'tracks'), 'track')) {
    const m = new Map<number, TCell>();
    for (const c of kids(t, 'cell')) {
      const nn = kid(c, 'note'), ii = kid(c, 'instrument');
      m.set(num(c, 'index'), {
        note: nn ? num(c, 'note') : undefined, instrument: ii ? num(c, 'instrument') : undefined,
        effects: kids(c, 'effect').map((e) => ({ name: txt(e, 'name'), value: num(e, 'logicalValue') })),
      });
    }
    tracks.set(num(t, 'index'), m);
  }
  const speedTracks = new Map<number, Map<number, number>>();
  for (const t of kids(kid(sub, 'speedTracks'), 'speedTrack')) {
    const m = new Map<number, number>();
    for (const c of kids(t, 'cell')) m.set(num(c, 'index'), num(c, 'value'));
    speedTracks.set(num(t, 'index'), m);
  }
  const patterns = kids(kid(sub, 'patterns'), 'pattern').map((p) => {
    const idx: number[] = [];
    for (const ti of kids(p, 'trackIndexes')) for (const t of kids(ti, 'trackIndex')) idx.push(Number(t.t.trim()) || 0);
    const st = kid(p, 'speedTrackIndex');
    const speedIdx = st ? Number(kid(st, 'trackIndex')?.t.trim() ?? st.t.trim()) || 0 : 0;
    return { idx, speedIdx };
  });
  const positions = kids(kid(sub, 'positions'), 'position').map((p) => ({
    pattern: num(p, 'patternIndex'), height: Math.max(1, num(p, 'height', 64)), trans: kids(kid(p, 'transpositions'), 'transposition').map((t) => Number(t.t.trim()) || 0),
  }));
  const endPos = Math.min(positions.length - 1, num(sub, 'endPosition', positions.length - 1));
  const used = positions.slice(0, endPos + 1);
  if (!used.length) throw new Error('the song has no positions');
  if (used.length > 255) warn('pos', 'more than 255 positions: the song is cut');

  // ---- instruments for the editor: one base instrument per Arkos instrument, copies added on demand
  const out = newEditorSong(txt(root, 'title') || fileName.replace(/\.[^.]*$/, '') || 'Arkos song', txt(root, 'author') || txt(root, 'composer'));
  const edInsts: Instrument[] = out.instruments;
  const base = new Map<number, number>();
  const needsNote = new Map<number, boolean>();
  const mkInstrument = (name: string, bk: Baked, bakedVol: boolean): Instrument => {
    const ins = defaultInstrument(name.slice(0, 32));
    ins.adsr = { useAdsr: false, attack: 0, decay: 0, sustain: 15, release: 0 };
    ins.volEnv = [15]; ins.volRelease = [];
    ins.seq = { steps: bk.steps, loopFrom: bk.loopFrom, velocity: !bakedVol, release: 0 };
    ins.toneEnabled = true;
    if (bk.hw) {
      const c = bk.hw;
      ins.useHardEnv = true;
      ins.hardEnvShape = clamp(c.hwEnv, 0, 15);
      ins.hardEnvAutoPeriod = true; ins.hardEnvPeriod = 0;
      let div = 1;
      if (c.link === 'softwareToHardware') div = 2 ** (4 - c.ratio);
      else if (c.secPeriod) { ins.hardEnvAutoPeriod = false; ins.hardEnvPeriod = clamp(Math.round(c.secPeriod * k), 1, 65535); }
      else div = 16 * 2 ** (-c.secArp / 12);
      ins.hardEnvDivisor = div < 1 ? 1 : Math.round(div * 1000) / 1000;
      if (c.link === 'hardwareToSoftware') warn('h2s:' + name, `${name}: hardware-to-software link is played as hardware only`);

    }
    return ins;
  };
  edInsts.length = 1;                                              // [0] stays the unused placeholder
  for (let i = 0; i < insts.length; i++) {
    const a = insts[i];
    needsNote.set(i, a.cells.some((c) => c.period || c.pitch));
    if (i === 0) { base.set(0, 0); continue; }
    if (a.type !== 'psg') { warn('type:' + a.type, `${a.type} instruments (samples) are not imported; they play silence`); edInsts.push(defaultInstrument(a.name || `Instrument ${i}`)); edInsts[edInsts.length - 1].adsr = { useAdsr: true, attack: 0, decay: 0, sustain: 0, release: 0 }; base.set(i, edInsts.length - 1); continue; }
    if (edInsts.length > 255) { warn('inst', 'more than 255 instruments: the extra ones are left out'); base.set(i, 0); continue; }
    const bk = bake({ inst: a, arp: null, pit: null, note: null, vol: null, hz });
    base.set(i, edInsts.length);
    edInsts.push(mkInstrument(a.name || `Instrument ${i.toString(16).toUpperCase()}`, bk, false));
    if (needsNote.get(i)) warn('pitchnote:' + i, `instrument ${i.toString(16).toUpperCase().padStart(2, '0')} "${a.name}": period-unit pitch offsets depend on the note; each note gets its own copy`);
  }
  let variantCount = 0;
  const variants = new Map<string, number>();
  const variantFor = (ii: number, note: number, s: Ch): number => {
    const a = insts[ii];
    if (!a || a.type !== 'psg') return base.get(ii) ?? 0;
    const arp = isFlat(s.arp) ? null : s.arp, pit = isFlat(s.pit) ? null : s.pit;
    const bakeVol = s.vslide !== 0;
    const nn = !!needsNote.get(ii) || !!pit;
    if (!arp && !pit && !bakeVol && !nn) return base.get(ii) ?? 0;
    const key = `${ii}|${nn ? note : ''}|${exprKey(arp)}|${exprKey(pit)}|${bakeVol ? `${Math.floor(s.vol)}:${s.vslide}` : ''}`;
    let ix = variants.get(key);
    if (ix !== undefined) return ix;
    if (edInsts.length > 255) { warn('inst', 'more than 255 instruments (incl. per-note copies): the extra ones use the plain instrument'); return base.get(ii) ?? 0; }
    const bk = bake({ inst: a, arp, pit, note: nn ? note : null, vol: bakeVol ? { v0: Math.floor(s.vol / 256), slide: s.vslide } : null, hz });
    ix = edInsts.length;
    edInsts.push(mkInstrument(`${a.name || `Instrument ${ii}`}${nn ? ` n${note}` : ''}`, bk, bakeVol));
    variants.set(key, ix); variantCount++;
    return ix;
  };

  // ---- patterns
  const F = FX('F'), E_UP = FX('1'), E_DOWN = FX('2'), E_PORTA = FX('3');
  const chs: Ch[] = Array.from({ length: 3 }, () => ({ inst: -1, base: -1, vol: 15 * 256, vslide: 0, pslide: 0, arp: null, pit: null, edVol: 64, baked: false, slideOn: false }));
  const order: number[] = [];
  const edPatterns: Song['patterns'] = [];
  let lastSpeed = speed;
  const initialSpeed = speed;
  for (let pi = 0; pi < Math.min(255, used.length); pi++) {
    const pos = used[pi];
    const pat = patterns[pos.pattern];
    if (!pat) { warn('nopat', 'a position refers to a pattern that does not exist; it is left empty'); }
    const ep = emptyPattern(pos.height, 3);
    const spdTrack = pat ? speedTracks.get(pat.speedIdx) : undefined;
    for (let r = 0; r < pos.height; r++) {
      const sp = spdTrack?.get(r);
      let spChanged = false;
      if (sp !== undefined && sp !== lastSpeed) {
        if (sp < 1 || sp > 31) warn('spd', 'speeds above 31 ticks per row are not possible in the editor');
        else { lastSpeed = sp; speed = sp; spChanged = true; }
      }
      const row = ep.cells[r];
      for (let c = 0; c < 3; c++) {
        const tc = pat ? tracks.get(pat.idx[c] ?? -1)?.get(r) : undefined;
        processCell(chs[c], tc, row[c], pos.trans[c] ?? 0);
      }
      if (spChanged) {
        // the speed change: first free effect column of the row
        const free = row.find((cc) => !cc.effect);
        if (free) { free.effect = F; free.param = lastSpeed; } else unsup('speed changes on a row without a free effect column');
      }
      // advance the track volume by this row's ticks
      for (const s of chs) if (s.vslide) s.vol = clamp(s.vol + s.vslide * speed, 0, 15 * 256);
    }
    edPatterns.push(ep);
    order.push(pi);
  }

  function processCell(s: Ch, tc: TCell | undefined, cell: Cell, trans: number) {
    const effs = tc?.effects ?? [];
    const has = (n: string) => effs.find((e) => e.name === n);
    const glide = has('pitchGlide');
    const noteOn = tc?.note !== undefined && tc.note < 128;
    const noteStop = tc?.note !== undefined && tc.note >= 128 && tc.note !== 255;
    let startNote = false;
    if (noteStop) { s.inst = -1; cell.note = NOTE_OFF; s.slideOn = false; s.pslide = 0; }
    else if (noteOn && !glide) {
      startNote = true;
      s.base = tc!.note! + trans;
      s.vslide = 0; s.pslide = 0; s.slideOn = false; s.baked = false;
      if (tc!.instrument !== undefined) s.inst = tc!.instrument;
      else s.inst = -1;
    }
    // effects (state)
    let volumeSet = false;
    const hadMod = !isFlat(s.arp) || !isFlat(s.pit);
    for (const e of effs) {
      switch (e.name) {
        case 'volume': s.vol = clamp(e.value, 0, 15) * 256; s.vslide = 0; volumeSet = true; break;
        case 'volumeIn': s.vslide = clamp(e.value, 0, 0xffff); break;
        case 'volumeOut': s.vslide = -clamp(e.value, 0, 0xffff); break;
        case 'pitchUp': s.pslide = -clamp(e.value, 0, 0xffff); break;
        case 'pitchDown': s.pslide = clamp(e.value, 0, 0xffff); break;
        case 'fastPitchUp': s.pslide = -clamp(e.value * 16, 0, 0xffff); break;
        case 'fastPitchDown': s.pslide = clamp(e.value * 16, 0, 0xffff); break;
        case 'reset': s.vol = (15 - (e.value & 15)) * 256; s.vslide = 0; s.pslide = 0; s.arp = null; s.pit = null; volumeSet = true; break;
        case 'arpeggio3Notes': s.arp = { values: [0, (e.value >> 4) & 15, e.value & 15], speed: 0, loopStart: 0, end: 2 }; break;
        case 'arpeggio4Notes': s.arp = { values: [0, (e.value >> 8) & 15, (e.value >> 4) & 15, e.value & 15], speed: 0, loopStart: 0, end: 3 }; break;
        case 'arpeggioTable': s.arp = e.value > 0 && e.value < arps.length ? arps[e.value] : null; if (!startNote && s.arp) unsup('arpeggio table changes in the middle of a note'); break;
        case 'pitchTable': s.pit = e.value > 0 && e.value < pits.length ? pits[e.value] : null; if (!startNote && s.pit) unsup('pitch table changes in the middle of a note'); break;
        case 'pitchGlide': break;
        default: unsup(`effect ${e.name}`);
      }
    }
    if (!startNote && hadMod && isFlat(s.arp) && isFlat(s.pit)) unsup('arpeggio or pitch tables removed in the middle of a note (the instrument keeps cycling until the next note)');
    // the note
    if (startNote) {
      const edNote = s.base + 1;
      if (s.inst <= 0) { cell.note = NOTE_OFF; if (s.inst < 0) unsup('notes without an instrument'); }
      else if (edNote < 1 || edNote > 96) { unsup('notes outside the editor range (C-1 to B-8)'); cell.note = NOTE_OFF; }
      else {
        cell.note = edNote;
        cell.instrument = variantFor(s.inst, s.base, s);
        s.baked = s.vslide !== 0;
        s.edVol = 64;
      }
    } else if (glide && noteOn) {
      const edNote = tc!.note! + trans + 1;
      if (edNote >= 1 && edNote <= 96) { cell.note = edNote; s.base = tc!.note! + trans; cell.effect = E_PORTA; cell.param = glideParam(glide.value); }
      s.pslide = 0;
    }
    if (noteStop) s.edVol = 64;
    // volume column: keep the editor's volume equal to the track volume (a baked slide lives in the instrument)
    if (!s.baked) {
      // a slide that runs through the row is sampled in the middle of it (the editor's volume only changes per row)
      const mid = s.vslide ? clamp(s.vol + (s.vslide * speed) / 2, 0, 15 * 256) : s.vol;
      const want = v64(Math.floor(mid / 256));
      if (want !== s.edVol) { cell.volume = 0x10 + want; s.edVol = want; }
    } else if (volumeSet) {
      s.baked = false;
      const want = v64(Math.floor(s.vol / 256));
      if (want !== s.edVol) { cell.volume = 0x10 + want; s.edVol = want; }
    }
    // pitch slides: the editor needs the effect on every row
    if (s.pslide && !cell.effect) {
      const x = clamp(Math.round((Math.abs(s.pslide) / 256) * k * (speed / Math.max(1, speed - 1))), 1, 255);
      cell.effect = s.pslide < 0 ? E_UP : E_DOWN; cell.param = x;
      s.slideOn = true;
    } else if (s.pslide && cell.effect) unsup('pitch slides on a row whose effect column is taken');
  }
  function glideParam(v: number) { return clamp(Math.round((v / 256) * k * (speed / Math.max(1, speed - 1))), 1, 255); }

  for (const [t, n] of counts) if (t && n) warnings.push(`not imported: ${t} (${n}×)`);

  out.name = out.name.slice(0, 32);
  out.bpm = bpm; out.speed = initialSpeed;
  out.patterns = edPatterns; out.order = order;
  out.restartPos = clamp(num(sub, 'loopStartPosition'), 0, order.length - 1);
  return { song: out, warnings, stats: { positions: order.length, instruments: insts.length - 1, variants: variantCount, chipHz: hz } };
}

function newEditorSong(name: string, author: string): Song {
  return { name, author, bpm: 125, speed: 6, step: 1, order: [0], patterns: [emptyPattern(64, 3)], instruments: [defaultInstrument('--')], restartPos: 0, channelNames: ['A', 'B', 'C'], channelCount: 3, drumChannel: -1 };
}
