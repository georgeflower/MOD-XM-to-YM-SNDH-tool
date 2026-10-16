import { describe, it, expect } from 'vitest';
import { audioToTune, decodeAudio, isAudioFile } from '../src/import/audio';
import { regsToSong } from '../src/tracker/fromRegs';

const SR = 44100;
const mid = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
function tone(buf: Float32Array, f: number, t0: number, t1: number, amp: number, harm = 6) {
  const a = Math.floor(t0 * SR), b = Math.min(buf.length, Math.floor(t1 * SR));
  for (let i = a; i < b; i++) {
    const t = i / SR, env = Math.min(1, (i - a) / 200) * Math.min(1, (b - i) / 400);
    let s = 0; for (let h = 1; h <= harm; h++) s += Math.sin(2 * Math.PI * f * h * t) / h;
    buf[i] += amp * env * s;
  }
}
function noiseBurst(buf: Float32Array, t0: number, t1: number, amp: number) {
  let seed = 12345; const r = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  const a = Math.floor(t0 * SR), b = Math.floor(t1 * SR);
  for (let i = a; i < b; i++) buf[i] += amp * Math.exp(-(i - a) / SR * 25) * r();
}
/** MIDI notes sounding on the three tone channels of a frame */
function notes(regs: Uint8Array, fr: number): number[] {
  const out: number[] = [];
  for (let v = 0; v < 3; v++) {
    const vol = regs[fr * 14 + 8 + v] & 15, off = regs[fr * 14 + 7] & (1 << v);
    const p = regs[fr * 14 + 2 * v] | ((regs[fr * 14 + 2 * v + 1] & 15) << 8);
    if (vol && !off && p) out.push(Math.round(69 + 12 * Math.log2(2e6 / (16 * p) / 440)));
  }
  return out.sort((a, b) => a - b);
}

describe('audio recording -> YM tune', () => {
  it('a sine becomes one voice on the right semitone', () => {
    const b = new Float32Array(SR * 2); tone(b, 440, 0.1, 1.9, 0.8, 1);
    const t = audioToTune(b, SR);
    expect(t.source).toBe('audio');
    expect(t.nframes).toBe(100);
    for (const fr of [30, 50, 70]) expect(notes(t.regs, fr)).toEqual([69]);
  });

  it('an octave is not mistaken for the note: a sawtooth at A3 is A3', () => {
    const b = new Float32Array(SR * 2); tone(b, 220, 0.1, 1.9, 0.8, 8);
    const t = audioToTune(b, SR);
    expect(notes(t.regs, 50)).toEqual([57]);
  });

  it('a three-note chord keeps all three notes, each on its own voice', () => {
    const b = new Float32Array(SR * 2);
    tone(b, mid(48), 0.1, 1.9, 0.7); tone(b, mid(52), 0.1, 1.9, 0.5); tone(b, mid(55), 0.1, 1.9, 0.5);
    const t = audioToTune(b, SR);
    for (const fr of [30, 50, 70]) expect(notes(t.regs, fr)).toEqual([48, 52, 55]);
    expect(Math.abs(t.stats.tuningCents)).toBeLessThan(10);
  });

  it('a melody over a bass line follows both', () => {
    const b = new Float32Array(SR * 4);
    [60, 62, 64, 65, 67, 69, 71, 72].forEach((m, i) => tone(b, mid(m), i * 0.4, i * 0.4 + 0.38, 0.8));
    tone(b, mid(36), 0, 3.2, 0.6);
    const t = audioToTune(b, SR);
    // the middle of each lead note (0.4 s = 20 frames each)
    const lead = [60, 62, 64, 65, 67, 69, 71, 72];
    let ok = 0;
    lead.forEach((m, i) => { const n = notes(t.regs, i * 20 + 12); if (n.includes(m) && n.includes(36)) ok++; });
    expect(ok).toBeGreaterThanOrEqual(6);
  });

  it('a recording tuned off-pitch is pulled back to the semitone grid', () => {
    const b = new Float32Array(SR * 2); tone(b, 440 * Math.pow(2, 0.3 / 12), 0.1, 1.9, 0.8, 1);   // 30 cents sharp
    const t = audioToTune(b, SR);
    expect(notes(t.regs, 50)).toEqual([69]);
    expect(t.stats.tuningCents).toBeGreaterThan(20);
  });

  it('percussion becomes the noise generator, the bass stays', () => {
    const b = new Float32Array(SR * 4); tone(b, mid(40), 0, 4, 0.6);
    for (let i = 0; i < 8; i++) noiseBurst(b, i * 0.5, i * 0.5 + 0.2, 0.7);
    const t = audioToTune(b, SR);
    expect(t.stats.noiseFrames).toBeGreaterThan(15);
    expect(notes(t.regs, 80)).toContain(40);
    // a noise voice has its tone switched off and the noise on
    let noisy = 0; for (let fr = 0; fr < t.nframes; fr++) { const m = t.regs[fr * 14 + 7]; for (let v = 0; v < 3; v++) if (!(m & (8 << v)) && (t.regs[fr * 14 + 8 + v] & 15)) noisy++; }
    expect(noisy).toBeGreaterThan(15);
    const off = audioToTune(b, SR, { noise: false });
    expect(off.stats.noiseFrames).toBe(0);
  });

  it('the voice count, start and length options are honoured', () => {
    const b = new Float32Array(SR * 4);
    tone(b, mid(48), 0, 4, 0.7); tone(b, mid(52), 0, 4, 0.5); tone(b, mid(55), 0, 4, 0.5);
    const one = audioToTune(b, SR, { voices: 1 });
    expect(notes(one.regs, 60).length).toBe(1);
    const part = audioToTune(b, SR, { startSeconds: 1, maxSeconds: 1 });
    expect(part.nframes).toBe(50);
    expect(part.stats.truncated).toBe(true);
    expect(part.warnings.join('\n')).toMatch(/only 1 s/);
  });

  it('silence and too-short input are refused with a message', () => {
    expect(() => audioToTune(new Float32Array(SR), SR)).toThrow(/silent/);
    expect(() => audioToTune(new Float32Array(100), SR)).toThrow(/too short/);
  });

  it('the result is an ordinary tune: it opens as AY patterns', () => {
    const b = new Float32Array(SR * 2); tone(b, mid(48), 0.1, 1.9, 0.7); tone(b, mid(55), 0.1, 1.9, 0.5);
    const t = audioToTune(b, SR);
    const song = regsToSong(t);
    expect(song.song).toBeTruthy();
    expect(song.song.patterns.length).toBeGreaterThan(0);
  });

  it('decodes a 16-bit WAV without a browser and recognises audio files by content', async () => {
    const n = 22050, pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / 22050) * 20000);
    const wav = new Uint8Array(44 + n * 2), dv = new DataView(wav.buffer);
    const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) wav[o + i] = s.charCodeAt(i); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 22050, true); dv.setUint32(28, 44100, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    pcm.forEach((v, i) => dv.setInt16(44 + i * 2, v, true));
    expect(isAudioFile(wav)).toBe(true);
    const d = await decodeAudio(wav);
    expect(d.rate).toBe(22050);
    expect(d.data.length).toBe(n);
    const t = audioToTune(d.data, d.rate);
    expect(notes(t.regs, 25)).toEqual([69]);
    expect(isAudioFile(new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);        // ID3 (MP3)
    expect(isAudioFile(new TextEncoder().encode('YM6!LeOnArD!aaaaaa'))).toBe(false);
    expect(isAudioFile(new TextEncoder().encode('SNDH is not audio'))).toBe(false);
  });
});
