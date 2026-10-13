// Digidrum sample editor: the 4-bit samples an instrument carries (Z effect / drum channel).
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Editor } from '../tracker/editor';
import { toHex2 } from '../tracker/types';
import {
  type DrumSample, MAX_DRUMS, MAX_DRUM_BYTES, DAC, mfpRate, drumFrames, drumSeconds, decodeWav, drumToAudio,
  prepareDrum, starterKit, synthDrum, SYNTH_DRUM_NAMES,
} from '../core/drums';
import { NumField, TextField } from './fields';

interface Settings { rateHz: number; gainDb: number; normalize: boolean; trim: boolean; noiseShape: boolean; fadeOut: boolean; maxMs: number }
const DEFAULTS: Settings = { rateHz: 8000, gainDb: 0, normalize: true, trim: true, noiseShape: false, fadeOut: true, maxMs: 0 };

/** the audio a drum was made from + the settings used, so changing a setting re-processes the original instead of the 4-bit result */
interface Source { data: Float32Array; rate: number; set: Settings }
const SOURCES = new WeakMap<Uint8Array, Source>();

function Wave({ d }: { d: DrumSample }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const g = cv.getContext('2d'); if (!g) return;
    const W = cv.width, H = cv.height;
    g.fillStyle = '#0d1030'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#2b3150'; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    g.fillStyle = '#7ea8ff';
    const n = d.pcm.length;
    for (let x = 0; x < W; x++) {
      const a = Math.floor((x / W) * n), b = Math.max(a + 1, Math.floor(((x + 1) / W) * n));
      let lo = 15, hi = 0;
      for (let i = a; i < b && i < n; i++) { lo = Math.min(lo, d.pcm[i]); hi = Math.max(hi, d.pcm[i]); }
      const y1 = H - 2 - DAC[hi] * (H - 4), y2 = H - 2 - DAC[lo] * (H - 4);
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }, [d]);
  return <canvas ref={ref} className="dwave" width={520} height={90} aria-label={`Waveform of ${d.name}`} />;
}

export function DrumEditor({ ed, idx, onClose }: { ed: Editor; idx: number; onClose: () => void }) {
  useSyncExternalStore(ed.subscribe, ed.getVersion);
  const inst = ed.song.instruments[idx];
  const bank = inst?.digiDrums ?? [];
  const [sel, setSel] = useState(0);
  const [msg, setMsg] = useState('');
  const [defs, setDefs] = useState<Settings>(DEFAULTS);
  const fileRef = useRef<HTMLInputElement>(null);
  const cur = bank[Math.min(sel, bank.length - 1)];
  const curIdx = Math.min(sel, bank.length - 1);
  const src = cur ? SOURCES.get(cur.pcm) : undefined;
  const set = src?.set ?? { ...defs, rateHz: cur ? cur.rateHz : defs.rateHz };

  const put = (next: DrumSample[], select = sel) => { ed.updateInstrument({ digiDrums: next }, idx); setSel(Math.max(0, Math.min(next.length - 1, select))); };
  const room = () => (bank.length >= MAX_DRUMS ? (setMsg(`At most ${MAX_DRUMS} digidrums per instrument.`), false) : true);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const next = bank.slice();
    const notes: string[] = [];
    for (const f of Array.from(files)) {
      if (next.length >= MAX_DRUMS) { notes.push('limit reached'); break; }
      try {
        const au = decodeWav(new Uint8Array(await f.arrayBuffer()));
        const d = prepareDrum(f.name.replace(/\.[^.]+$/, '').slice(0, 24), au.data, au.rate, defs);
        SOURCES.set(d.pcm, { data: au.data, rate: au.rate, set: { ...defs } });
        next.push(d);
        notes.push(`${d.name}: ${d.pcm.length} samples @ ${Math.round(mfpRate(d.rateHz).hz)} Hz`);
      } catch (e) { notes.push(`${f.name}: ${(e as Error).message}`); }
    }
    put(next, next.length - 1);
    setMsg(notes.join(' · '));
    if (fileRef.current) fileRef.current.value = '';
  };
  const reprocess = (patch: Partial<Settings>) => {
    if (!cur) { setDefs({ ...defs, ...patch }); return; }
    const s = { ...set, ...patch };
    setDefs(s);
    // original audio when we have it, otherwise the 4-bit drum itself
    const from = src ?? { data: drumToAudio(cur, 44100), rate: 44100, set: s };
    const d = prepareDrum(cur.name, from.data, from.rate, s);
    SOURCES.set(d.pcm, { data: from.data, rate: from.rate, set: s });
    const next = bank.slice(); next[curIdx] = d; put(next, curIdx);
  };

  const total = bank.reduce((n, d) => n + d.pcm.length, 0);
  return (
    <section className="panel drumed">
      <h2>Digidrums <small>instrument {toHex2(idx)} · {inst?.name || '(unnamed)'}</small>
        <button className="btn small close" onClick={onClose} aria-label="Close drum editor">✕</button></h2>
      <p className="note">
        4-bit samples written to a voice's volume register by an MFP timer interrupt. Use <b>Z0n</b> on a tone channel (plays drum n of the
        instrument in that cell) or the <b>drum channel</b> (notes C-1, C#-1 … = drum 1, 2 …). A drum silences its voice while it plays and only one drum plays at a time.
      </p>
      <div className="dcols">
        <div className="dlist" role="listbox" aria-label="Digidrums">
          {bank.length === 0 && <div className="dempty">No digidrums yet. Load a WAV file or add the starter kit.</div>}
          {bank.map((d, i) => (
            <div key={i} role="option" aria-selected={i === curIdx} className={`drow${i === curIdx ? ' on' : ''}`} onClick={() => setSel(i)}>
              <span className="oi">{toHex2(i + 1)}</span>
              <span className="nm">{d.name || '(unnamed)'}</span>
              <span className="us">{Math.round(mfpRate(d.rateHz).hz)} Hz · {d.pcm.length} B · {drumFrames(d)} fr</span>
              <button className="btn tiny" title="Play" onClick={(e) => { e.stopPropagation(); ed.auditionDrum(d); }}>▶</button>
            </div>
          ))}
        </div>
        <div className="dctl">
          <div className="btns">
            <button title="Add one or more WAV files as digidrums" className="btn small" onClick={() => fileRef.current?.click()}>Load WAV…</button>
            <input ref={fileRef} type="file" accept=".wav,audio/wav" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
            <button title="Add six synthesised drums: kick, snare, hi-hat, open hat, tom, clap" className="btn small" onClick={() => { if (room()) { const kit = starterKit(defs.rateHz); put([...bank, ...kit].slice(0, MAX_DRUMS), bank.length); } }}>Add starter kit</button>
            <select className="sel" value="" aria-label="Add a synthesised drum" onChange={(e) => { if (e.target.value && room()) put([...bank, synthDrum(e.target.value, defs.rateHz)], bank.length); }}>
              <option value="">Add synth drum…</option>
              {SYNTH_DRUM_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          {cur && (
            <>
              <div className="btns">
                <button title="Move the selected drum up (changes its number)" className="btn small" disabled={curIdx === 0} onClick={() => { const n = bank.slice(); [n[curIdx - 1], n[curIdx]] = [n[curIdx], n[curIdx - 1]]; put(n, curIdx - 1); }}>↑</button>
                <button title="Move the selected drum down (changes its number)" className="btn small" disabled={curIdx >= bank.length - 1} onClick={() => { const n = bank.slice(); [n[curIdx + 1], n[curIdx]] = [n[curIdx], n[curIdx + 1]]; put(n, curIdx + 1); }}>↓</button>
                <button title="Duplicate the selected drum" className="btn small" onClick={() => { if (room()) { const n = bank.slice(); const d = { ...cur, name: cur.name + ' copy', pcm: cur.pcm.slice() }; const s = SOURCES.get(cur.pcm); if (s) SOURCES.set(d.pcm, s); n.splice(curIdx + 1, 0, d); put(n, curIdx + 1); } }}>Duplicate</button>
                <button title="Delete the selected drum" className="btn small" onClick={() => { const n = bank.slice(); n.splice(curIdx, 1); put(n, curIdx); }}>Remove</button>
                <button className="btn small" title="Play backwards" onClick={() => { const d = { ...cur, pcm: cur.pcm.slice().reverse() }; const n = bank.slice(); n[curIdx] = d; put(n, curIdx); }}>Reverse</button>
              </div>
              <label className="row"><span className="lbl">Name</span><TextField value={cur.name} maxLength={24} onCommit={(v) => { const n = bank.slice(); n[curIdx] = { ...cur, name: v }; put(n, curIdx); }} /></label>
            </>
          )}
          <div className="dset">
            <label title="Play rate. The ST can only make some rates (MFP timer); the nearest is used.">Rate Hz <NumField value={Math.round(set.rateHz)} min={1000} max={24000} onCommit={(v) => reprocess({ rateHz: v })} />
              <small>{Math.round(mfpRate(set.rateHz).hz)} Hz</small></label>
            <label>Gain dB <NumField value={set.gainDb} min={-24} max={24} onCommit={(v) => reprocess({ gainDb: v })} /></label>
            <label title="Longest drum in ms, 0 = no limit">Max ms <NumField value={set.maxMs} min={0} max={2000} onCommit={(v) => reprocess({ maxMs: v })} /></label>
            <label className="chk"><input type="checkbox" checked={set.normalize} onChange={(e) => reprocess({ normalize: e.target.checked })} /> normalise</label>
            <label className="chk"><input type="checkbox" checked={set.trim} onChange={(e) => reprocess({ trim: e.target.checked })} /> trim silence</label>
            <label className="chk"><input type="checkbox" checked={set.noiseShape} onChange={(e) => reprocess({ noiseShape: e.target.checked })} /> noise shaping</label>
            <label className="chk"><input type="checkbox" checked={set.fadeOut} onChange={(e) => reprocess({ fadeOut: e.target.checked })} /> fade out</label>
          </div>
          {cur && <Wave d={cur} />}
          {cur && <div className="note">{cur.pcm.length} samples · {drumSeconds(cur).toFixed(3)} s · {drumFrames(cur)} frames at 50 Hz{cur.pcm.length >= MAX_DRUM_BYTES ? ' · at the size limit' : ''}</div>}
        </div>
      </div>
      <div className="note">{bank.length} drum{bank.length === 1 ? '' : 's'}, {total.toLocaleString()} bytes in this instrument.{msg ? ' ' + msg : ''}</div>
    </section>
  );
}
