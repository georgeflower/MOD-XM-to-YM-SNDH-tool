import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadModule } from '../core/load';
import type { Module } from '../core/types';
import { convert, type ConvertResult, type InstMap, type InstMode, type Macro, type MacroStep } from '../core/convert';
import { MACRO_PRESETS, cloneMacro } from '../core/macros';
import { packStream } from '../export/stream';
import { writeYm5, writeYm6 } from '../export/ym';
import { writeSndh } from '../export/sndh';
import { PLAYER_BLOB } from '../player68k/blob';
import { gameKitFiles } from '../export/gamekit';
import { hasDrums, type DrumTrack } from '../core/drums';
import { hasFx, type FxTrack } from '../core/fx';
import { renderYm } from '../export/ymemu';
import { encodeWav } from '../export/wav';
import { zip } from '../export/zip';
import { parseYm, isYm } from '../import/ym';
import { parseSndh, isSndh, type SndhInfo } from '../import/sndh';
import type { AyTune } from '../import/tune';
import { Preview, type Source } from './audio';
import { Editor } from '../tracker/editor';
import { moduleToSong } from '../tracker/fromModule';
import { decodeYmt, isYmt } from '../tracker/ymt';
import { Tracker } from './Tracker';
import { download } from './download';
import { DEFAULT_OPTS, mappingToJson, parseMapping, type Opts } from '../core/mapping';
import { AyRoll } from './AyRoll';
import demoUrl from '../assets/OMARSBAZAAR.xm?inline';

const DEMO = 'OMARSBAZAAR.xm';

const waveName = (w: string | undefined, on: boolean) =>
  !on ? 'square' : w === 'saw' || w === 'pulse' ? 'saw buzzer' : w === 'sawup' ? 'saw buzzer ↗' : w === 'smooth' ? 'triangle buzzer' : 'square';

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
  const [tune, setTune] = useState<(AyTune & { info?: SndhInfo }) | null>(null);
  const [subtune, setSubtune] = useState(1);
  const [secOverride, setSecOverride] = useState(0);   // SNDH: 0 = use the TIME tag
  const [error, setError] = useState('');
  const [opts, setOpts] = useState<Opts>(DEFAULT_OPTS);
  const [prio, setPrio] = useState<Record<number, number>>({});
  const [instMap, setInstMap] = useState<Record<number, InstMap>>({});
  const [macroSel, setMacroSel] = useState<number | null>(null);
  const [res, setRes] = useState<ConvertResult | null>(null);
  const [busy, setBusy] = useState('');
  const [source, setSource] = useState<Source>('ay');
  const [playing, setPlaying] = useState(false);
  const origOk = location.protocol !== 'file:';
  const [pos, setPos] = useState(0);
  const [author, setAuthor] = useState('');
  const previewRef = useRef<Preview | null>(null);
  const preview = () => (previewRef.current ??= new Preview());
  const dropRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<'conv' | 'ed'>('conv');
  const [songReport, setSongReport] = useState<string[]>([]);
  const edRef = useRef<Editor | null>(null);
  const edPreviewRef = useRef<Preview | null>(null);
  /** the pattern editor and its own audio output are created on first use */
  const getEd = () => {
    if (!edRef.current) {
      const e = new Editor();
      edPreviewRef.current ??= new Preview();
      e.attachAudio(edPreviewRef.current);
      edRef.current = e;
    }
    return edRef.current;
  };
  const switchTab = (t: 'conv' | 'ed') => {
    if (t === tab) return;
    if (t === 'ed') { previewRef.current?.stop(); setPlaying(false); getEd(); } else edRef.current?.stop();
    setTab(t);
  };

  // ---- loading: modules are converted, .sndh/.ym are register dumps that are played/imported as they are
  const loadBytes = useCallback((name: string, data: Uint8Array) => {
    try {
      if (isYmt(data)) {
        decodeYmt(data).then((song) => { getEd().loadSong(song, name); setSongReport([]); setError(''); previewRef.current?.stop(); setPlaying(false); setTab('ed'); })
          .catch((e) => setError(String((e as Error).message ?? e)));
        return;
      }
      setError(''); setFileName(name); setBytes(data);
      setPrio({}); setInstMap({}); setMacroSel(null); setOpts(DEFAULT_OPTS); setSubtune(1); setSecOverride(0);
      if (isSndh(data) || isYm(data)) {
        setMod(null); setRes(null);
        setBusy(isSndh(data) ? 'Running the SNDH in the 68000 emulator…' : 'Reading the YM file…');
        preview().stop(); setPlaying(false); setPos(0);
        setTimeout(() => {
          try {
            const t = isSndh(data) ? parseSndh(data, { subtune: 1 }) : parseYm(data);
            setTune(t);
            setAuthor(t.author);
            preview().setSource('ay'); setSource('ay');
            preview().loadOriginal(null);
            preview().setAy(renderYm(t.regs, t.nframes, 44100, 50, 4, t.drums, t.fx));
          } catch (e) { setError(String((e as Error).message ?? e)); setTune(null); }
          setBusy('');
        }, 30);
        return;
      }
      const m = loadModule(data);
      setTune(null); setMod(m);
      preview().loadOriginal(data);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);
  /** re-run an SNDH with another subtune / length */
  const rerunSndh = (sub: number, secs: number) => {
    if (!bytes) return;
    setBusy('Running the SNDH in the 68000 emulator…');
    setTimeout(() => {
      try {
        const t = parseSndh(bytes, { subtune: sub, seconds: secs || undefined });
        setTune(t); preview().setAy(renderYm(t.regs, t.nframes, 44100, 50, 4, t.drums, t.fx)); setPos(0);
      } catch (e) { setError(String((e as Error).message ?? e)); }
      setBusy('');
    }, 30);
  };
  const loadFile = async (f: File) => loadBytes(f.name, new Uint8Array(await f.arrayBuffer()));
  const loadDemo = async () => {
    const r = await fetch(demoUrl); // embedded data: URL, works from file:// too
    loadBytes(DEMO, new Uint8Array(await r.arrayBuffer()));
  };

  // ---- conversion (debounced; runs on the main thread, ~1-3 s for a long song)
  useEffect(() => {
    if (!mod) return;
    setBusy('Converting to YM2149 registers…');
    const h = setTimeout(() => {
      try {
        const r = convert(mod, { gainDb: opts.gainDb, drumBonus: opts.drumBonus, sticky: opts.sticky, arpOrder: opts.arpOrder, arpFill: opts.arpFill, arpMinVol: opts.arpMinVol, digiDrums: opts.digi, digiRate: opts.digiRate, digiMaxMs: opts.digiMaxMs, middleLayout: opts.middle, waveform: opts.waveform, prio, inst: instMap });
        setRes(r);
        setBusy('Rendering the YM2149 preview…');
        setTimeout(() => {
          preview().setAy(renderYm(r.regs, r.nframes, 44100, 50, 4, r.drums));
          setBusy('');
        }, 20);
      } catch (e) {
        setError(String((e as Error).message ?? e)); setBusy('');
      }
    }, 250);
    return () => clearTimeout(h);
  }, [mod, opts, prio, instMap]);

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
      if (tab !== 'conv') return;
      if (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.code === 'Tab' && origOk && !e.shiftKey && mod && t.tagName !== 'SELECT') { e.preventDefault(); pickSource(source === 'ay' ? 'orig' : 'ay'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // ---- instrument mapper helpers
  const patchInst = (i: number, patch: Partial<InstMap>) =>
    setInstMap((m) => {
      const next: Record<number, InstMap> = { ...m, [i]: { ...(m[i] ?? { mode: 'auto' }), ...patch } };
      if (next[i].mode === 'auto' && !next[i].transpose && !next[i].wave) delete next[i];
      return next;
    });
  const modInfo = () => (mod ? { title: mod.title, kind: mod.kind, channels: mod.nch, instruments: mod.instruments.filter(Boolean).length } : undefined);
  const saveMapping = () => {
    const info = modInfo();
    if (info) download(`${slug(mod!.title || fileName)}_mapping.json`, mappingToJson({ opts, prio, inst: instMap }, info), 'application/json');
  };
  const loadMapping = async (f: File) => {
    try {
      const r = parseMapping(await f.text(), modInfo());
      setOpts(r.opts); setPrio(r.prio); setInstMap(r.inst); setMacroSel(null);
      setError(r.warnings.length ? 'Mapping loaded; ' + r.warnings.join('; ') : '');
    } catch (e) { setError(String((e as Error).message ?? e)); }
  };
  const setMode = (i: number, mode: InstMode) => {
    patchInst(i, mode === 'macro' ? { mode, macro: instMap[i]?.macro ?? cloneMacro(MACRO_PRESETS['Pluck']) } : { mode });
    if (mode === 'macro') setMacroSel(i); else if (macroSel === i) setMacroSel(null);
  };
  const editMacro = (i: number, f: (m: Macro) => Macro) => {
    const cur = instMap[i]?.macro;
    if (cur) patchInst(i, { macro: f(cloneMacro(cur)) });
  };

  /** module -> editable pattern song */
  const toPatterns = () => {
    if (!mod) return;
    const e = getEd();
    if (e.dirty && !confirm('Replace the song that is open in the pattern editor?')) return;
    previewRef.current?.stop(); setPlaying(false);
    setBusy('Converting to AY patterns…');
    setTimeout(() => {
      try {
        const r = moduleToSong(mod, { prio, inst: instMap, drumBonus: opts.drumBonus, sticky: opts.sticky, gainDb: opts.gainDb, arpOrder: opts.arpOrder, arpFill: opts.arpFill, arpMinVol: opts.arpMinVol, digiDrums: opts.digi, digiRate: opts.digiRate, digiMaxMs: opts.digiMaxMs, middleLayout: opts.middle, waveform: opts.waveform });
        e.loadSong(r.song, fileName);
        setSongReport([...r.report, ...r.warnings.map((w) => 'warning: ' + w)]);
        setTab('ed');
      } catch (err) { setError(String((err as Error).message ?? err)); }
      setBusy('');
    }, 30);
  };

  // ---- exports
  const out: { regs: Uint8Array; nframes: number; loopFrame: number; drums?: DrumTrack; fx?: FxTrack } | null = mod ? res : tune;
  const base = slug((mod ? mod.title : tune?.title) || fileName);
  const title = ((mod ? mod.title : tune?.title) || base).slice(0, 32);
  const packed = useMemo(() => (out ? packStream(out.regs, out.nframes, out.loopFrame, out.drums, hasFx(out.fx) ? out.fx : null) : null), [out]);
  const meta = { title, author: author || 'unknown' };
  const exp = {
    sndh: () => out && download(`${base}.sndh`, writeSndh(out.regs, out.nframes, out.loopFrame, meta, out.drums, out.fx)),
    ym: () => {
      if (!out) return;
      const comment = `${mod ? 'converted' : 'imported'} from ${fileName}`;
      if (hasDrums(out.drums) || hasFx(out.fx)) {
        const y = writeYm6(out.regs, out.nframes, out.loopFrame, out.drums, title, meta.author, comment, 50, out.fx);
        if (y.warnings.length) setError(y.warnings.join('; '));
        download(`${base}.ym`, y.data);
      } else download(`${base}.ym`, writeYm5(out.regs, out.nframes, out.loopFrame, title, meta.author, comment));
    },
    game: () => { if (out) download(`${base}_gamekit.zip`, zip(gameKitFiles(base, out.regs, out.nframes, out.loopFrame, out.drums, out.fx)), 'application/zip'); },
    regs: () => out && download(`${base}.regs`, out.regs),
    wav: () => out && download(`${base}_ym.wav`, encodeWav(renderYm(out.regs, out.nframes, 44100, 50, 4, out.drums, out.fx), 44100), 'audio/wav'),
    log: () => { const r = mod ? res?.report : tune && [`${tune.source.toUpperCase()} import: ${fileName}`, tune.title && `title: ${tune.title}`, tune.author && `author: ${tune.author}`, `${tune.nframes} frames, loop at ${tune.loopFrame}`, ...tune.warnings.map((w) => 'warning: ' + w)].filter(Boolean) as string[]; if (r) download(`${base}_report.txt`, r.join('\n') + '\n', 'text/plain'); },
  };

  // ---- drag & drop
  useEffect(() => {
    const prevent = (e: DragEvent) => { e.preventDefault(); };
    const drop = (e: DragEvent) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f); };
    window.addEventListener('dragover', prevent); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', drop); };
  }, []);

  const seconds = out ? out.nframes / 50 : 0;
  const instRows = res?.instruments ?? [];

  return (
    <div className="app" ref={dropRef}>
      <header className="titlebar">
        <h1>MOD/XM <span>→</span> YM2149 <small>Atari ST · SNDH · game stream</small></h1>
        <div className="actions">
          <label className="btn">Load MOD / XM / SNDH / YM / YMT…
            <input type="file" accept=".mod,.xm,.sndh,.snd,.ym,.ymt,.MOD,.XM,.SNDH,.SND,.YM,.YMT" hidden onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
          </label>
          <button className="btn" onClick={loadDemo}>Demo: Omar's Bazaar</button>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'conv'} className={tab === 'conv' ? 'on' : ''} onClick={() => switchTab('conv')}>Converter</button>
        <button role="tab" aria-selected={tab === 'ed'} className={tab === 'ed' ? 'on' : ''} onClick={() => switchTab('ed')}>AY pattern editor</button>
      </nav>

      {error && <div className="panel err">{error}</div>}

      {tab === 'ed' && (
        <>
          {songReport.length > 0 && (
            <details className="panel">
              <summary>Converted from {fileName} — report</summary>
              <pre className="log">{songReport.join('\n')}</pre>
            </details>
          )}
          <Tracker ed={getEd()} active onError={setError} />
        </>
      )}

      {tab === 'conv' && <>
      {!mod && !tune && (
        <section className="panel welcome">
          <h2>Start here</h2>
          <ol>
            <li>Load a <b>.MOD</b> or <b>.XM</b> file (or drop it anywhere on this page) — or press <b>Demo</b>. <b>.SNDH</b> and <b>.YM</b> files load too: they are played, shown and re-exported as they are.</li>
            <li>The tool reduces it to <b>one YM2149 chip (3 voices + noise)</b> at 50 Hz and lets you listen to both: <kbd>Tab</kbd> flips between original and YM.</li>
            <li>Fine-tune with the options, then export an <b>SNDH</b>, a <b>.YM</b> or a <b>game kit</b> (C header + 30-line replayer).</li>
            <li>Or press <b>Edit as AY patterns</b> to turn the module into an editable 3-voice tracker song (FastTracker 2 keys) — or open the <b>AY pattern editor</b> tab and write a tune from scratch.</li>
          </ol>
        </section>
      )}

      {(mod || tune) && (
        <>
          <div className="grid3">
            {tune && (
              <section className="panel">
                <h2>Loaded {tune.source === 'sndh' ? 'SNDH' : 'YM'} tune</h2>
                <dl className="kv">
                  <dt>File</dt><dd>{fileName}</dd>
                  <dt>Title</dt><dd>{tune.title || '—'}</dd>
                  <dt>Author</dt><dd>{tune.author || '—'}</dd>
                  {tune.comment && <><dt>Comment</dt><dd>{tune.comment}</dd></>}
                  <dt>Length</dt><dd>{fmtTime(seconds)} · {tune.nframes} frames @ 50 Hz</dd>
                  <dt>Loop</dt><dd>{tune.loopFrame > 0 || tune.source === 'ym' ? `from frame ${tune.loopFrame}` : 'none detected (plays once)'}</dd>
                  {tune.info && <><dt>Timer</dt><dd>{tune.info.timer === 'vbl' ? 'VBL' : 'Timer ' + tune.info.timer} · {tune.info.rateHz} Hz{tune.info.rateHz !== 50 ? ' (resampled to 50 Hz)' : ''}</dd></>}
                </dl>
                {tune.info && tune.info.subtunes > 1 && (
                  <label className="row"><span className="lbl">Subtune</span>
                    <select value={subtune} onChange={(e) => { const v = +e.target.value; setSubtune(v); rerunSndh(v, secOverride); }}>
                      {Array.from({ length: tune.info.subtunes }, (_, i) => (
                        <option key={i} value={i + 1}>{i + 1}{tune.info!.subtuneNames[i] ? ' — ' + tune.info!.subtuneNames[i] : ''}</option>
                      ))}
                    </select>
                  </label>
                )}
                {tune.info && (
                  <label className="row" title="0 = use the length from the file's TIME tag">
                    <span className="lbl">Seconds</span>
                    <input type="number" className="txt" min={0} max={1200} value={secOverride}
                      onChange={(e) => setSecOverride(Math.max(0, Math.min(1200, +e.target.value || 0)))}
                      onBlur={() => rerunSndh(subtune, secOverride)}
                      onKeyDown={(e) => { if (e.key === 'Enter') rerunSndh(subtune, secOverride); }} />
                  </label>
                )}
                <label className="row"><span className="lbl">Composer</span>
                  <input type="text" className="txt" value={author} maxLength={40} onChange={(e) => setAuthor(e.target.value)} />
                </label>
                {tune.warnings.length > 0 && <pre className="log">{tune.warnings.map((w) => 'warning: ' + w).join('\n')}</pre>}
              </section>
            )}
            {mod && <section className="panel">
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
            </section>}

            {mod && <section className="panel">
              <h2>Conversion</h2>
              <Slider label="Level" value={opts.gainDb} min={-12} max={12} step={0.5} unit=" dB" onChange={(v) => setOpts({ ...opts, gainDb: v })}
                hint="Overall loudness mapped onto the 16 YM volume steps" />
              <Slider label="Drum priority" value={opts.drumBonus} min={0} max={6} step={0.5} onChange={(v) => setOpts({ ...opts, drumBonus: v })}
                hint="How strongly kicks/snares/hats win a voice against melody notes" />
              <Slider label="Voice stickiness" value={opts.sticky} min={0} max={4} step={0.25} onChange={(v) => setOpts({ ...opts, sticky: v })}
                hint="Higher = a note stays on the same YM voice (less jumping, fewer clicks)" />
              <label className="chk" title="Match the sample's waveform: sawtooth, triangle and sine-like tones become the YM's hardware-envelope buzzer (one voice at a time, bass range, loud notes) instead of a square wave. Square and complex samples stay square tones. Each instrument can be set by hand in the table.">
                <input type="checkbox" checked={opts.waveform} onChange={(e) => setOpts({ ...opts, waveform: e.target.checked })} /> Sample waveform → buzzer (saw / triangle)
              </label>
              <label className="chk" title="How AY composers lay out the three voices: bass and the synthetic drums on the middle voice (B), melody and arpeggios on A and C, so the voices sit in different frequency ranges. Digidrums stay on voice C.">
                <input type="checkbox" checked={opts.middle} onChange={(e) => setOpts({ ...opts, middle: e.target.checked })} /> Bass + drums on the middle voice
              </label>
              <label className="row" title="Order in which an arpeggio cycles its notes">
                <span className="lbl">Arpeggio</span>
                <select value={opts.arpOrder} onChange={(e) => setOpts({ ...opts, arpOrder: e.target.value as 'xy' | 'yx' })}>
                  <option value="xy">0 → x → y (FT2 / PT)</option>
                  <option value="yx">0 → y → x</option>
                </select>
              </label>
              <label className="row" title="Notes that would be dropped (more channels than YM voices) share a voice and alternate every 20 ms, like a chiptune chord">
                <span className="lbl">Arp fill</span>
                <select value={opts.arpFill} onChange={(e) => setOpts({ ...opts, arpFill: +e.target.value })}>
                  <option value={0}>off — drop the extra notes</option>
                  <option value={2}>fold into 2-note arpeggios</option>
                  <option value={3}>fold into 3-note arpeggios</option>
                </select>
              </label>
              {opts.arpFill > 1 && <Slider label="Min. volume" value={opts.arpMinVol} min={1} max={12} step={1} onChange={(v) => setOpts({ ...opts, arpMinVol: v })}
                hint="Dropped notes quieter than this AY volume are not worth an arpeggio slot" />}
              <label className="chk" title="Percussion samples (not the tonal ones) are played as real 4-bit samples through a voice's volume register, driven by an MFP timer interrupt. They take voice C while they play.">
                <input type="checkbox" checked={opts.digi} onChange={(e) => setOpts({ ...opts, digi: e.target.checked })} /> Percussion as digidrums
              </label>
              {opts.digi && <>
                <label className="row" title="Sample rate of the digidrums; the ST can only make some rates, the nearest one is used. Higher = clearer but costs more CPU and memory.">
                  <span className="lbl">Drum rate</span>
                  <select value={opts.digiRate} onChange={(e) => setOpts({ ...opts, digiRate: +e.target.value })}>
                    {[4000, 6000, 8000, 10000, 12000, 16000].map((r) => <option key={r} value={r}>{r / 1000} kHz</option>)}
                  </select>
                </label>
                <Slider label="Drum length" value={opts.digiMaxMs} min={50} max={1500} step={50} unit=" ms" onChange={(v) => setOpts({ ...opts, digiMaxMs: v })}
                  hint="Longest digidrum; longer samples are cut (with a short fade)" />
              </>}
              <button className="btn small" onClick={() => { setOpts(DEFAULT_OPTS); setPrio({}); setInstMap({}); setMacroSel(null); }}>Reset to auto</button>
              <button className="btn small" onClick={saveMapping} title="Save the instrument mapping, channel priorities and these options as a .json file">Save mapping</button>
              <label className="btn small" title="Load a mapping saved earlier (for this module or a similar one)">Load mapping…<input type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadMapping(f); e.target.value = ''; }} /></label>
              <button className="btn small primary" disabled={!!busy} onClick={toPatterns} title="Turn the module into an editable pattern song for one YM2149 (uses the options above)">Edit as AY patterns →</button>
            </section>}

            <section className="panel">
              <h2>Export</h2>
              <div className="btns">
                <button className="btn primary" disabled={!out} onClick={exp.sndh} title="Playable in any SNDH player (68000 player included, 50 Hz)">SNDH (.sndh)</button>
                <button className="btn" disabled={!out} onClick={exp.ym} title="YM5! register dump — ST-Sound, Atari players">YM (.ym)</button>
                <button className="btn" disabled={!out} onClick={exp.game} title="C header with the packed stream + ymplay.h replayer">Game kit (.zip)</button>
                <button className="btn" disabled={!out} onClick={exp.wav}>Preview (.wav)</button>
                <button className="btn" disabled={!out} onClick={exp.regs}>Raw regs (.regs)</button>
                <button className="btn" disabled={!out} onClick={exp.log}>Report (.txt)</button>
              </div>
              {packed && out && (
                <p className="note">Packed stream: <b>{packed.data.length.toLocaleString()}</b> bytes ({(packed.data.length / (out.nframes / 50)).toFixed(0)} B/s). SNDH adds a {PLAYER_BLOB.length}-byte player{hasDrums(out.drums) || hasFx(out.fx) ? ' (with the digidrum / timer-effect engine)' : ''}.</p>
              )}
              <p className="note soft">Arkos Tracker and maxYMiser export: in the AY pattern editor ("Edit as AY patterns").</p>
            </section>
          </div>

          <section className="panel">
            <h2>Preview <small>space = play/stop · tab = original ⇄ YM</small></h2>
            <div className="transport">
              <button className="btn" onClick={rewind} disabled={!out}>⏮</button>
              <button className="btn primary" onClick={togglePlay} disabled={!out || !!busy}>{playing ? '■ Stop' : '▶ Play'}</button>
              <div className="ab" role="group" aria-label="Source">
                <button className={source === 'orig' ? 'on' : ''} disabled={!origOk || !mod} onClick={() => pickSource('orig')}
                  title={!mod ? 'Only for loaded modules' : origOk ? '' : 'Needs the page to be served over http(s) — not available when index.html is opened from disk'}>A · Original</button>
                <button className={source === 'ay' ? 'on' : ''} onClick={() => pickSource('ay')}>B · YM2149</button>
              </div>
              <span className="time">{fmtTime(pos)} / {fmtTime(seconds)}</span>
              {busy && <span className="busy">{busy}</span>}
              {mod && !origOk && <span className="note">Original-module playback needs http(s) hosting (browsers block it for files opened from disk).</span>}
            </div>
            {out && <AyRoll regs={out.regs} nframes={out.nframes} position={pos} dropped={mod ? res?.dropPerFrame : undefined} arp={mod && opts.arpFill > 1 ? res?.arpPerFrame : undefined} />}
            <div className="legend"><i style={{ background: '#ff5555' }} />voice A <i style={{ background: '#55dd55' }} />voice B <i style={{ background: '#5599ff' }} />voice C <i style={{ background: '#ffaa33' }} />noise · vertical = pitch, brightness = volume{mod && <> · bottom strip: <i style={{ background: '#ff4466' }} />notes dropped <i style={{ background: '#44ddee' }} />notes in an arpeggio</>}</div>
          </section>

          {mod && <div className="grid2">
            <section className="panel">
              <h2>Instruments → AY role</h2>
              <table>
                <thead><tr><th>#</th><th>Name</th><th>Detected</th><th>C-4</th><th>Wave</th><th>AY role</th><th title="semitones">Tr.</th></tr></thead>
                <tbody>
                  {instRows.map((r) => {
                    const cur = instMap[r.inst];
                    const mode: InstMode = cur?.mode ?? 'auto';
                    return (
                      <tr key={r.inst} className={macroSel === r.inst ? 'sel' : ''}>
                        <td>{r.inst.toString(16).toUpperCase().padStart(2, '0')}</td>
                        <td className="name">{r.name || '—'}</td>
                        <td>{r.cls}</td>
                        <td>{r.c4Hz ? `${r.c4Hz.toFixed(0)} Hz` : ''}</td>
                        <td>
                          {r.cls === 'tonal' && mode !== 'macro' && mode !== 'mute' && mode !== 'digi' && mode !== 'kick' && mode !== 'snare' && mode !== 'hat' ? (
                            <select value={cur?.wave ?? ''} title="Waveform of the sample's cycle. A sawtooth / triangle / sine-like tone can be played as the YM's hardware-envelope buzzer (one voice at a time, loud notes in the bass/low range only)."
                              onChange={(e) => patchInst(r.inst, { wave: (e.target.value || undefined) as InstMap['wave'] })}>
                              <option value="">{`auto: ${opts.waveform ? waveName(r.wave, true) : 'square'} (${r.wave ?? '?'})`}</option>
                              <option value="tone">square tone</option>
                              <option value="saw">saw buzzer ↘</option>
                              <option value="sawup">saw buzzer ↗</option>
                              <option value="smooth">triangle buzzer</option>
                            </select>
                          ) : ''}
                        </td>
                        <td>
                          <select value={mode} onChange={(e) => setMode(r.inst, e.target.value as InstMode)}>
                            <option value="auto">{r.digi ? 'auto: digidrum' : r.drum ? `auto: ${r.drum}` : 'auto: tone'}</option>
                            <option value="tone">tone (written note)</option>
                            <option value="kick">kick</option><option value="snare">snare</option><option value="hat">hat</option>
                            <option value="digi">digidrum (sample)</option>
                            <option value="macro">custom macro…</option>
                            <option value="mute">mute</option>
                          </select>
                          {mode === 'macro' && <button className="btn tiny" onClick={() => setMacroSel(macroSel === r.inst ? null : r.inst)}>edit</button>}
                        </td>
                        <td>
                          <input type="number" className="txt num" min={-48} max={48} value={cur?.transpose ?? 0} disabled={mode === 'kick' || mode === 'snare' || mode === 'hat' || mode === 'mute'}
                            onChange={(e) => patchInst(r.inst, { transpose: Math.max(-48, Math.min(48, +e.target.value || 0)) })} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="note soft">Auto picks tone (pitch measured from the sample) or a drum macro. <b>tone</b> forces the written note's pitch with the sample's own volume curve; <b>custom macro</b> plays a per-tick sequence you edit below; <b>mute</b> leaves the instrument out.</p>
            </section>

            <section className="panel">
              <h2>Source channels → 3 voices</h2>
              <table>
                <thead><tr><th>Ch</th><th>Played</th>{opts.arpFill > 1 && <th>In arp</th>}<th>Dropped</th><th>Priority</th></tr></thead>
                <tbody>
                  {res && res.played.map((pl, ch) => {
                    const dr = res.dropped[ch], fo = res.folded[ch], tot = pl + dr + fo;
                    return (
                      <tr key={ch}>
                        <td>{ch + 1}</td>
                        <td>{tot ? Math.round((pl / tot) * 100) : 0}%</td>
                        {opts.arpFill > 1 && <td>{tot ? Math.round((fo / tot) * 100) : 0}%</td>}
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
          </div>}

          {mod && macroSel !== null && instMap[macroSel]?.macro && (() => {
            const i = macroSel, mac = instMap[i].macro!;
            const setStep = (k: number, patch: Partial<MacroStep>) => editMacro(i, (m) => { m.steps[k] = { ...m.steps[k], ...patch }; return m; });
            return (
              <section className="panel">
                <h2>Macro editor — instrument {i.toString(16).toUpperCase().padStart(2, '0')} {instRows.find((r) => r.inst === i)?.name} <small>one step = 20 ms</small></h2>
                <div className="macrobar">
                  <label>Preset <select value="" onChange={(e) => e.target.value && patchInst(i, { macro: cloneMacro(MACRO_PRESETS[e.target.value]) })}>
                    <option value="">load…</option>
                    {Object.keys(MACRO_PRESETS).map((k) => <option key={k}>{k}</option>)}
                  </select></label>
                  <label title="Step to jump back to after the last step; −1 = play once, then silent">Loop from <input type="number" className="txt num" min={-1} max={mac.steps.length - 1} value={mac.loopFrom}
                    onChange={(e) => editMacro(i, (m) => { m.loopFrom = Math.max(-1, Math.min(m.steps.length - 1, Math.trunc(+e.target.value))); return m; })} /></label>
                  <label title="Scale by the note volume of the source module"><input type="checkbox" checked={mac.velocity} onChange={(e) => editMacro(i, (m) => { m.velocity = e.target.checked; return m; })} /> follow note volume</label>
                  <button className="btn small" onClick={() => editMacro(i, (m) => { m.steps.push({ ...m.steps[m.steps.length - 1] ?? { vol: 15, semi: 0, noise: 0, tone: true } }); return m; })}>+ step</button>
                  <button className="btn small" disabled={mac.steps.length <= 1} onClick={() => editMacro(i, (m) => { m.steps.pop(); m.loopFrom = Math.min(m.loopFrom, m.steps.length - 1); return m; })}>− step</button>
                </div>
                <div className="macrogrid">
                  <table>
                    <thead><tr><th>Step</th><th>Vol 0-15</th><th>Pitch (semitones)</th><th>Noise 0-31</th><th>Tone</th></tr></thead>
                    <tbody>
                      {mac.steps.map((stp, k) => (
                        <tr key={k} className={mac.loopFrom === k ? 'loopmark' : ''}>
                          <td>{k}{mac.loopFrom === k ? ' ↺' : ''}</td>
                          <td><input type="number" className="txt num" min={0} max={15} value={stp.vol} onChange={(e) => setStep(k, { vol: Math.max(0, Math.min(15, Math.trunc(+e.target.value || 0))) })} /></td>
                          <td><input type="number" className="txt num" min={-48} max={48} step={0.05} value={stp.semi} onChange={(e) => setStep(k, { semi: Math.max(-48, Math.min(48, +e.target.value || 0)) })} /></td>
                          <td><input type="number" className="txt num" min={0} max={31} value={stp.noise} onChange={(e) => setStep(k, { noise: Math.max(0, Math.min(31, Math.trunc(+e.target.value || 0))) })} /></td>
                          <td><input type="checkbox" checked={stp.tone} onChange={(e) => setStep(k, { tone: e.target.checked })} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })()}

          {mod && <section className="panel">
            <h2>Conversion report</h2>
            <pre className="log">{res ? [...res.report, ...res.warnings.map((w) => 'warning: ' + w)].join('\n') : ''}</pre>
          </section>}
        </>
      )}
      </>}
      <footer>Runs entirely in your browser — files never leave your computer.</footer>
    </div>
  );
}
