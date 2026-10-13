import { useEffect, useMemo, useRef, useState } from 'react';
import type { Module } from '../core/types';
import { convert, type ConvertOptions } from '../core/convert';
import { PRIO_OFF } from '../core/replay';
import { channelStats, suggestPriorities, noteLabel, type ChanStat } from '../core/chanstats';
import { renderYm } from '../export/ymemu';
import { Preview, type Source } from './audio';

/** how much a channel's events are favoured when the 3 voices are handed out (added to the note's loudness, 0..15) */
export const LEVELS: { label: string; value: number; hint: string }[] = [
  { label: 'Off', value: PRIO_OFF, hint: 'leave this channel out of the import' },
  { label: 'Low', value: -3, hint: 'gives way to the others when voices run short' },
  { label: 'Normal', value: 0, hint: 'no preference' },
  { label: 'High', value: 3, hint: 'wins over normal channels' },
  { label: 'Lead', value: 8, hint: 'the melody: keeps its voice almost always' },
];

interface Props {
  mod: Module;
  /** the options the full import is converted with (priorities included) */
  convOpts: ConvertOptions;
  prio: Record<number, number>;
  setPrio: (p: Record<number, number>) => void;
  mainPlaying: boolean;
  mainSource: Source;
  hasOrig: boolean;
  playMain: (s: Source) => void;
  stopMain: () => void;
  busy: string;
  onClose: () => void;
  onEdit: () => void;
}

export function ImportDialog(p: Props) {
  const { mod, convOpts, prio, setPrio } = p;
  const [stats, setStats] = useState<ChanStat[] | null>(null);
  const [soloCh, setSoloCh] = useState<number | null>(null);
  const [loading, setLoading] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const solo = useRef<Preview | null>(null);
  const cache = useRef<Map<string, Float32Array>>(new Map());
  const token = useRef(0);

  useEffect(() => {
    const h = setTimeout(() => { try { setStats(channelStats(mod)); } catch (e) { setErr(String((e as Error).message ?? e)); } }, 20);
    return () => clearTimeout(h);
  }, [mod]);
  useEffect(() => () => { token.current++; solo.current?.stop(); p.stopMain(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const stopSolo = () => { token.current++; solo.current?.stop(); setSoloCh(null); setLoading(null); };
  /** the channel alone on the three voices, as it will sound on the YM2149 with the current instrument settings */
  const playSolo = (ch: number) => {
    if (soloCh === ch) { stopSolo(); return; }
    p.stopMain(); stopSolo();
    const my = ++token.current;
    setLoading(ch); setErr('');
    setTimeout(() => {
      try {
        const key = `${ch}|${JSON.stringify({ ...convOpts, prio: undefined })}`;
        let pcm = cache.current.get(key);
        if (!pcm) {
          const r = convert(mod, { ...convOpts, solo: ch });
          pcm = renderYm(r.regs, r.nframes, 44100, 50, 4, r.drums);
          if (cache.current.size >= 2) cache.current.delete(cache.current.keys().next().value!);
          cache.current.set(key, pcm);
        }
        if (my !== token.current) return;
        const pv = (solo.current ??= new Preview());
        pv.setAy(pcm);
        void pv.play(0);
        setSoloCh(ch);
      } catch (e) { setErr(String((e as Error).message ?? e)); }
      if (my === token.current) setLoading(null);
    }, 20);
  };
  const full = (s: Source) => {
    stopSolo();
    if (p.mainPlaying && p.mainSource === s) p.stopMain(); else p.playMain(s);
  };

  const set = (ch: number, v: number) => {
    const next = { ...prio };
    if (v === 0) delete next[ch]; else next[ch] = v;
    setPrio(next);
  };
  const suggest = () => {
    if (stats) setPrio(suggestPriorities(stats, { low: -3, normal: 0, lead: 8 }));
  };
  const off = Object.values(prio).filter((v) => v <= PRIO_OFF).length;

  return (
    <div className="modal" onMouseDown={p.onClose}>
      <div className="panel dlg imp" role="dialog" aria-label="Manual import" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Manual import <small>{mod.title || 'untitled'} · {mod.nch} channels → 3 voices</small></h2>
        <p className="note soft">
          The YM2149 has 3 voices, so the converter keeps the 3 most important notes every 20 ms. Give the channels that matter (the melody) a higher priority, push
          unimportant ones down, or switch them off. <b>▶ Solo</b> plays one channel alone on the chip; <b>▶ Full import</b> plays the result with the priorities below — you can
          keep changing them while it plays.
        </p>
        <div className="imp-bar">
          <button className={`btn${p.mainPlaying && p.mainSource === 'ay' ? ' primary' : ''}`} onClick={() => full('ay')}>{p.mainPlaying && p.mainSource === 'ay' ? '■ Stop' : '▶ Full import (YM2149)'}</button>
          {p.hasOrig && <button className={`btn${p.mainPlaying && p.mainSource === 'orig' ? ' primary' : ''}`} onClick={() => full('orig')} title="the original module, for comparison">{p.mainPlaying && p.mainSource === 'orig' ? '■ Stop' : '▶ Original'}</button>}
          <button className="btn" onClick={suggest} disabled={!stats} title="busiest pitched channel = Lead, nearly silent channels = Low">Suggest</button>
          <button className="btn" onClick={() => setPrio({})} disabled={!Object.keys(prio).length}>Reset</button>
          <span className="imp-st">{p.busy || (off ? `${off} channel${off > 1 ? 's' : ''} off` : '')}</span>
        </div>
        {err && <div className="note warn">{err}</div>}
        <div className="imp-scroll">
          <table className="imp-t">
            <thead><tr><th>Ch</th><th>Activity over the song</th><th>Active</th><th>Notes</th><th>Pitch</th><th>Main instruments</th><th>Priority</th><th>Solo</th></tr></thead>
            <tbody>
              {!stats && <tr><td colSpan={8} className="soft">Analysing the channels…</td></tr>}
              {stats?.map((s) => {
                const v = prio[s.ch] ?? 0;
                const preset = LEVELS.some((l) => l.value === v);
                return (
                  <tr key={s.ch} className={v <= PRIO_OFF ? 'offrow' : ''}>
                    <td>{s.ch + 1}</td>
                    <td><div className="act" aria-hidden>{s.buckets.map((b, i) => <i key={i} style={{ height: `${Math.round(b * 100)}%`, opacity: b ? 1 : 0 }} />)}</div></td>
                    <td>{Math.round(s.activeFrac * 100)}%</td>
                    <td>{s.notes}</td>
                    <td>{s.medianNote !== null ? noteLabel(s.medianNote) : '—'}</td>
                    <td className="insts" title={s.insts.map((i) => i.name).join(', ')}>{s.insts.map((i) => i.name).join(', ') || '—'}</td>
                    <td>
                      <span className="seg" role="radiogroup" aria-label={`Priority of channel ${s.ch + 1}`}>
                        {LEVELS.map((l) => (
                          <button key={l.label} role="radio" aria-checked={v === l.value} className={v === l.value ? 'on' : ''} title={l.hint} onClick={() => set(s.ch, l.value)}>{l.label}</button>
                        ))}
                      </span>
                      {!preset && <small className="soft"> custom {v > 0 ? '+' : ''}{v}</small>}
                    </td>
                    <td>
                      <button className={`btn tiny${soloCh === s.ch ? ' primary' : ''}`} disabled={!s.activeFrac || (loading !== null && loading !== s.ch)} onClick={() => playSolo(s.ch)}>
                        {loading === s.ch ? '…' : soloCh === s.ch ? '■' : '▶'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="imp-bar">
          <button className="btn" onClick={p.onEdit} title="convert with these priorities into the editable AY pattern view">Edit as AY patterns →</button>
          <button className="btn primary" onClick={p.onClose} title="the priorities stay applied to the exports on the Converter tab">Done</button>
        </div>
      </div>
    </div>
  );
}
