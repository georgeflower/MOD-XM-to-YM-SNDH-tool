/**
 * Editor state for the AY pattern editor: song, cursor, selection, clipboard, undo, order list.
 * A tiny external store (useSyncExternalStore friendly); every change replaces the song immutably
 * (only touched rows are copied) so undo is just a stack of song references.
 *
 * Edit operations follow the YM Tracker / FastTracker 2 behaviour.
 */
import {
  type Song, type Cell, type Instrument, type Pattern,
  emptyCell, emptyPattern, defaultInstrument, newSong, NOTE_OFF, VOICES, noteToFreq,
} from './types';
import { renderSong, type RenderResult, type RowMark } from './render';
import { renderYm } from '../export/ymemu';
import type { DrumTrack } from '../core/drums';

export type Column = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;      // note, inst hi/lo, vol hi/lo, fx letter, param hi/lo
export interface Sel { r1: number; c1: number; r2: number; c2: number }
export type Scope = 'block' | 'track' | 'pattern' | 'song';

interface Clip { kind: 'track' | 'pattern' | 'block'; cells: Cell[][] }

/** what the editor needs from the audio side (the shared Preview satisfies it) */
export interface AudioSink {
  setAy(pcm: Float32Array, sr?: number): void;
  play(from?: number): Promise<void> | void;
  stop(): void;
  position(): number;
  readonly playing: boolean;
  audition?(pcm: Float32Array, sr?: number): void;
  stopAudition?(): void;
  /** switch the output to the YM side before playing */
  setSource?(s: 'orig' | 'ay'): void;
}

const MAX_UNDO = 200;
const cloneCell = (c: Cell): Cell => ({ ...c });

export class Editor {
  song: Song = newSong(3);
  orderPos = 0;
  row = 0;
  channel = 0;
  column: Column = 0;
  octave = 4;
  editing = false;
  instrument = 1;
  step = 1;
  anchor: { row: number; channel: number } | null = null;
  sel: Sel | null = null;
  muted = [false, false, false];
  soloed = [false, false, false];
  playing = false;
  playMode: 'song' | 'pattern' = 'song';
  playOrder = 0;
  playRow = 0;
  followPlay = true;
  warnings: string[] = [];
  renderInfo = '';
  fileName = '';
  dirty = false;

  version = 0;
  private listeners = new Set<() => void>();
  private undoStack: Song[] = [];
  private redoStack: Song[] = [];
  private clip: Clip | null = null;
  private audio: AudioSink | null = null;
  private lastRender: { regs: Uint8Array; nframes: number; loopFrame: number; rows: RowMark[]; key: string; drums?: DrumTrack } | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private patternSong: Song | null = null;       // temp song while looping one pattern

  // ---------- store plumbing
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = () => this.version;
  private emit() { this.version++; for (const l of this.listeners) l(); }
  attachAudio(a: AudioSink) { this.audio = a; }

  get pattern(): Pattern { return this.song.patterns[this.song.order[this.orderPos] ?? 0]; }
  get patIdx(): number { return this.song.order[this.orderPos] ?? 0; }
  get rows(): number { return this.pattern?.rows ?? 64; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get lastRegs() { return this.lastRender; }

  // ---------- song replacement / history
  private commit(next: Song, opts: { audio?: boolean } = {}) {
    this.undoStack.push(this.song);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.song = next;
    this.dirty = true;
    this.clamp();
    if (opts.audio !== false) this.scheduleRefresh();
    this.emit();
  }
  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.song); this.song = s; this.clamp(); this.scheduleRefresh(); this.emit();
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.song); this.song = s; this.clamp(); this.scheduleRefresh(); this.emit();
  }
  private clamp() {
    const s = this.song;
    this.orderPos = Math.max(0, Math.min(s.order.length - 1, this.orderPos));
    this.row = Math.max(0, Math.min(this.rows - 1, this.row));
    this.instrument = Math.max(1, Math.min(s.instruments.length - 1, this.instrument));
    this.step = s.step;
  }
  loadSong(song: Song, fileName = '') {
    this.stop();
    this.song = song; this.undoStack = []; this.redoStack = [];
    this.orderPos = 0; this.row = 0; this.channel = 0; this.column = 0; this.sel = null; this.anchor = null;
    this.instrument = 1; this.fileName = fileName; this.dirty = false;
    this.lastRender = null;
    this.clamp();
    this.scheduleRefresh();
    this.emit();
  }
  newSong() { this.loadSong(newSong(3), ''); }

  /** copy-on-write edit of the rows of one pattern */
  private mutate(patIdx: number, fn: (w: (r: number) => Cell[]) => void, extra?: (s: Song) => Song): void {
    const p = this.song.patterns[patIdx];
    if (!p) return;
    const cells = p.cells.slice();
    const touched = new Set<number>();
    const w = (r: number) => {
      if (!touched.has(r)) { cells[r] = cells[r].map(cloneCell); touched.add(r); }
      return cells[r];
    };
    fn(w);
    const patterns = this.song.patterns.slice();
    patterns[patIdx] = { ...p, cells };
    let next: Song = { ...this.song, patterns };
    if (extra) next = extra(next);
    this.commit(next);
  }

  // ---------- cursor
  setCursor(row: number, channel?: number, column?: Column) {
    this.row = Math.max(0, Math.min(this.rows - 1, row));
    if (channel !== undefined) this.channel = Math.max(0, Math.min(VOICES - 1, channel));
    if (column !== undefined) this.column = column;
    this.emit();
  }
  moveCursor(dr: number, dc = 0) {
    let r = this.row + dr;
    if (r < 0) r = this.rows - 1;
    if (r >= this.rows) r = 0;
    let c = this.channel + dc;
    if (c < 0) c = VOICES - 1;
    if (c >= VOICES) c = 0;
    this.row = r; this.channel = c;
    this.emit();
  }
  moveColumn(d: number) {
    let col = this.column + d, ch = this.channel;
    while (col < 0) { col += 8; ch--; }
    while (col > 7) { col -= 8; ch++; }
    if (ch < 0) ch = VOICES - 1;
    if (ch >= VOICES) ch = 0;
    this.column = col as Column; this.channel = ch;
    this.emit();
  }
  nextChannel(d: number) { this.channel = (this.channel + d + VOICES) % VOICES; this.column = 0; this.emit(); }
  setOrderPos(n: number) {
    this.orderPos = Math.max(0, Math.min(this.song.order.length - 1, n));
    this.row = 0; this.sel = null; this.anchor = null;
    this.emit();
  }
  setOctave(n: number) { this.octave = Math.max(1, Math.min(8, n)); this.emit(); }
  setStep(n: number) { this.song = { ...this.song, step: Math.max(0, Math.min(16, n)) }; this.step = this.song.step; this.emit(); }
  cycleStep(d: number) { this.setStep(((this.step + d) % 17 + 17) % 17); }
  toggleEdit() { this.editing = !this.editing; this.emit(); }
  selectInstrument(n: number) { this.instrument = Math.max(1, Math.min(this.song.instruments.length - 1, n)); this.emit(); }

  // ---------- selection
  clearSelection() { if (this.sel || this.anchor) { this.sel = null; this.anchor = null; this.emit(); } }
  extendSelection(dr: number, dc: number) {
    const a = this.anchor ?? { row: this.row, channel: this.channel };
    const row = Math.max(0, Math.min(this.rows - 1, this.row + dr));
    const ch = Math.max(0, Math.min(VOICES - 1, this.channel + dc));
    this.anchor = a;
    this.sel = { r1: Math.min(a.row, row), r2: Math.max(a.row, row), c1: Math.min(a.channel, ch), c2: Math.max(a.channel, ch) };
    this.row = row; this.channel = ch;
    this.emit();
  }
  selectRange(a: { row: number; channel: number }, b: { row: number; channel: number }) {
    this.anchor = a;
    this.sel = { r1: Math.min(a.row, b.row), r2: Math.max(a.row, b.row), c1: Math.min(a.channel, b.channel), c2: Math.max(a.channel, b.channel) };
    this.row = b.row; this.channel = b.channel;
    this.emit();
  }

  // ---------- cell editing
  setCell(patch: Partial<Cell>, row = this.row, channel = this.channel) {
    this.mutate(this.patIdx, (w) => { w(row)[channel] = { ...w(row)[channel], ...patch }; });
  }
  private advance() { this.row = (this.row + this.step) % this.rows; }
  insertNote(note: number) {
    this.setCell({ note, instrument: note === NOTE_OFF ? 0 : this.instrument });
    this.advance();
    this.emit();
  }
  /** typing a hex digit into inst / vol / param columns */
  typeHex(h: number) {
    const cell = this.pattern.cells[this.row][this.channel];
    const patch: Partial<Cell> = {};
    const volNow = cell.volume >= 0x10 ? Math.min(0x40, cell.volume - 0x10) : 0;
    switch (this.column) {
      case 1: patch.instrument = ((cell.instrument & 0x0f) | (h << 4)) & 0xff; break;
      case 2: patch.instrument = ((cell.instrument & 0xf0) | h) & 0xff; break;
      case 3: patch.volume = Math.min(0x40, ((h << 4) | (volNow & 0x0f)) & 0xff) + 0x10; break;
      case 4: patch.volume = Math.min(0x40, ((volNow & 0xf0) | h) & 0xff) + 0x10; break;
      case 6: patch.param = ((cell.param & 0x0f) | (h << 4)) & 0xff; break;
      case 7: patch.param = ((cell.param & 0xf0) | h) & 0xff; break;
      default: return;
    }
    if ((this.column === 6 || this.column === 7) && cell.effect === 0) patch.effect = 1;   // bare digits = arpeggio, as in FT2
    if ((this.column === 1 || this.column === 2) && patch.instrument! >= this.song.instruments.length) patch.instrument = this.song.instruments.length - 1;
    this.setCell(patch);
    if (this.column === 2 || this.column === 4 || this.column === 7) { this.advance(); this.emit(); }
    else if (this.column === 1 || this.column === 3 || this.column === 6) this.moveColumn(1);
  }
  typeEffect(code: number) {
    this.setCell({ effect: code });
    this.advance();
    this.emit();
  }
  deleteNoteVol() { this.setCell({ note: 0, instrument: 0, volume: 0 }); }
  deleteAll() { this.setCell(emptyCell()); }
  deleteVolEff() { this.setCell({ volume: 0, effect: 0, param: 0 }); }
  deleteEff() { this.setCell({ effect: 0, param: 0 }); }
  deleteVolume() { this.setCell({ volume: 0 }); }
  /** Del: depends on the column the cursor is in */
  deleteHere() {
    if (this.column >= 3 && this.column <= 4) this.deleteVolume();
    else if (this.column >= 5) this.deleteEff();
    else this.deleteNoteVol();
  }
  insertCell() {
    const { row: at, channel: ch } = this;
    this.mutate(this.patIdx, (w) => {
      for (let r = this.rows - 1; r > at; r--) w(r)[ch] = cloneCell(this.pattern.cells[r - 1][ch]);
      w(at)[ch] = emptyCell();
    });
  }
  insertRow() {
    const at = this.row;
    this.mutate(this.patIdx, (w) => {
      for (let r = this.rows - 1; r > at; r--) { const src = this.pattern.cells[r - 1]; const dst = w(r); for (let c = 0; c < dst.length; c++) dst[c] = cloneCell(src[c]); }
      const d = w(at); for (let c = 0; c < d.length; c++) d[c] = emptyCell();
    });
  }
  backspaceCell() {
    if (this.row === 0) return;
    const at = this.row, ch = this.channel;
    this.mutate(this.patIdx, (w) => {
      for (let r = at - 1; r < this.rows - 1; r++) w(r)[ch] = cloneCell(this.pattern.cells[r + 1][ch]);
      w(this.rows - 1)[ch] = emptyCell();
    });
    this.row = at - 1; this.emit();
  }
  backspaceRow() {
    if (this.row === 0) return;
    const at = this.row;
    this.mutate(this.patIdx, (w) => {
      for (let r = at - 1; r < this.rows - 1; r++) { const src = this.pattern.cells[r + 1]; const dst = w(r); for (let c = 0; c < dst.length; c++) dst[c] = cloneCell(src[c]); }
      const d = w(this.rows - 1); for (let c = 0; c < d.length; c++) d[c] = emptyCell();
    });
    this.row = at - 1; this.emit();
  }

  // ---------- clipboard (FT2: Shift = track, Ctrl+Shift = pattern, Alt = block)
  copyTrack() { this.clip = { kind: 'track', cells: this.pattern.cells.map((r) => [cloneCell(r[this.channel])]) }; }
  cutTrack() { this.copyTrack(); const ch = this.channel; this.mutate(this.patIdx, (w) => { for (let r = 0; r < this.rows; r++) w(r)[ch] = emptyCell(); }); }
  pasteTrack() {
    if (!this.clip) return;
    const clip = this.clip, ch = this.channel;
    this.mutate(this.patIdx, (w) => {
      const srcCol = clip.kind === 'track' ? 0 : Math.min(ch, (clip.cells[0]?.length ?? 1) - 1);
      for (let r = 0; r < Math.min(clip.cells.length, this.rows); r++) w(r)[ch] = cloneCell(clip.cells[r][srcCol]);
    });
  }
  copyPattern() { this.clip = { kind: 'pattern', cells: this.pattern.cells.map((r) => r.map(cloneCell)) }; }
  cutPattern() { this.copyPattern(); this.mutate(this.patIdx, (w) => { for (let r = 0; r < this.rows; r++) { const d = w(r); for (let c = 0; c < d.length; c++) d[c] = emptyCell(); } }); }
  pastePattern() {
    if (!this.clip) return;
    const clip = this.clip;
    this.mutate(this.patIdx, (w) => {
      for (let r = 0; r < Math.min(clip.cells.length, this.rows); r++) {
        const d = w(r);
        for (let c = 0; c < Math.min(clip.cells[r].length, d.length); c++) d[c] = cloneCell(clip.cells[r][c]);
      }
    });
  }
  copyBlock() {
    const s = this.sel; if (!s) return;
    const cells: Cell[][] = [];
    for (let r = s.r1; r <= s.r2; r++) { const row: Cell[] = []; for (let c = s.c1; c <= s.c2; c++) row.push(cloneCell(this.pattern.cells[r][c])); cells.push(row); }
    this.clip = { kind: 'block', cells };
  }
  cutBlock() {
    const s = this.sel; if (!s) return;
    this.copyBlock();
    this.mutate(this.patIdx, (w) => { for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) w(r)[c] = emptyCell(); });
  }
  pasteBlock() {
    if (!this.clip) return;
    const clip = this.clip, r0 = this.row, c0 = this.channel;
    this.mutate(this.patIdx, (w) => {
      for (let r = 0; r < clip.cells.length; r++) {
        if (r0 + r >= this.rows) break;
        for (let c = 0; c < clip.cells[r].length; c++) { if (c0 + c >= VOICES) break; w(r0 + r)[c0 + c] = cloneCell(clip.cells[r][c]); }
      }
    });
  }
  get hasClip() { return !!this.clip; }

  // ---------- whole-range operations
  private forScope(scope: Scope, fn: (cell: Cell, i: number, n: number) => Cell | null) {
    const s = this.song;
    if (scope === 'song') {
      const lens = s.order.map((p) => s.patterns[p]?.rows ?? 0);
      const total = lens.reduce((a, b) => a + b, 0);
      const patterns = s.patterns.slice();
      let acc = 0;
      s.order.forEach((pi, oi) => {
        const p = patterns[pi]; if (!p) { acc += lens[oi]; return; }
        const cells = p.cells.map((row, r) => row.map((c) => fn(c, acc + r, total) ?? c));
        patterns[pi] = { ...p, cells }; acc += lens[oi];
      });
      this.commit({ ...s, patterns });
      return;
    }
    let r1 = 0, r2 = this.rows - 1, c1 = 0, c2 = VOICES - 1;
    if (scope === 'track') { c1 = c2 = this.channel; }
    else if (scope === 'block') { if (this.sel) ({ r1, r2, c1, c2 } = this.sel); else c1 = c2 = this.channel; }
    this.mutate(this.patIdx, (w) => {
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { const row = w(r); row[c] = fn(row[c], r - r1, r2 - r1 + 1) ?? row[c]; }
    });
  }
  /** shift every note; returns how many changed */
  transpose(scope: Scope, semitones: number, instrumentFilter: number | null): number {
    let changed = 0;
    this.forScope(scope, (c) => {
      if (!c.note || c.note >= NOTE_OFF) return null;
      if (instrumentFilter !== null && c.instrument !== instrumentFilter) return null;
      const n = c.note + semitones;
      if (n < 1 || n > 96) return null;
      changed++;
      return { ...c, note: n };
    });
    return changed;
  }
  /** FT2 volume scaling, linear ramp from startPct to endPct over the scope */
  scaleVolume(scope: Scope, startPct: number, endPct: number) {
    this.forScope(scope, (c, i, n) => {
      if (c.volume < 0x10 || c.volume > 0x50) return null;
      const f = (startPct + (endPct - startPct) * (n <= 1 ? 0 : i / (n - 1))) / 100;
      return { ...c, volume: 0x10 + Math.max(0, Math.min(64, Math.round((c.volume - 0x10) * f))) };
    });
  }

  // ---------- order list / patterns
  setOrderEntry(idx: number, pat: number) {
    const s = this.song;
    pat = Math.max(0, Math.min(255, pat));
    let patterns = s.patterns;
    while (pat >= patterns.length) patterns = [...patterns, emptyPattern(patterns[0]?.rows ?? 64, VOICES)];
    const order = s.order.slice(); order[idx] = pat;
    this.commit({ ...s, order, patterns });
  }
  addOrderEntry() {
    const s = this.song;
    const order = s.order.slice();
    order.splice(this.orderPos + 1, 0, this.patIdx);
    this.commit({ ...s, order });
    this.orderPos++; this.row = 0; this.emit();
  }
  /** insert a new empty pattern after the current order position */
  addPattern() {
    const s = this.song;
    const patterns = [...s.patterns, emptyPattern(this.rows, VOICES)];
    const order = s.order.slice(); order.splice(this.orderPos + 1, 0, patterns.length - 1);
    this.commit({ ...s, order, patterns });
    this.orderPos++; this.row = 0; this.emit();
  }
  /** duplicate the current pattern into a new one after the current position */
  clonePattern() {
    const s = this.song;
    const p = this.pattern;
    const patterns = [...s.patterns, { rows: p.rows, cells: p.cells.map((r) => r.map(cloneCell)) }];
    const order = s.order.slice(); order.splice(this.orderPos + 1, 0, patterns.length - 1);
    this.commit({ ...s, order, patterns });
    this.orderPos++; this.emit();
  }
  removeOrderEntry() {
    const s = this.song;
    if (s.order.length <= 1) return;
    const order = s.order.slice(); order.splice(this.orderPos, 1);
    this.commit({ ...s, order, restartPos: Math.min(s.restartPos, order.length - 1) });
  }
  moveOrderEntry(from: number, to: number) {
    const s = this.song;
    if (to < 0 || to >= s.order.length || from === to) return;
    const order = s.order.slice(); const [x] = order.splice(from, 1); order.splice(to, 0, x);
    this.commit({ ...s, order });
    this.orderPos = to; this.emit();
  }
  setRestartPos(n: number) { this.commit({ ...this.song, restartPos: Math.max(0, Math.min(this.song.order.length - 1, n)) }); }
  setPatternLength(n: number) {
    n = Math.max(1, Math.min(256, Math.trunc(n)));
    const p = this.pattern;
    if (n === p.rows) return;
    const cells = p.cells.slice(0, n);
    while (cells.length < n) cells.push(Array.from({ length: VOICES }, emptyCell));
    const patterns = this.song.patterns.slice(); patterns[this.patIdx] = { rows: n, cells };
    this.commit({ ...this.song, patterns });
  }
  setBpm(n: number) { this.commit({ ...this.song, bpm: Math.max(32, Math.min(255, Math.trunc(n) || 125)) }); }
  setSpeed(n: number) { this.commit({ ...this.song, speed: Math.max(1, Math.min(31, Math.trunc(n) || 6)) }); }
  setName(n: string) { this.commit({ ...this.song, name: n }, { audio: false }); }
  setAuthor(n: string) { this.commit({ ...this.song, author: n }, { audio: false }); }

  // ---------- instruments
  updateInstrument(patch: Partial<Instrument>, idx = this.instrument) {
    const instruments = this.song.instruments.slice();
    instruments[idx] = { ...instruments[idx], ...patch };
    this.commit({ ...this.song, instruments });
  }
  replaceInstrument(inst: Instrument, idx = this.instrument) {
    const instruments = this.song.instruments.slice(); instruments[idx] = inst;
    this.commit({ ...this.song, instruments });
  }
  addInstrument(base?: Instrument) {
    if (this.song.instruments.length > 255) return;
    const inst = base ? { ...base, name: base.name + ' copy' } : defaultInstrument(`Instrument ${this.song.instruments.length}`);
    this.commit({ ...this.song, instruments: [...this.song.instruments, inst] });
    this.instrument = this.song.instruments.length - 1; this.emit();
  }
  /** how many cells use each instrument (for the instrument list) */
  usage(): number[] {
    const u = new Array(this.song.instruments.length).fill(0);
    for (const o of new Set(this.song.order)) for (const row of this.song.patterns[o]?.cells ?? []) for (const c of row) if (c.instrument < u.length) u[c.instrument]++;
    return u;
  }

  // ---------- mute / solo
  toggleMute(c: number) { this.muted = this.muted.map((v, i) => (i === c ? !v : v)); this.scheduleRefresh(); this.emit(); }
  toggleSolo(c: number) { this.soloed = this.soloed.map((v, i) => (i === c ? !v : v)); this.scheduleRefresh(); this.emit(); }
  private muteMask(): boolean[] {
    const anySolo = this.soloed.some(Boolean);
    return [0, 1, 2].map((c) => (anySolo ? !this.soloed[c] : this.muted[c]));
  }

  // ---------- rendering & playback
  private renderKey() { return `${this.playMode}:${this.muteMask().join()}`; }
  private scheduleRefresh() {
    this.lastRender = null;
    if (!this.audio) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; if (this.playing) this.refreshAudio(true); }, 250);
  }
  /** song (or the current pattern, looped) -> registers -> PCM for the audio sink */
  private refreshAudio(keepPosition: boolean): RenderResult | null {
    if (!this.audio) return null;
    const song = this.playMode === 'pattern' ? this.songForPattern() : this.song;
    const res = renderSong(song, { mute: this.muteMask() });
    this.lastRender = { regs: res.regs, nframes: res.nframes, loopFrame: res.loopFrame, rows: res.rows, key: this.renderKey(), drums: res.drums };
    this.warnings = res.warnings;
    const pcm = renderYm(res.regs, res.nframes, 44100, 50, 4, res.drums);
    const pos = keepPosition ? this.audio.position() : 0;
    this.audio.setSource?.('ay');
    this.audio.setAy(pcm);
    void pos;
    return res;
  }
  private songForPattern(): Song { return { ...this.song, order: [this.patIdx], restartPos: 0 }; }
  /** register dump of the whole song for export (regs, nframes, loopFrame) */
  renderForExport() {
    const r = renderSong(this.song);
    return { regs: r.regs, nframes: r.nframes, loopFrame: Math.max(0, r.loopFrame), warnings: r.warnings, drums: r.drums };
  }
  /** a rendered preview of the full song, memoised until the song changes */
  currentRender() {
    const key = this.renderKey();
    if (!this.lastRender || this.lastRender.key !== key) {
      const res = renderSong(this.playMode === 'pattern' ? this.songForPattern() : this.song, { mute: this.muteMask() });
      this.lastRender = { regs: res.regs, nframes: res.nframes, loopFrame: res.loopFrame, rows: res.rows, key, drums: res.drums };
      this.warnings = res.warnings;
    }
    return this.lastRender;
  }

  async play(mode: 'song' | 'pattern', fromCursor = false) {
    if (!this.audio) return;
    this.stopAudition();
    this.playMode = mode;
    const res = this.refreshAudio(false);
    if (!res) return;
    let startFrame = 0;
    if (mode === 'song') {
      const mark = res.rows.find((m) => m.order === this.orderPos && m.row === (fromCursor ? this.row : 0));
      startFrame = mark?.frame ?? 0;
    } else {
      const mark = res.rows.find((m) => m.row === (fromCursor ? this.row : 0));
      startFrame = mark?.frame ?? 0;
    }
    this.playing = true;
    await this.audio.play(startFrame / 50);
    this.startTicker();
    this.emit();
  }
  stop() {
    if (!this.playing && !this.audio?.playing) { this.stopAudition(); return; }
    this.audio?.stop();
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.stopAudition();
    this.emit();
  }
  private startTicker() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.playing || !this.audio) return;
      const lr = this.lastRender;
      if (lr) {
        const frame = Math.floor(this.audio.position() * 50);
        let lo = 0, hi = lr.rows.length - 1, best = 0;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (lr.rows[mid].frame <= frame) { best = mid; lo = mid + 1; } else hi = mid - 1; }
        const m = lr.rows[best];
        if (m) {
          const order = this.playMode === 'pattern' ? this.orderPos : m.order;
          if (m.row !== this.playRow || order !== this.playOrder) {
            this.playRow = m.row; this.playOrder = order;
            if (this.followPlay) { this.orderPos = order; this.row = m.row; }
            this.emit();
          }
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  get playPositionSeconds() { return this.audio?.position() ?? 0; }

  // ---------- audition (jam)
  private audNote = 0;
  jam(note: number) {
    if (!this.audio?.audition || this.playing) return;
    const song = this.auditionSong(note);
    const res = renderSong(song, { maxFrames: 150, noLoopStop: true });
    const pcm = renderYm(res.regs, res.nframes, 44100, 50, 4, res.drums);
    this.audNote = note;
    this.audio.audition(pcm);
  }
  releaseJam(note: number) { if (this.audNote === note) { this.audNote = 0; this.stopAudition(); } }
  stopAudition() { this.audio?.stopAudition?.(); }
  private auditionSong(note: number): Song {
    const s = newSong(3);
    s.instruments = this.song.instruments;
    s.speed = 6; s.bpm = 125;
    s.patterns = [emptyPattern(32, 3)];
    s.patterns[0].cells[0][0] = { note, instrument: this.instrument, volume: 0, effect: 0, param: 0 };
    return s;
  }
  /** Hz of the note the cursor row would play, for hints */
  freqOf(note: number) { return noteToFreq(note); }
}
