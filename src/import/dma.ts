/**
 * STe DMA sound -> digidrums.
 *
 * An STe tune can play 8-bit samples through the DMA sound chip next to the YM2149 (maxYMiser's "DMA track" does).
 * The YM has no such channel, so a 50 Hz register dump cannot carry them. What can be kept is the *timing*: the
 * emulator logs every start of a DMA sample (frame base, end, rate), this module reads the sample bytes and turns
 * each distinct sample into a 4-bit digidrum that is hit at the same frames, on voice C (the pattern editor's drum voice).
 * The voice is silenced while the sample plays (as for any digidrum), so a sampled hit costs the tune that voice.
 */
import { prepareDrum, drumFrames, trigCode, TRIG_STOP, MAX_DRUMS, MAX_DRUM_BYTES, silenceDrumVoices, type DrumTrack, type DrumSample } from '../core/drums';
import type { DmaEvent } from './sndh';

export const DMA_RATES = [6258, 12517, 25033, 50066] as const;
const MIN_SAMPLE_BYTES = 16;
const MAX_SAMPLE_BYTES = 1 << 20;

export interface DmaResult {
  /** the tune's own drums plus the DMA ones (same object shape as a YM6 drum track); undefined when nothing was added */
  track?: DrumTrack;
  /** distinct samples / hits that became digidrum hits, hits that could not (no free drum slot, a timer drum at the same frame) */
  samples: number; hits: number; dropped: number;
  voice: number;
  /** index of the first DMA drum in the track */
  first: number;
  warnings: string[];
}

interface Hit { frame: number; key: string; start: number; end: number; mode: number }

export function dmaToDrums(events: DmaEvent[], mem: Uint8Array, regs: Uint8Array, nframes: number, existing?: DrumTrack): DmaResult {
  const warnings: string[] = [];
  const hits: Hit[] = [];
  const stops: number[] = [];
  for (const e of events) {
    if (e.frame >= nframes) continue;
    if (!e.play) { stops.push(e.frame); continue; }
    const len = e.end - e.start;
    if (len < MIN_SAMPLE_BYTES || len > MAX_SAMPLE_BYTES || e.start < 0x400 || e.end > mem.length) continue;
    const last = hits[hits.length - 1];
    const h = { frame: e.frame, key: `${e.start}:${e.end}:${e.mode & 0x83}`, start: e.start, end: e.end, mode: e.mode };
    if (last && last.frame === e.frame) hits[hits.length - 1] = h; else hits.push(h);
  }
  const none: DmaResult = { samples: 0, hits: 0, dropped: 0, voice: 2, first: existing?.drums.length ?? 0, warnings };
  if (!hits.length) return none;

  const base = existing?.drums ?? [];
  const drums: DrumSample[] = base.slice();
  const trig = existing ? existing.trig.slice(0, nframes) : new Uint8Array(nframes);
  const slot = new Map<string, number>();
  const placed: { frame: number; idx: number }[] = [];
  let dropped = 0;
  for (const h of hits) {
    if (trig[h.frame]) { dropped++; continue; }              // a timer digidrum already owns this frame
    let idx = slot.get(h.key);
    if (idx === undefined) {
      if (drums.length >= MAX_DRUMS) { dropped++; continue; }
      const stereo = !(h.mode & 0x80);
      const srcRate = DMA_RATES[h.mode & 3];
      const n = h.end - h.start;
      const m = stereo ? n >> 1 : n;
      const x = new Float32Array(m);
      for (let i = 0; i < m; i++) {
        const a = (mem[h.start + (stereo ? 2 * i : i)] << 24) >> 24;
        x[i] = (stereo ? (a + ((mem[h.start + 2 * i + 1] << 24) >> 24)) / 2 : a) / 128;
      }
      const dur = m / srcRate;
      const rateHz = Math.max(3000, Math.min(srcRate, 12500, (MAX_DRUM_BYTES * 0.98) / dur));
      const dr = prepareDrum(`STe sample ${drums.length - base.length + 1}`, x, srcRate, { rateHz, normalize: true, fadeOut: true });
      // the same sound loaded at two addresses (or with a different tail) is one drum
      const same = drums.findIndex((o, k) => k >= base.length && o.rateHz === dr.rateHz && o.pcm.length === dr.pcm.length && o.pcm.every((v, i) => v === dr.pcm[i]));
      if (same >= 0) idx = same; else { drums.push(dr); idx = drums.length - 1; }
      slot.set(h.key, idx);
    }
    placed.push({ frame: h.frame, idx });
  }
  if (!placed.length) { none.dropped = dropped; warnings.push(`STe DMA sound: ${dropped} sample hit(s) could not be kept (no free digidrum slot, or a timer digidrum at the same frame)`); return none; }

  // voice C, like the drum channel of the pattern editor: every sample hit then lands where the editor plays it
  const voice = 2;
  for (const p of placed) trig[p.frame] = trigCode(voice, p.idx);
  for (const f of stops) {
    // a stop only matters while a sample of ours is still running
    const prev = [...placed].reverse().find((p) => p.frame < f);
    if (prev && f < prev.frame + drumFrames(drums[prev.idx]) && !trig[f]) trig[f] = trigCode(voice, TRIG_STOP);
  }
  const track: DrumTrack = { drums, trig };
  // the sample owns the voice while it plays
  const own: DrumTrack = { drums, trig: new Uint8Array(nframes) };
  placed.forEach((p) => { own.trig[p.frame] = trig[p.frame]; });
  for (const f of stops) if (trig[f] && !own.trig[f]) own.trig[f] = trig[f];
  silenceDrumVoices(regs, nframes, own);

  return { track, samples: drums.length - base.length, hits: placed.length, dropped, voice, first: base.length, warnings };
}

/** the report line, after the tune has been cut to its loop: counts only what is still in the dump */
export function dmaReport(r: DmaResult, track: DrumTrack, nframes: number): string {
  let hits = 0;
  const used = new Set<number>();
  for (let f = 0; f < nframes; f++) {
    const t = track.trig[f] ?? 0, idx = t & 63;
    if (t && idx !== TRIG_STOP && idx >= r.first) { hits++; used.add(idx); }
  }
  return `STe DMA sound: ${used.size} sample${used.size === 1 ? '' : 's'}, ${hits} hit${hits === 1 ? '' : 's'} turned into 4-bit digidrums on voice ${'ABC'[r.voice]} ` +
    `(the YM2149 has no DMA channel: that voice is silent while a sample plays)` + (r.dropped ? `; ${r.dropped} hit(s) dropped (no free digidrum slot, or a timer digidrum at the same frame)` : '');
}
