/**
 * Module percussion -> digidrum samples.  A hit (a fresh note trigger of a sample that is played as a
 * drum) becomes a 4-bit sample at the pitch / start offset / volume class it was played with; identical
 * variants share one table entry.
 */
import type { Module } from './types';
import type { ChanState } from './replay';
import { type DrumSample, MAX_DRUMS, prepareDrum } from './drums';

export interface DigiOptions {
  /** play rate, Hz (nearest MFP rate is used) */
  rateHz?: number;
  /** longest drum, ms */
  maxMs?: number;
}

export class DigiExtractor {
  readonly list: DrumSample[] = [];
  /** hits that found no room (more than MAX_DRUMS variants) */
  skipped = 0;
  readonly rateHz: number;
  readonly maxMs: number;
  private cache = new Map<string, number>();
  constructor(private m: Module, o: DigiOptions = {}) { this.rateHz = o.rateHz ?? 8000; this.maxMs = o.maxMs ?? 500; }

  /**
   * Volume class 0 (loud) .. 2 (quiet, -12 dB); -1 = too quiet to bother.
   * A digidrum cannot change its level per hit, so quieter hits get their own 6 dB quieter variant.
   */
  static volClass(vol: number): number { return vol >= 0.75 ? 0 : vol >= 0.4 ? 1 : vol >= 0.15 ? 2 : -1; }

  hit(st: ChanState): { idx: number; cls: number } | null {
    const cls = DigiExtractor.volClass(st.vol);
    if (cls < 0) return null;
    const start = Math.max(0, Math.floor(st.pos));
    const key = `${st.inst}:${st.ksmp}:${start}:${Math.round(12 * Math.log2(Math.max(1, st.rate)))}:${cls}`;
    let idx = this.cache.get(key);
    if (idx === undefined) {
      if (this.list.length >= MAX_DRUMS) { this.skipped++; return null; }
      const sm = st.smp, maxN = Math.max(8, Math.ceil((this.maxMs / 1000) * st.rate));
      const looped = sm.loop !== 0 && sm.ll > 2;
      const n = looped ? maxN : Math.min(maxN, Math.max(0, sm.data.length - start));
      if (n < 2) return null;
      const au = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let q = start + i;
        if (looped && q >= sm.ls + sm.ll) q = sm.ls + ((q - sm.ls) % sm.ll);
        au[i] = sm.data[q] ?? 0;
      }
      const nm = (this.m.instruments[st.inst]?.name || `inst ${st.inst}`).trim().slice(0, 18) + (cls ? ` -${6 * cls}dB` : '');
      // normalise the loudest class; quieter classes keep their 6 dB steps (4 bits are too coarse to waste headroom)
      const d = prepareDrum(nm, au, st.rate, { rateHz: this.rateHz, normalize: true, gainDb: -6 * cls, maxMs: this.maxMs, fadeOut: true });
      idx = this.list.length; this.list.push(d); this.cache.set(key, idx);
    }
    return { idx, cls };
  }
}
