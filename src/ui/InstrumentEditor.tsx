import { useEffect, useRef, useState } from 'react';
import type { Editor } from '../tracker/editor';
import type { Instrument, StepSeq } from '../tracker/types';
import type { MacroStep } from '../core/convert';
import { MACRO_PRESETS } from '../core/macros';
import { NumField, TextField } from './fields';

const SHAPES: [number, string][] = [
  [8, '8  \\\\\\\\  saw down'], [10, '10 \\/\\/  triangle (down first)'], [12, '12 ////  saw up'], [14, '14 /\\/\\  triangle (up first)'],
  [9, '9  \\___  one decay'], [13, '13 /¯¯¯  one attack, hold'], [11, '11 \\¯¯¯  decay, then high'], [15, '15 /___  attack, then silent'],
  [0, '0  \\___  (same as 9)'], [4, '4  /___  (same as 15)'],
];

const listToText = (a: number[]) => a.join(' ');
const parseList = (s: string, lo: number, hi: number): number[] =>
  s.split(/[\s,;]+/).filter(Boolean).map(Number).filter(Number.isFinite).map((n) => Math.max(lo, Math.min(hi, Math.round(n)))).slice(0, 256);

function ListField({ value, onCommit, lo, hi, title }: { value: number[]; onCommit: (v: number[]) => void; lo: number; hi: number; title?: string }) {
  return <TextField className="txt wide" value={listToText(value)} title={title} onCommit={(s) => onCommit(parseList(s, lo, hi))} />;
}

function Check({ label, value, onChange, title }: { label: string; value: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <label className="chk" title={title}><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} /> {label}</label>;
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <div className="ie-row" title={hint}><span className="lbl">{label}</span><span className="ctl">{children}</span></div>;
}

/** bar chart of the step volumes; click / drag to paint them */
function StepBars({ steps, onPaint, loopFrom }: { steps: MacroStep[]; onPaint: (s: MacroStep[], commit: boolean) => void; loopFrom: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<MacroStep[] | null>(null);
  const paint = (e: React.PointerEvent, commit: boolean) => {
    const el = ref.current; if (!el || !drag.current) return;
    const rect = el.getBoundingClientRect();
    const i = Math.floor(((e.clientX - rect.left) / rect.width) * drag.current.length);
    if (i >= 0 && i < drag.current.length) {
      const vol = Math.max(0, Math.min(15, Math.round((1 - (e.clientY - rect.top) / rect.height) * 15)));
      if (drag.current[i].vol !== vol) { drag.current = drag.current.map((s, k) => (k === i ? { ...s, vol } : s)); onPaint(drag.current, false); }
    }
    if (commit) { onPaint(drag.current, true); drag.current = null; }
  };
  return (
    <div className="stepbars" ref={ref} title="click or drag to draw the volume of each step"
      onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); drag.current = steps.map((s) => ({ ...s })); paint(e, false); }}
      onPointerMove={(e) => { if (e.buttons === 1) paint(e, false); }}
      onPointerUp={(e) => paint(e, true)}>
      {steps.map((s, i) => (
        <i key={i} className={i === loopFrom ? 'loop' : ''} style={{ height: `${(s.vol / 15) * 100}%`, opacity: s.tone || !s.noise ? 1 : 0.55, background: s.noise ? (s.tone ? '#ffb347' : '#ff8a3d') : undefined }} />
      ))}
    </div>
  );
}

function StepTable({ ed, idx, seq }: { ed: Editor; idx: number; seq: StepSeq }) {
  const [draft, setDraft] = useState<MacroStep[] | null>(null);
  const steps = draft ?? seq.steps;
  const set = (patch: Partial<StepSeq>) => ed.updateInstrument({ seq: { ...seq, ...patch } }, idx);
  const setStep = (i: number, p: Partial<MacroStep>) => set({ steps: seq.steps.map((s, k) => (k === i ? { ...s, ...p } : s)) });
  const insert = (i: number) => {
    const copy = { ...(seq.steps[i] ?? { vol: 15, semi: 0, noise: 0, tone: true }) };
    set({ steps: [...seq.steps.slice(0, i + 1), copy, ...seq.steps.slice(i + 1)].slice(0, 255) });
  };
  const remove = (i: number) => {
    if (seq.steps.length <= 1) return;
    const lf = seq.loopFrom > i ? seq.loopFrom - 1 : seq.loopFrom;
    set({ steps: seq.steps.filter((_, k) => k !== i), loopFrom: Math.min(lf, seq.steps.length - 2) });
  };
  return (
    <div>
      <div className="macrobar">
        <label>Preset <select value="" onChange={(e) => {
          const p = MACRO_PRESETS[e.target.value]; if (!p) return;
          ed.updateInstrument({ seq: { steps: p.steps.map((s) => ({ ...s })), loopFrom: p.loopFrom, velocity: p.velocity, release: seq.release } }, idx);
        }}>
          <option value="">choose…</option>
          {Object.keys(MACRO_PRESETS).map((k) => <option key={k}>{k}</option>)}
        </select></label>
        <label title="Step the sound jumps back to after the last one. -1 = play once, then silent.">Loop from step <NumField value={seq.loopFrom} min={-1} max={Math.max(0, seq.steps.length - 1)} onCommit={(v) => set({ loopFrom: v })} /></label>
        <label title="Ticks of fade-out after a key-off (0 = cut at once)">Release <NumField value={seq.release} min={0} max={255} onCommit={(v) => set({ release: v })} /></label>
        <Check label="Follow note volume" value={seq.velocity} onChange={(v) => set({ velocity: v })} title="Scale the steps by the note's volume column (3 dB per AY step)" />
      </div>
      <StepBars steps={steps} loopFrom={seq.loopFrom} onPaint={(s, commit) => { if (commit) { setDraft(null); set({ steps: s }); } else setDraft(s); }} />
      <div className="macrogrid">
        <table>
          <thead><tr><th>#</th><th title="AY volume 0-15">Vol</th><th title="Pitch offset in semitones (decimals allowed)">Semitones</th><th title="Noise period 1-31, 0 = no noise">Noise</th><th>Tone</th><th></th></tr></thead>
          <tbody>
            {seq.steps.map((s, i) => (
              <tr key={i} className={i === seq.loopFrom ? 'loopmark' : ''}>
                <td>{i}{i === seq.loopFrom ? ' ↻' : ''}</td>
                <td><NumField value={s.vol} min={0} max={15} onCommit={(v) => setStep(i, { vol: v })} /></td>
                <td><SemiField value={s.semi} onCommit={(v) => setStep(i, { semi: v })} /></td>
                <td><NumField value={s.noise} min={0} max={31} onCommit={(v) => setStep(i, { noise: v })} /></td>
                <td><input type="checkbox" checked={s.tone} aria-label={`tone on, step ${i}`} onChange={(e) => setStep(i, { tone: e.target.checked })} /></td>
                <td><button className="btn tiny" title="Duplicate this step" onClick={() => insert(i)}>+</button><button className="btn tiny" title="Remove this step" onClick={() => remove(i)}>−</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SemiField({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const done = () => {
    const n = Math.round(Math.max(-48, Math.min(48, Number(v.replace(',', '.')))) * 100) / 100;
    if (!Number.isFinite(n)) { setV(String(value)); return; }
    setV(String(n)); if (n !== value) onCommit(n);
  };
  return <input type="text" className="txt num" value={v} onChange={(e) => setV(e.target.value)} onBlur={done}
    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { done(); (e.target as HTMLInputElement).blur(); } }} />;
}

export function InstrumentEditor({ ed, idx, onClose }: { ed: Editor; idx: number; onClose: () => void }) {
  const inst = ed.song.instruments[idx];
  if (!inst) return null;
  const up = (p: Partial<Instrument>) => ed.updateInstrument(p, idx);
  const seq = inst.seq;
  const test = (down: boolean) => { if (down) ed.jam(37 + 12); else ed.releaseJam(37 + 12); };

  return (
    <section className="panel ie">
      <h2>Instrument {idx.toString(16).toUpperCase().padStart(2, '0')}
        <small>edits are undoable · hold the Test button or press any note key to hear it</small>
        <button className="btn tiny right" onClick={onClose}>close</button></h2>
      <div className="ie-cols">
        <div>
          <Field label="Name"><TextField value={inst.name} maxLength={22} onCommit={(v) => up({ name: v })} /></Field>
          <Field label="Test"><button className="btn" onPointerDown={() => test(true)} onPointerUp={() => test(false)} onPointerLeave={() => test(false)}>Play C-5 (hold)</button></Field>
          <Field label="Sound type" hint="A step table lets you draw the volume, pitch, noise and tone for every 50 Hz tick. The classic type is the YM Tracker's own ADSR / envelope instrument.">
            <label className="chk"><input type="radio" name={`kind${idx}`} checked={!seq} onChange={() => up({ seq: undefined })} /> classic (ADSR / envelope)</label>
            <label className="chk"><input type="radio" name={`kind${idx}`} checked={!!seq} onChange={() => up({ seq: seq ?? { steps: MACRO_PRESETS['Pluck'].steps.map((s) => ({ ...s })), loopFrom: -1, velocity: true, release: 3 } })} /> step table</label>
          </Field>
          {!seq && (<>
            <Field label="Tone"><Check label="square wave on" value={inst.toneEnabled} onChange={(v) => up({ toneEnabled: v })} /></Field>
            <Field label="Noise"><Check label="noise on" value={inst.noiseEnabled} onChange={(v) => up({ noiseEnabled: v })} />
              <NumField value={inst.noisePeriod} min={0} max={31} title="noise period 0-31 (low = bright)" onCommit={(v) => up({ noisePeriod: v })} /></Field>
            <Field label="Volume"><Check label="ADSR" value={inst.adsr.useAdsr} onChange={(v) => up({ adsr: { ...inst.adsr, useAdsr: v } })} /></Field>
            {inst.adsr.useAdsr ? (
              <Field label="A D S R" hint="Attack, decay and release are in ticks (1 tick = 20 ms at the default tempo); sustain is the AY level 0-15.">
                <NumField value={inst.adsr.attack} min={0} max={255} onCommit={(v) => up({ adsr: { ...inst.adsr, attack: v } })} />
                <NumField value={inst.adsr.decay} min={0} max={255} onCommit={(v) => up({ adsr: { ...inst.adsr, decay: v } })} />
                <NumField value={inst.adsr.sustain} min={0} max={15} onCommit={(v) => up({ adsr: { ...inst.adsr, sustain: v } })} />
                <NumField value={inst.adsr.release} min={0} max={255} onCommit={(v) => up({ adsr: { ...inst.adsr, release: v } })} />
              </Field>
            ) : (<>
              <Field label="Volume table" hint="AY levels 0-15, one per tick; the last one is held"><ListField value={inst.volEnv} lo={0} hi={15} onCommit={(v) => up({ volEnv: v })} /></Field>
              <Field label="After key-off"><ListField value={inst.volRelease} lo={0} hi={15} onCommit={(v) => up({ volRelease: v })} /></Field>
            </>)}
          </>)}
          {seq && <p className="note soft">The step table sets volume, pitch offset, noise and tone for every tick. The arpeggio / pitch tables, vibrato and hardware envelope settings still apply.</p>}
        </div>
        <div>
          <Field label="Arpeggio" hint="Semitone offsets stepped through while the note plays, e.g. 0 4 7">
            <ListField value={inst.arpMacro} lo={-48} hi={48} onCommit={(v) => up({ arpMacro: v.length ? v : [0] })} />
          </Field>
          <Field label="Arp speed" hint="Ticks per arpeggio step"><NumField value={inst.arpSpeed} min={1} max={31} onCommit={(v) => up({ arpSpeed: v })} /></Field>
          <Field label="Pitch table" hint="Period offsets added per tick (positive = lower pitch)"><ListField value={inst.pitchMacro} lo={-2048} hi={2048} onCommit={(v) => up({ pitchMacro: v.length ? v : [0] })} /></Field>
          <Field label="Vibrato" hint="Speed and depth applied to every note of this instrument (0 depth = off)">
            speed <NumField value={inst.vibratoSpeed} min={0} max={15} onCommit={(v) => up({ vibratoSpeed: v })} />
            depth <NumField value={inst.vibratoDepth} min={0} max={15} onCommit={(v) => up({ vibratoDepth: v })} />
          </Field>
          <Field label="Hard envelope" hint="The YM2149's own envelope generator: buzzy bass and synth sounds. One envelope is shared by all three voices.">
            <Check label="use" value={inst.useHardEnv} onChange={(v) => up({ useHardEnv: v })} />
            <Check label="also play the tone (sync buzz)" value={inst.syncBuzz} onChange={(v) => up({ syncBuzz: v })} />
          </Field>
          {inst.useHardEnv && (<>
            <Field label="Shape"><select value={inst.hardEnvShape} onChange={(e) => up({ hardEnvShape: +e.target.value })}>
              {SHAPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></Field>
            <Field label="Env. period"><Check label="follow the note" value={inst.hardEnvAutoPeriod} onChange={(v) => up({ hardEnvAutoPeriod: v })} />
              {inst.hardEnvAutoPeriod
                ? <>÷ <NumField value={inst.hardEnvDivisor} min={1} max={64} title="envelope period = tone period ÷ this" onCommit={(v) => up({ hardEnvDivisor: v })} /></>
                : <NumField value={inst.hardEnvPeriod} min={1} max={65535} onCommit={(v) => up({ hardEnvPeriod: v })} />}
            </Field>
          </>)}
        </div>
      </div>
      {seq && <StepTable ed={ed} idx={idx} seq={seq} />}
    </section>
  );
}
