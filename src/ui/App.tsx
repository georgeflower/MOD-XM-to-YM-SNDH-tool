import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadModule } from '../core/load';
import type { Module } from '../core/types';
import { convert, type ConvertResult, type DrumKind } from '../core/convert';
import { packStream } from '../export/stream';
import { writeYm5 } from '../export/ym';
import { writeSndh } from '../export/sndh';
import { writeCHeader } from '../export/cheader';
import { replayerHeader } from '../export/replayer';
import { renderYm } from '../export/ymemu';
import { encodeWav } from '../export/wav';
import { zip } from '../export/zip';
import { Preview, type Source } from './audio';
import { download } from './download';
import { AyRoll } from './AyRoll';

const DEMO = 'back_in_town_again.mod';

interface Opts { gainDb: number; drumBonus: number; sticky: number; arpOrder: 'xy' | 'yx' }
const DEFAULT_OPTS: Opts = { gainDb: 0, drumBonus: 3, sticky: 1.5, arpOrder: 'xy' };

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const slug = (s: string) => s.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'song';

function Slider({ label, value, min, max, step, onChange, unit = '', hint }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; unit?: string; hint: string;
}) {
  return (
    <label className="row" title={hint}>
      <span className="lbl">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      <span className="val">{value}{unit}</span>
    </label>
  );
}

export function App() {
  const [fileName, setFileName] = useState('');
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [mod, setMod] = useState<Module | null>(null);
  const [error, setError] = useState('');
  const [opts, setOpts] = useState<Opts>(DEFAULT_OPTS);
  const [prio, setPrio] = useState<Record<number, number>>({});
  const [drumClass, setDrumClass] = useState<Record<number, DrumKind>>({});
  const [res, setRes] = useState<ConvertResult | null>(null);
  const [busy, setBusy] = useState('');
  const [source, setSource] = useState<Source>('ay');
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [author, setAuthor] = useState('');
  const previewRef = useRef<Preview | null>(null);
  const preview = () => (previewRef.current ??= new Preview());
  const dropRef = useRef<HTMLDivElement>(null);

  // ---- loading
  const loadBytes = useCallback((name: string, data: Uint8Array) => {
    try {
      const m = loadModule(data);
      setError(''); setFileName(name); setBytes(data); setMod(m);
      setPrio({}); setDrumClass({}); setOpts(DEFAULT_OPTS);
      preview().loadOriginal(data);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);
  const loadFile = async (f: File) => loadBytes(f.name, new Uint8Array(await f.arrayBuffer()));
  const loadDemo = async () => {
    const r = await fetch(`${import.meta.env.BASE_URL}demo/${DEMO}`);
    loadBytes(DEMO, new Uint8Array(await r.arrayBuffer()));
  };

  // ---- conversion (debounced; runs on the main thread, ~1-3 s for a long song)
  useEffect(() => {
    if (!mod) return;
    setBusy('Converting to YM2149 registers…');
    const h = setTimeout(() => {
      try {
        const r = convert(mod, { gainDb: opts.gainDb, drumBonus: opts.drumBonus, sticky: opts.sticky, arpOrder: opts.arpOrder, prio, drumClass });
        setRes(r);
        setBusy('Rendering the YM2149 preview…');
        setTimeout(() => {
          preview().setAy(renderYm(r.regs, r.nframes));
          setBusy('');
        }, 20);
      } catch (e) {
        setError(String((e as Error).message ?? e)); setBusy('');
      }
    }, 250);
    return () => clearTimeout(h);
  }, [mod, opts, prio, drumClass]);

  // ---- transport
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => { setPos(preview().position()); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const togglePlay = () => {
    const p = preview();
    if (p.playing) { p.stop(); setPlaying(false); setPos(p.position()); } else { p.play(pos); setPlaying(true); }
  };
  const rewind = () => { preview().rewind(); setPos(0); setPlaying(false); };
  const pickSource = (s: Source) => { setSource(s); preview().setSource(s); };

  // keyboard: space = play/stop, Tab = A/B
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.code === 'Tab' && !e.shiftKey && mod && t.tagName !== 'SELECT') { e.preventDefault(); pickSource(source === 'ay' ? 'orig' : 'ay'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // ---- exports
  const base = slug(mod?.title || fileName);
  const title = (mod?.title || base).slice(0, 32);
  const packed = useMemo(() => (res ? packStream(res.regs, res.nframes, res.loopFrame) : null), [res]);
  const meta = { title, author: author || 'unknown' };
  const exp = {
    sndh: () => res && download(`${base}.sndh`, writeSndh(res.regs, res.nframes, res.loopFrame, meta)),
    ym: () => res && download(`${base}.ym`, writeYm5(res.regs, res.nframes, res.loopFrame, title, meta.author, `converted from ${fileName}`)),
    game: () => {
      if (!res || !packed) return;
      download(`${base}_gamekit.zip`, zip([
        { name: `${base}.h`, data: writeCHeader(base, packed.data, res.nframes, res.loopFrame, packed.loopOffset) },
        { name: 'ymplay.h', data: replayerHeader(base) },
        { name: 'README.txt', data: `Packed YM2149 stream, ${res.nframes} frames @ 50 Hz, ${packed.data.length} bytes.\nSee the comment at the top of ymplay.h.\n` },
      ]), 'application/zip');
    },
    regs: () => res && download(`${base}.regs`, res.regs),
    wav: () => res && download(`${base}_ym.wav`, encodeWav(renderYm(res.regs, res.nframes), 44100), 'audio/wav'),
    log: () => res && download(`${base}_report.txt`, res.report.join('\n') + '\n', 'text/plain'),
  };

  // ---- drag & drop
  useEffect(() => {
    const prevent = (e: DragEvent) => { e.preventDefault(); };
    const drop = (e: DragEvent) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f); };
    window.addEventListener('dragover', prevent); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', drop); };
  }, []);

  const seconds = res ? res.nframes / 50 : 0;
  const instRows = res?.instruments ?? [];

  return (
    <div className="app" ref={dropRef}>
      <header className="titlebar">
        <h1>MOD/XM <span>→</span> YM2149 <small>Atari ST · SNDH · game stream</small></h1>
        <div className="actions">
          <label className="btn">Load MOD / XM…
            <input type="file" accept=".mod,.xm,.MOD,.XM" hidden onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
          </label>
          <button className="btn" onClick={loadDemo}>Demo: back_in_town_again</button>
        </div>
      </header>

      {error && <div className="panel err">{error}</div>}

      {!mod && (
        <section className="panel welcome">
          <h2>Start here</h2>
          <ol>
            <li>Load a <b>.MOD</b> or <b>.XM</b> file (or drop it anywhere on this page) — or press <b>Demo</b>.</li>
            <li>The tool reduces it to <b>one YM2149 chip (3 voices + noise)</b> at 50 Hz and lets you listen to both: <kbd>Tab</kbd> flips between original and YM.</li>
            <li>Fine-tune with the options, then export an <b>SNDH</b>, a <b>.YM</b> or a <b>game kit</b> (C header + 30-line replayer).</li>
          </ol>
        </section>
      )}

      {mod && (
        <>
          <div className="grid3">
            <section className="panel">
              <h2>Module</h2>
              <dl className="kv">
                <dt>File</dt><dd>{fileName}</dd>
                <dt>Title</dt><dd>{mod.title || '—'}</dd>
                <dt>Type</dt><dd>{mod.kind.toUpperCase()}, {mod.nch} channels</dd>
                <dt>Patterns</dt><dd>{mod.patterns.length} in {mod.order.length} orders</dd>
                <dt>Speed / BPM</dt><dd>{mod.speed} / {mod.bpm}</dd>
                <dt>YM length</dt><dd>{res ? `${fmtTime(seconds)} · ${res.nframes} frames` : '…'}</dd>
              </dl>
              <label className="row"><span className="lbl">Composer</span>
                <input type="text" className="txt" value={author} placeholder="written to SNDH / YM" maxLength={40} onChange={(e) => setAuthor(e.target.value)} />
              </label>
            </section>

            <section className="panel">
              <h2>Conversion</h2>
              <Slider label="Level" value={opts.gainDb} min={-12} max={12} step={0.5} unit=" dB" onChange={(v) => setOpts({ ...opts, gainDb: v })}
                hint="Overall loudness mapped onto the 16 YM volume steps" />
              <Slider label="Drum priority" value={opts.drumBonus} min={0} max={6} step={0.5} onChange={(v) => setOpts({ ...opts, drumBonus: v })}
                hint="How strongly kicks/snares/hats win a voice against melody notes" />
              <Slider label="Voice stickiness" value={opts.sticky} min={0} max={4} step={0.25} onChange={(v) => setOpts({ ...opts, sticky: v })}
                hint="Higher = a note stays on the same YM voice (less jumping, fewer clicks)" />
              <label className="row" title="Order in which an arpeggio cycles its notes">
                <span className="lbl">Arpeggio</span>
                <select value={opts.arpOrder} onChange={(e) => setOpts({ ...opts, arpOrder: e.target.value as 'xy' | 'yx' })}>
                  <option value="xy">0 → x → y (FT2 / PT)</option>
                  <option value="yx">0 → y → x</option>
                </select>
              </label>
              <button className="btn small" onClick={() => { setOpts(DEFAULT_OPTS); setPrio({}); setDrumClass({}); }}>Reset to auto</button>
            </section>

            <section className="panel">
              <h2>Export</h2>
              <div className="btns">
                <button className="btn primary" disabled={!res} onClick={exp.sndh} title="Playable in any SNDH player (68000 player included, 50 Hz)">SNDH (.sndh)</button>
                <button className="btn" disabled={!res} onClick={exp.ym} title="YM5! register dump — ST-Sound, Atari players">YM (.ym)</button>
                <button className="btn" disabled={!res} onClick={exp.game} title="C header with the packed stream + ymplay.h replayer">Game kit (.zip)</button>
                <button className="btn" disabled={!res} onClick={exp.wav}>Preview (.wav)</button>
                <button className="btn" disabled={!res} onClick={exp.regs}>Raw regs (.regs)</button>
                <button className="btn" disabled={!res} onClick={exp.log}>Report (.txt)</button>
              </div>
              {packed && res && (
                <p className="note">Packed stream: <b>{packed.data.length.toLocaleString()}</b> bytes ({(packed.data.length / (res.nframes / 50)).toFixed(0)} B/s). SNDH adds a 220-byte player.</p>
              )}
              <p className="note soft">Furnace · Arkos · Maxymiser export: coming next.</p>
            </section>
          </div>

          <section className="panel">
            <h2>Preview <small>space = play/stop · tab = original ⇄ YM</small></h2>
            <div className="transport">
              <button className="btn" onClick={rewind} disabled={!res}>⏮</button>
              <button className="btn primary" onClick={togglePlay} disabled={!res || !!busy}>{playing ? '■ Stop' : '▶ Play'}</button>
              <div className="ab" role="group" aria-label="Source">
                <button className={source === 'orig' ? 'on' : ''} onClick={() => pickSource('orig')}>A · Original</button>
                <button className={source === 'ay' ? 'on' : ''} onClick={() => pickSource('ay')}>B · YM2149</button>
              </div>
              <span className="time">{fmtTime(pos)} / {fmtTime(seconds)}</span>
              {busy && <span className="busy">{busy}</span>}
            </div>
            {res && <AyRoll regs={res.regs} nframes={res.nframes} position={pos} />}
            <div className="legend"><i style={{ background: '#ff5555' }} />voice A <i style={{ background: '#55dd55' }} />voice B <i style={{ background: '#5599ff' }} />voice C <i style={{ background: '#ffaa33' }} />noise · vertical = pitch, brightness = volume</div>
          </section>

          <div className="grid2">
            <section className="panel">
              <h2>Instruments → AY role</h2>
              <table>
                <thead><tr><th>#</th><th>Name</th><th>Detected</th><th>C-4</th><th>AY role</th></tr></thead>
                <tbody>
                  {instRows.map((r) => (
                    <tr key={r.inst}>
                      <td>{r.inst.toString(16).toUpperCase().padStart(2, '0')}</td>
                      <td className="name">{r.name || '—'}</td>
                      <td>{r.cls}</td>
                      <td>{r.c4Hz ? `${r.c4Hz.toFixed(0)} Hz` : ''}</td>
                      <td>
                        <select value={drumClass[r.inst] ?? (r.drum ? `auto:${r.drum}` : 'auto')}
                          onChange={(e) => {
                            const v = e.target.value;
                            const next = { ...drumClass };
                            if (v.startsWith('auto')) delete next[r.inst]; else next[r.inst] = v as DrumKind;
                            setDrumClass(next);
                          }}>
                          {r.drum ? <option value={`auto:${r.drum}`}>auto: {r.drum}</option> : <option value="auto">auto: tone</option>}
                          <option value="kick">kick</option><option value="snare">snare</option><option value="hat">hat</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="note soft">Manual sample → waveform mapping, per-tick sequences and arpeggio generation arrive in the next milestone.</p>
            </section>

            <section className="panel">
              <h2>Source channels → 3 voices</h2>
              <table>
                <thead><tr><th>Ch</th><th>Played</th><th>Dropped</th><th>Priority</th></tr></thead>
                <tbody>
                  {res && res.played.map((pl, ch) => {
                    const dr = res.dropped[ch], tot = pl + dr;
                    return (
                      <tr key={ch}>
                        <td>{ch + 1}</td>
                        <td>{tot ? Math.round((pl / tot) * 100) : 0}%</td>
                        <td className={dr / (tot || 1) > 0.1 ? 'warn' : ''}>{tot ? Math.round((dr / tot) * 100) : 0}%</td>
                        <td>
                          <button className="btn tiny" onClick={() => setPrio({ ...prio, [ch]: (prio[ch] ?? 0) - 1 })}>−</button>
                          <span className="pv">{prio[ch] ?? 0}</span>
                          <button className="btn tiny" onClick={() => setPrio({ ...prio, [ch]: (prio[ch] ?? 0) + 1 })}>+</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="note soft">A module has more channels than the YM has voices; the converter picks the 3 most important events every 20 ms. Raise a channel's priority to protect it.</p>
            </section>
          </div>

          <section className="panel">
            <h2>Conversion report</h2>
            <pre className="log">{res ? [...res.report, ...res.warnings.map((w) => 'warning: ' + w)].join('\n') : ''}</pre>
          </section>
        </>
      )}
      <footer>Runs entirely in your browser — files never leave your computer.</footer>
    </div>
  );
}
