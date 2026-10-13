import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Editor, Scope } from '../tracker/editor';
import { type Cell, NOTE_OFF, noteName, effectChar, toHex2, parseEffectChar } from '../tracker/types';
import { keyToNote, keyToHex, keyToDrum } from '../tracker/keymap';
import { cellHint } from '../tracker/hints';
import { encodeYmt, decodeYmt, isYmt } from '../tracker/ymt';
import { writeSndh } from '../export/sndh';
import { writeYm5, writeYm6 } from '../export/ym';
import { gameKitFiles } from '../export/gamekit';
import { hasDrums } from '../core/drums';
import { hasFx } from '../core/fx';
import { renderYm } from '../export/ymemu';
import { encodeWav } from '../export/wav';
import { zip } from '../export/zip';
import { songToMaxymiser, instrumentToMyi } from '../maxymiser/convert';
import { download } from './download';
import { NumField, TextField } from './fields';
import { InstrumentEditor } from './InstrumentEditor';
import { DrumEditor } from './DrumEditor';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'song';

// character index inside "C-4 01 40 A0F" -> cursor column (0 note, 1-2 instrument, 3-4 volume, 5 effect, 6-7 parameter)
const CHAR_COL = [0, 0, 0, 0, 1, 2, 2, 3, 4, 4, 5, 6, 7];
const CH_NAME = ['A', 'B', 'C'];

function CellText({ cell, curCol }: { cell: Cell; curCol: number }) {
  const note = noteName(cell.note);
  const inst = cell.instrument ? toHex2(cell.instrument) : '..';
  const vol = cell.volume >= 0x10 ? toHex2(Math.min(0x40, cell.volume - 0x10)) : '..';
  const fx = cell.effect ? effectChar(cell.effect) : '.';
  const par = cell.effect || cell.param ? toHex2(cell.param) : '..';
  const nCls = cell.note === NOTE_OFF ? 'n off' : 'n';
  if (curCol < 0) {
    return (<>
      <span className={nCls}>{note}</span>{' '}<span className="i">{inst}</span>{' '}<span className="v">{vol}</span>{' '}<span className="e">{fx}{par}</span>
    </>);
  }
  // cursor cell: every character on its own so the active one can be lit
  const chars: [string, string, number][] = [
    [note[0], nCls, 0], [note[1], nCls, 0], [note[2], nCls, 0], [' ', '', -1],
    [inst[0], 'i', 1], [inst[1], 'i', 2], [' ', '', -1],
    [vol[0], 'v', 3], [vol[1], 'v', 4], [' ', '', -1],
    [fx, 'e', 5], [par[0], 'e', 6], [par[1], 'e', 7],
  ];
  return <>{chars.map(([t, c, k], i) => <span key={i} className={`${c}${k === curCol ? ' at' : ''}`}>{t}</span>)}</>;
}

interface RowProps { r: number; cells: Cell[]; cur: number; col: number; editing: boolean; s1: number; s2: number; play: boolean; hl: boolean }
const Row = memo(function Row({ r, cells, cur, col, editing, s1, s2, play, hl }: RowProps) {
  return (
    <div className={`pr${hl ? ' hl' : ''}${cur >= 0 ? ' cur' : ''}${cur >= 0 && editing ? ' rec' : ''}${play ? ' play' : ''}`}>
      <div className="rn" data-r={r} data-c={-1}>{toHex2(r)}</div>
      {cells.map((cell, c) => (
        <div key={c} className={`pc${c >= s1 && c <= s2 ? ' sel' : ''}`} data-r={r} data-c={c}>
          <CellText cell={cell} curCol={cur === c ? col : -1} />
        </div>
      ))}
    </div>
  );
});

type Dialog = null | { kind: 'scale'; scope: Scope } | { kind: 'transpose' };

export function Tracker({ ed, active, onError }: { ed: Editor; active: boolean; onError: (m: string) => void }) {
  const ver = useSyncExternalStore(ed.subscribe, ed.getVersion);
  const [secs, setSecs] = useState(0);
  const [warns, setWarns] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  /** the arpeggio / slide hint stays on the cell just typed into even though the cursor has moved on */
  const [hintAt, setHintAt] = useState<{ p: number; r: number; c: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [instOpen, setInstOpen] = useState(false);
  const [drumOpen, setDrumOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ row: number; channel: number } | null>(null);
  const held = useRef(new Map<string, number>());
  const dialogRef = useRef<Dialog>(null);
  dialogRef.current = dialog;

  const song = ed.song;
  const pat = ed.pattern;
  const RH = 18;

  // keep the cursor row centred (FT2 style)
  const focusRow = ed.playing && ed.followPlay ? ed.playRow : ed.row;
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = focusRow * RH; }, [focusRow, ed.orderPos, active, pat]);

  // song length and renderer warnings, refreshed shortly after the last edit
  useEffect(() => {
    if (!active) return;
    const h = setTimeout(() => {
      try { const r = ed.currentRender(); setSecs(r.nframes / 50); setWarns(ed.warnings.slice()); } catch { /* shown on export */ }
    }, 400);
    return () => clearTimeout(h);
  }, [ver, active, ed]);

  // ---------- keyboard (FT2 / YM Tracker layout)
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      if (dialogRef.current) { if (e.code === 'Escape') setDialog(null); return; }
      const mod = e.ctrlKey || e.metaKey;
      setHintAt(null); setMsg('');

      // undo / redo / save
      if (mod && !e.altKey && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) ed.redo(); else ed.undo(); return; }
      if (mod && !e.altKey && e.code === 'KeyY') { e.preventDefault(); ed.redo(); return; }
      if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyS') { e.preventDefault(); void saveYmt(); return; }

      // transport: Right Ctrl = song, Right Alt = pattern, Right Shift = record pattern, Space = stop / toggle edit
      if (e.code === 'ControlRight') { e.preventDefault(); void ed.play('song', false); return; }
      if (e.code === 'AltRight') { e.preventDefault(); void ed.play('pattern', false); return; }
      if (e.code === 'ShiftRight') { e.preventDefault(); if (!ed.editing) ed.toggleEdit(); void ed.play('pattern', true); return; }
      if (e.code === 'Space') { e.preventDefault(); if (ed.playing) ed.stop(); else ed.toggleEdit(); return; }
      if (e.code === 'Escape') { ed.stop(); ed.clearSelection(); return; }

      // octave
      const plain = !e.shiftKey && !e.ctrlKey && !e.altKey;
      const OCT: Record<string, number> = { F1: 1, F2: 1, F3: 2, F4: 3, F5: 4, F6: 5, F7: 6, F8: 7 };
      if (e.code in OCT && (plain || e.code === 'F1' || e.code === 'F2' || e.code === 'F6' || e.code === 'F7' || e.code === 'F8') && !mod) { e.preventDefault(); ed.setOctave(OCT[e.code]); return; }

      // cut / copy / paste: Shift = track, Ctrl+Shift = pattern, Alt = block
      const fn = e.code === 'F3' ? 'cut' : e.code === 'F4' ? 'copy' : e.code === 'F5' ? 'paste' : '';
      if (fn) {
        e.preventDefault();
        const kind = e.ctrlKey && e.shiftKey ? 'Pattern' : e.shiftKey ? 'Track' : e.altKey ? 'Block' : '';
        if (kind) (ed as unknown as Record<string, () => void>)[fn + kind]();
        return;
      }

      // scale volume: Ctrl+V block, Alt+V track, Shift+V pattern, Ctrl+Shift+V song
      if (e.code === 'KeyV' && (e.ctrlKey || e.altKey || e.shiftKey)) {
        e.preventDefault();
        setDialog({ kind: 'scale', scope: e.ctrlKey && e.shiftKey ? 'song' : e.ctrlKey ? 'block' : e.altKey ? 'track' : 'pattern' });
        return;
      }

      if (e.code === 'CapsLock') { e.preventDefault(); if (ed.editing) ed.insertNote(NOTE_OFF); return; }
      if (e.code === 'IntlBackslash' || e.code === 'Backquote') { e.preventDefault(); ed.cycleStep(e.shiftKey ? -1 : 1); return; }

      // song position / pattern number
      if (e.shiftKey && e.code === 'ArrowLeft') { e.preventDefault(); ed.setOrderPos(ed.orderPos - 1); return; }
      if (e.shiftKey && e.code === 'ArrowRight') { e.preventDefault(); ed.setOrderPos(ed.orderPos + 1); return; }
      if (e.ctrlKey && e.code === 'ArrowLeft') { e.preventDefault(); ed.setOrderEntry(ed.orderPos, ed.patIdx - 1); return; }
      if (e.ctrlKey && e.code === 'ArrowRight') { e.preventDefault(); ed.setOrderEntry(ed.orderPos, ed.patIdx + 1); return; }

      // cursor / selection
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        e.preventDefault();
        const d = e.code === 'ArrowUp' ? -1 : 1;
        if (e.altKey || e.shiftKey) ed.extendSelection(d, 0); else { ed.clearSelection(); ed.moveCursor(d); }
        return;
      }
      if (e.altKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) { e.preventDefault(); ed.extendSelection(0, e.code === 'ArrowRight' ? 1 : -1); return; }
      if (e.code === 'ArrowLeft') { e.preventDefault(); ed.clearSelection(); ed.moveColumn(-1); return; }
      if (e.code === 'ArrowRight') { e.preventDefault(); ed.clearSelection(); ed.moveColumn(1); return; }
      if (e.code === 'Tab') { e.preventDefault(); ed.clearSelection(); ed.nextChannel(e.shiftKey ? -1 : 1); return; }
      if (e.code === 'PageDown') { e.preventDefault(); ed.clearSelection(); ed.setCursor(Math.min(ed.rows - 1, ed.row + 16)); return; }
      if (e.code === 'PageUp') { e.preventDefault(); ed.clearSelection(); ed.setCursor(Math.max(0, ed.row - 16)); return; }
      if (e.code === 'Home') { e.preventDefault(); ed.clearSelection(); ed.setCursor(0); return; }
      if (e.code === 'End') { e.preventDefault(); ed.clearSelection(); ed.setCursor(ed.rows - 1); return; }

      // delete variants
      if (e.code === 'Delete') {
        e.preventDefault();
        if (e.shiftKey) ed.deleteAll(); else if (e.ctrlKey) ed.deleteVolEff(); else if (e.altKey) ed.deleteEff(); else ed.deleteHere();
        return;
      }
      if (e.code === 'Insert') { e.preventDefault(); if (e.shiftKey) ed.insertRow(); else ed.insertCell(); return; }
      if (e.code === 'Backspace') { e.preventDefault(); if (e.shiftKey) ed.backspaceRow(); else ed.backspaceCell(); return; }

      if (mod || e.altKey) return;

      // note keys always audition; they are written when editing on the note column
      if (!(ed.editing && ed.column !== 0)) {
        if (e.code === 'Digit1' && ed.editing && ed.column === 0) { e.preventDefault(); ed.insertNote(NOTE_OFF); return; }   // FT2: 1 = key off
        const n = ed.isDrumColumn(ed.channel) ? keyToDrum(e.code) : keyToNote(e.code, ed.octave);
        if (n !== null) {
          e.preventDefault();
          if (e.repeat) return;
          if (ed.editing && ed.column === 0) ed.insertNote(n);
          ed.jam(n);
          held.current.set(e.code, n);
          return;
        }
      }
      if (ed.editing && ed.column !== 0) {
        if (ed.column === 5) {
          if (e.key.length === 1) {
            const code = parseEffectChar(e.key);
            if (code) { e.preventDefault(); const at = { p: ed.patIdx, r: ed.row, c: ed.channel }; ed.typeEffect(code); setHintAt(at); }
          }
          return;
        }
        const h = keyToHex(e.code);
        if (h !== null) { e.preventDefault(); const at = { p: ed.patIdx, r: ed.row, c: ed.channel }, col0 = ed.column; ed.typeHex(h); if (col0 >= 6) setHintAt(at); }
      }
    };
    const onUp = (e: KeyboardEvent) => {
      const n = held.current.get(e.code);
      if (n !== undefined) { held.current.delete(e.code); ed.releaseJam(n); }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ed]);

  // ---------- mouse
  const hit = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest('[data-r]') as HTMLElement | null;
    if (!el) return null;
    const r = +el.dataset.r!, c = +el.dataset.c!;
    let col = 0;
    if (c >= 0) {
      const rect = el.getBoundingClientRect();
      const cw = rect.width / 15;
      const i = Math.max(0, Math.min(12, Math.floor((e.clientX - rect.left) / cw) - 1));
      col = CHAR_COL[i];
    }
    return { r, c, col };
  };
  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const h = hit(e); if (!h) return;
    const ch = h.c < 0 ? ed.channel : h.c;
    if (e.shiftKey) ed.selectRange(ed.anchor ?? { row: ed.row, channel: ed.channel }, { row: h.r, channel: ch });
    else { ed.clearSelection(); ed.setCursor(h.r, ch, h.c < 0 ? 0 : (h.col as 0)); }
    drag.current = { row: h.r, channel: ch };
  };
  const onMove = (e: React.MouseEvent) => {
    if (!drag.current || e.buttons !== 1) return;
    const h = hit(e); if (!h) return;
    const ch = h.c < 0 ? 0 : h.c;
    if (h.r !== drag.current.row || ch !== drag.current.channel || ed.sel) ed.selectRange(drag.current, { row: h.r, channel: ch });
  };
  const onWheel = (e: React.WheelEvent) => { ed.setCursor(ed.row + Math.sign(e.deltaY) * 3); };
  useEffect(() => { const up = () => { drag.current = null; }; window.addEventListener('mouseup', up); return () => window.removeEventListener('mouseup', up); }, []);

  // ---------- file operations
  async function saveYmt() {
    try { download(`${slug(song.name)}.ymt`, await encodeYmt(song, { gzip: true })); ed.dirty = false; } catch (e) { onError(String((e as Error).message ?? e)); }
  }
  const loadYmt = async (f: File) => {
    try {
      const b = new Uint8Array(await f.arrayBuffer());
      if (!isYmt(b)) throw new Error(`${f.name} is not a .ymt song file`);
      ed.loadSong(await decodeYmt(b), f.name);
    } catch (e) { onError(String((e as Error).message ?? e)); }
  };
  const meta = { title: song.name.slice(0, 32), author: song.author || 'unknown' };
  const base = slug(song.name);
  const withRender = (fn: (r: ReturnType<Editor['renderForExport']>) => void) => () => {
    try { fn(ed.renderForExport()); } catch (e) { onError(String((e as Error).message ?? e)); }
  };
  const exp = {
    sndh: withRender((r) => download(`${base}.sndh`, writeSndh(r.regs, r.nframes, r.loopFrame, meta, r.drums, r.fx))),
    ym: withRender((r) => {
      if (hasDrums(r.drums) || hasFx(r.fx)) {
        const y = writeYm6(r.regs, r.nframes, r.loopFrame, r.drums, meta.title, meta.author, 'made in the AY pattern editor', 50, r.fx);
        if (y.warnings.length) onError(y.warnings.join('; '));
        download(`${base}.ym`, y.data);
      } else download(`${base}.ym`, writeYm5(r.regs, r.nframes, r.loopFrame, meta.title, meta.author, 'made in the AY pattern editor'));
    }),
    game: withRender((r) => download(`${base}_gamekit.zip`, zip(gameKitFiles(base, r.regs, r.nframes, r.loopFrame, r.drums, r.fx)), 'application/zip')),
    wav: withRender((r) => download(`${base}_ym.wav`, encodeWav(renderYm(r.regs, r.nframes, 44100, 50, 4, r.drums, r.fx), 44100), 'audio/wav')),
    regs: withRender((r) => download(`${base}.regs`, r.regs.subarray(0, r.nframes * 14))),
    mym: () => {
      try {
        const m = songToMaxymiser(song);
        const short = (base.replace(/_/g, '').slice(0, 8) || 'SONG').toUpperCase();
        const readme = [
          `${song.name} - exported from the AY pattern editor for maxYMiser (by gwEm).`,
          '',
          `${short}.MYS is the song, ${short}.MYV the voice bank with its instruments and sequences.`,
          'Load both in maxYMiser (voice set and song), or name them DEFAULT.MYS / DEFAULT.MYV to have it load them at start-up.',
          `${m.stats.orders} song positions, ${m.stats.patterns} patterns, ${m.stats.instruments} instruments, ${m.stats.sequences} sequences.`,
          '',
          m.warnings.length ? 'Not carried over exactly:\n' + m.warnings.map((w) => `- ${w}`).join('\n') : 'Everything was carried over.',
          '',
          'maxYMiser is (c) Gareth Morris "gwEm"; its licence asks that anything released that was made with it says so.',
        ].join('\n');
        download(`${base}_maxymiser.zip`, zip([{ name: `${short}.MYS`, data: m.mys }, { name: `${short}.MYV`, data: m.myv }, { name: 'README.txt', data: readme }]), 'application/zip');
        if (m.warnings.length) onError(m.warnings.join('; '));
      } catch (e) { onError(String((e as Error).message ?? e)); }
    },
    myi: () => {
      try {
        const inst = song.instruments[ed.instrument];
        if (!inst) throw new Error('no instrument selected');
        const r = instrumentToMyi(inst, song.speed);
        download(`${slug(inst.name || `instrument_${toHex2(ed.instrument)}`)}.myi`, r.data);
        if (r.warnings.length) onError(r.warnings.join('; '));
      } catch (e) { onError(String((e as Error).message ?? e)); }
    },
  };

  const hintPat = hintAt && song.patterns[hintAt.p];
  const hint = hintPat && hintAt ? cellHint(hintPat, hintAt.r, hintAt.c, song.speed) : cellHint(pat, ed.row, ed.channel, song.speed);
  let drumHint = '';
  if (ed.isDrumColumn(ed.channel)) {
    const cell = pat.cells[ed.row]?.[ed.channel];
    const bank = song.instruments[(cell?.instrument || ed.instrument)]?.digiDrums ?? [];
    if (cell && cell.note > 0 && cell.note < NOTE_OFF) drumHint = bank.length ? `Drum ${(cell.note - 1) % bank.length + 1} of ${bank.length}: ${bank[(cell.note - 1) % bank.length].name}` : 'This instrument has no digidrums – open "Drums…" in the instrument panel.';
    else drumHint = 'Drum channel: keys Z S X D C V … pick drum 1, 2, 3 … of the instrument; the instrument column switches the drum bank; === stops the drum.';
  }
  const sel = ed.sel;
  const usage = ed.usage();
  const anySolo = ed.soloed.some(Boolean);

  return (
    <div className="tracker">
      <section className="panel tk-bar">
        <h2>Song <small>pattern editor for one YM2149 · FastTracker 2 keys</small></h2>
        <div className="tk-line">
          <button className="btn" onClick={() => { if (!ed.dirty || confirm('Discard the current song?')) ed.newSong(); }}>New</button>
          <label className="btn">Load .ymt…<input type="file" accept=".ymt,.YMT" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadYmt(f); e.target.value = ''; }} /></label>
          <button className="btn" onClick={() => void saveYmt()} title="Ctrl+S">Save .ymt</button>
          <span className="sep" />
          <button className="btn" disabled={!ed.canUndo} onClick={() => ed.undo()} title="Ctrl+Z">Undo</button>
          <button className="btn" disabled={!ed.canRedo} onClick={() => ed.redo()} title="Ctrl+Y">Redo</button>
          <span className="sep" />
          <label>Title <TextField className="txt" value={song.name} maxLength={32} onCommit={(v) => ed.setName(v)} /></label>
          <label>Author <TextField className="txt" value={song.author ?? ''} maxLength={32} onCommit={(v) => ed.setAuthor(v)} /></label>
          <label title="Tempo. One tick is 2.5/BPM s; at 125 BPM that is exactly one 50 Hz frame, the length of one YM2149 register update.">BPM <NumField value={song.bpm} min={32} max={255} onCommit={(v) => ed.setBpm(v)} /></label>
          <label title="Ticks per row">Speed <NumField value={song.speed} min={1} max={31} onCommit={(v) => ed.setSpeed(v)} /></label>
        </div>
        <div className="tk-line">
          <button className={`btn${ed.playing && ed.playMode === 'song' ? ' primary' : ''}`} onClick={() => void ed.play('song', false)} title="Right Ctrl">▶ Song</button>
          <button className={`btn${ed.playing && ed.playMode === 'pattern' ? ' primary' : ''}`} onClick={() => void ed.play('pattern', false)} title="Right Alt">▶ Pattern</button>
          <button className="btn" onClick={() => void ed.play(ed.playMode, true)} title="Play from the cursor row">▶ From cursor</button>
          <button className="btn" onClick={() => ed.stop()} title="Space">■ Stop</button>
          <button className={`btn${ed.editing ? ' rec' : ''}`} onClick={() => ed.toggleEdit()} title="Space (when stopped)">{ed.editing ? '● Editing' : '○ Edit'}</button>
          <span className="sep" />
          <label title="F1-F8">Octave <button className="btn tiny" onClick={() => ed.setOctave(ed.octave - 1)}>−</button><span className="val">{ed.octave}</span><button className="btn tiny" onClick={() => ed.setOctave(ed.octave + 1)}>+</button></label>
          <label title="Rows the cursor moves after a note is entered (` or § key)">Add <button className="btn tiny" onClick={() => ed.cycleStep(-1)}>−</button><span className="val">{ed.step}</span><button className="btn tiny" onClick={() => ed.cycleStep(1)}>+</button></label>
          <label title="Instrument used for the notes you type">Instrument <button className="btn tiny" onClick={() => ed.selectInstrument(ed.instrument - 1)}>−</button><span className="val">{toHex2(ed.instrument)}</span><button className="btn tiny" onClick={() => ed.selectInstrument(ed.instrument + 1)}>+</button></label>
          <label className="chk" title="Adds a fourth column for digidrums: a note there plays that drum of the instrument on voice C"><input type="checkbox" checked={ed.hasDrumChannel} onChange={(e) => ed.setDrumChannel(e.target.checked)} /> Drum channel</label>
          <button className="btn" onClick={() => setDialog({ kind: 'transpose' })}>Transpose…</button>
          <button className="btn" onClick={() => setDialog({ kind: 'scale', scope: sel ? 'block' : 'pattern' })} title="Ctrl/Alt/Shift+V">Scale volume…</button>
          <span className="time">{ed.playing ? `${toHex2(ed.playOrder)}:${toHex2(ed.playRow)}` : `${secs ? Math.floor(secs / 60) + ':' + String(Math.floor(secs % 60)).padStart(2, '0') : '—'}`}</span>
        </div>
      </section>

      <div className="tk-main">
        <section className="panel tk-order">
          <h2>Order</h2>
          <div className="orderlist" role="listbox" aria-label="Song order">
            {song.order.map((p, i) => (
              <button key={i} role="option" aria-selected={i === ed.orderPos}
                className={`ord${i === ed.orderPos ? ' on' : ''}${ed.playing && i === ed.playOrder ? ' now' : ''}`}
                onClick={() => ed.setOrderPos(i)}>
                <span className="oi">{toHex2(i)}</span><span className="op">{toHex2(p)}</span>{i === song.restartPos && <span className="lp" title="the song loops back here">↻</span>}
              </button>
            ))}
          </div>
          <div className="btns">
            <button className="btn small" onClick={() => ed.addPattern()} title="Insert a new empty pattern after this position">New pat</button>
            <button className="btn small" onClick={() => ed.clonePattern()} title="Copy this pattern into a new one">Clone pat</button>
            <button className="btn small" onClick={() => ed.addOrderEntry()} title="Insert the same pattern again after this position">Repeat</button>
            <button className="btn small" disabled={song.order.length < 2} onClick={() => ed.removeOrderEntry()}>Remove</button>
            <button className="btn small" disabled={ed.orderPos === 0} onClick={() => ed.moveOrderEntry(ed.orderPos, ed.orderPos - 1)}>Move ↑</button>
            <button className="btn small" disabled={ed.orderPos >= song.order.length - 1} onClick={() => ed.moveOrderEntry(ed.orderPos, ed.orderPos + 1)}>Move ↓</button>
            <button className="btn small" onClick={() => ed.setRestartPos(ed.orderPos)} title="Where the song jumps back to at its end">Loop here</button>
            <button className="btn small" onClick={() => ed.setOrderEntry(ed.orderPos, ed.patIdx + 1)} title="Ctrl+→">Pat +</button>
          </div>
          <label className="plen">Pattern {toHex2(ed.patIdx)} length <NumField value={pat.rows} min={1} max={256} onCommit={(v) => ed.setPatternLength(v)} /></label>
        </section>

        <section className="panel tk-pat">
          <h2>Pattern {toHex2(ed.patIdx)} <small>position {toHex2(ed.orderPos)} · row {toHex2(ed.row)}/{toHex2(pat.rows - 1)}</small>{ed.editing && <span className="recdot">EDIT</span>}</h2>
          <div className="phead" style={{ ["--nch" as string]: ed.nch }}>
            <div className="rn">Row</div>
            {Array.from({ length: ed.nch }, (_, c) => {
              const silenced = anySolo ? !ed.soloed[c] : ed.muted[c];
              return (
                <div key={c} className={`ph${silenced ? ' dim' : ''}`}>
                  <span>{ed.isDrumColumn(c) ? 'Drum' : CH_NAME[c]}</span>
                  <button className={`ms${ed.muted[c] ? ' on' : ''}`} title="Mute" onClick={(e) => { ed.toggleMute(c); e.currentTarget.blur(); }}>M</button>
                  <button className={`ms${ed.soloed[c] ? ' on solo' : ''}`} title="Solo" onClick={(e) => { ed.toggleSolo(c); e.currentTarget.blur(); }}>S</button>
                </div>
              );
            })}
          </div>
          <div className="pscroll" ref={scrollRef} onWheel={onWheel}>
            <div className="pgrid" style={{ ["--nch" as string]: ed.nch }} ref={gridRef} onMouseDown={onDown} onMouseMove={onMove}>
              {pat.cells.map((cells, r) => (
                <Row key={r} r={r} cells={cells} cur={r === ed.row ? ed.channel : -1} col={ed.column} editing={ed.editing}
                  s1={sel && r >= sel.r1 && r <= sel.r2 ? sel.c1 : -1} s2={sel && r >= sel.r1 && r <= sel.r2 ? sel.c2 : -2}
                  play={ed.playing && ed.playOrder === ed.orderPos && ed.playRow === r} hl={r % 4 === 0} />
              ))}
            </div>
          </div>
          <div className="statusline" aria-live="polite">{msg || drumHint || hint || (ed.editing ? 'Editing: type notes with the keyboard (Z S X D C V … lower row, Q 2 W 3 E … upper row).' : 'Not editing – keys only audition. Press Space or "Edit" to record notes into the pattern.')}</div>
        </section>

        <section className="panel tk-inst">
          <h2>Instruments</h2>
          <div className="instlist" role="listbox" aria-label="Instruments">
            {song.instruments.map((ins, i) => i === 0 ? null : (
              <button key={i} role="option" aria-selected={i === ed.instrument} className={`ins${i === ed.instrument ? ' on' : ''}`}
                onClick={() => ed.selectInstrument(i)} onDoubleClick={() => { ed.selectInstrument(i); setInstOpen(true); }}>
                <span className="oi">{toHex2(i)}</span><span className="nm">{ins.name || '(unnamed)'}</span>
                <span className="us">{ins.seq ? 'seq' : ''} {usage[i] ? usage[i] : ''}</span>
              </button>
            ))}
          </div>
          <div className="btns">
            <button className="btn small" onClick={() => setInstOpen((v) => !v)}>{instOpen ? 'Hide editor' : 'Edit…'}</button>
            <button className="btn small" onClick={() => setDrumOpen((v) => !v)} title="Digidrum samples of this instrument">{drumOpen ? 'Hide drums' : 'Drums…'}</button>
            <button className="btn small" onClick={() => ed.addInstrument(song.instruments[ed.instrument])} title="Copy the selected instrument">Duplicate</button>
            <button className="btn small" onClick={() => ed.addInstrument()}>New</button>
          </div>
        </section>
      </div>

      {instOpen && <InstrumentEditor ed={ed} idx={ed.instrument} onClose={() => setInstOpen(false)} />}
      {drumOpen && <DrumEditor ed={ed} idx={ed.instrument} onClose={() => setDrumOpen(false)} />}

      <section className="panel">
        <h2>Export <small>{secs ? `${secs.toFixed(1)} s · ${Math.round(secs * 50)} frames` : ''}</small></h2>
        <div className="tk-line">
          <button className="btn primary" onClick={exp.sndh}>SNDH (.sndh)</button>
          <button className="btn" onClick={exp.ym}>YM (.ym)</button>
          <button className="btn" onClick={exp.game}>Game kit (.zip)</button>
          <button className="btn" onClick={exp.mym} title="song + voice bank for gwEm's maxYMiser tracker">maxYMiser (.mys + .myv)</button>
          <button className="btn" onClick={exp.myi} title="the selected instrument as a maxYMiser .myi">Instrument (.myi)</button>
          <button className="btn" onClick={exp.wav}>Preview (.wav)</button>
          <button className="btn" onClick={exp.regs}>Registers (.regs)</button>
        </div>
        {warns.length > 0 && <ul className="warnlist">{warns.map((w, i) => <li key={i}>{w}</li>)}</ul>}
      </section>

      <details className="panel keyhelp">
        <summary>Keyboard reference</summary>
        <table><tbody>
          <tr><td>Z S X D C V G B H N J M , L .</td><td>notes of the lower octave; Q 2 W 3 E R 5 T 6 Y 7 U I 9 O the octave above. F1–F8 set the octave.</td></tr>
          <tr><td>Space</td><td>stop playback, or switch Edit on/off · <kbd>Right Ctrl</kbd> play song · <kbd>Right Alt</kbd> play pattern · <kbd>Right Shift</kbd> record pattern</td></tr>
          <tr><td>Caps Lock / 1</td><td>note off (===) · <kbd>`</kbd> or <kbd>§</kbd> cycles the "Add" step (Shift = backwards)</td></tr>
          <tr><td>Arrows, Tab</td><td>move cursor (Tab / Shift+Tab = next / previous channel), Home / End / PgUp / PgDn</td></tr>
          <tr><td>Shift+←/→ · Ctrl+←/→</td><td>previous / next song position · previous / next pattern number at this position</td></tr>
          <tr><td>Alt+arrows</td><td>select a block (Shift+↑/↓ too); mouse drag and Shift+click also work</td></tr>
          <tr><td>Del</td><td>clear what the cursor column holds · Shift = whole cell · Ctrl = volume + effect · Alt = effect</td></tr>
          <tr><td>Insert / Backspace</td><td>insert / delete a cell in this channel (Shift = whole row)</td></tr>
          <tr><td>Shift / Ctrl+Shift / Alt + F3 F4 F5</td><td>cut / copy / paste the track / the pattern / the block</td></tr>
          <tr><td>Ctrl / Alt / Shift + V</td><td>scale volume in block / track / pattern (Ctrl+Shift = whole song)</td></tr>
          <tr><td>Ctrl+Z · Ctrl+Y · Ctrl+S</td><td>undo · redo · save .ymt</td></tr>
          <tr><td>Effect column</td><td>type 0–9 A–H K L M P R T X Y Q S U Z (Q SID voice, S sinus-SID, U sync-buzzer: see the hint line). Digits typed in the parameter without an effect make an arpeggio (047 = major chord).</td></tr>
        </tbody></table>
      </details>

      {dialog?.kind === 'scale' && <ScaleDialog scope={dialog.scope} hasSel={!!sel} onClose={() => setDialog(null)} onApply={(sc, a, b) => { ed.scaleVolume(sc, a, b); setDialog(null); }} />}
      {dialog?.kind === 'transpose' && <TransposeDialog hasSel={!!sel} instrument={ed.instrument} onClose={() => setDialog(null)}
        onApply={(sc, n, filt) => { const changed = ed.transpose(sc, n, filt ? ed.instrument : null); setDialog(null); setMsg(changed ? `Transposed ${changed} note${changed === 1 ? '' : 's'}.` : 'Nothing to transpose (no notes in that range).'); }} />}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal" onMouseDown={onClose}>
      <form className="panel dlg" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => e.preventDefault()}>
        <h2>{title}</h2>
        {children}
      </form>
    </div>
  );
}

function ScaleDialog({ scope: s0, hasSel, onClose, onApply }: { scope: Scope; hasSel: boolean; onClose: () => void; onApply: (s: Scope, a: number, b: number) => void }) {
  const [scope, setScope] = useState<Scope>(s0);
  const [a, setA] = useState('100'), [b, setB] = useState('100');
  const go = () => { const x = parseFloat(a.replace(',', '.')), y = parseFloat(b.replace(',', '.')); if (x >= 0 && y >= 0) onApply(scope, Math.min(400, x), Math.min(400, y)); };
  return (
    <Modal title="Scale volume" onClose={onClose}>
      <p className="note">Changes the volume column of every note in the range. Use different start and end values for a fade.</p>
      <label className="row"><span className="lbl">Range</span><select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
        <option value="block" disabled={!hasSel}>selected block</option><option value="track">this track</option><option value="pattern">this pattern</option><option value="song">whole song</option></select></label>
      <label className="row"><span className="lbl">Start %</span><input autoFocus className="txt" value={a} onChange={(e) => setA(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') onClose(); }} /></label>
      <label className="row"><span className="lbl">End %</span><input className="txt" value={b} onChange={(e) => setB(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') onClose(); }} /></label>
      <div className="btns"><button type="button" className="btn primary" onClick={go}>Apply</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

function TransposeDialog({ hasSel, instrument, onClose, onApply }: { hasSel: boolean; instrument: number; onClose: () => void; onApply: (s: Scope, n: number, onlyInstrument: boolean) => void }) {
  const [scope, setScope] = useState<Scope>(hasSel ? 'block' : 'pattern');
  const [n, setN] = useState(12);
  const [filt, setFilt] = useState(false);
  return (
    <Modal title="Transpose" onClose={onClose}>
      <label className="row"><span className="lbl">Range</span><select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
        <option value="block" disabled={!hasSel}>selected block</option><option value="track">this track</option><option value="pattern">this pattern</option><option value="song">whole song</option></select></label>
      <label className="row"><span className="lbl">Semitones</span><NumField value={n} min={-48} max={48} onCommit={setN} /></label>
      <label className="chk"><input type="checkbox" checked={filt} onChange={(e) => setFilt(e.target.checked)} /> only notes of instrument {toHex2(instrument)}</label>
      <div className="btns"><button type="button" className="btn primary" onClick={() => onApply(scope, n, filt)}>Apply</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}
