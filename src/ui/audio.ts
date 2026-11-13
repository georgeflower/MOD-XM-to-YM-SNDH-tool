// A/B preview: the original module (libopenmpt via chiptune3) against the YM2149 rendering of the conversion.
// chiptune3 (libopenmpt in an AudioWorklet) is vendored under public/vendor/chiptune3 and loaded at runtime,
// because the worklet pulls in its sibling files by relative URL and so must not be bundled.
interface OrigPlayer {
  gain: GainNode;
  onInitialized(h: () => void): void;
  play(buf: ArrayBuffer): void;
  stop(): void;
  setPos(sec: number): void;
}
async function createOrigPlayer(ctx: AudioContext): Promise<OrigPlayer> {
  const url = new URL('vendor/chiptune3/chiptune3.js', document.baseURI).href;
  const mod = await import(/* @vite-ignore */ url);
  return new mod.ChiptuneJsPlayer({ context: ctx, repeatCount: -1 });
}

export type Source = 'orig' | 'ay';

export class Preview {
  readonly ctx = new AudioContext();
  private orig: OrigPlayer | null = null;
  private origLoading = false;
  private origReady = false;
  private origGain = this.ctx.createGain();
  private ayGain = this.ctx.createGain();
  private ayNode: AudioBufferSourceNode | null = null;
  private ayBuf: AudioBuffer | null = null;
  private modBytes: ArrayBuffer | null = null;
  /** the original as rendered audio (SPC files): played in sync with the YM version instead of the libopenmpt player */
  private origBuf: AudioBuffer | null = null;
  private origNode: AudioBufferSourceNode | null = null;
  /** where each side loops back to, seconds (0 = the beginning) */
  private origLoop = 0;
  private ayLoop = 0;
  private t0 = 0; // context time at which position 0 would have started
  private offset = 0;
  playing = false;
  source: Source = 'ay';
  duration = 0;

  constructor() {
    this.origGain.connect(this.ctx.destination);
    this.ayGain.connect(this.ctx.destination);
    this.applySource();
  }

  private applySource() {
    this.origGain.gain.value = this.source === 'orig' ? 1 : 0;
    this.ayGain.gain.value = this.source === 'ay' ? 1 : 0;
  }

  setSource(s: Source) { this.source = s; this.applySource(); }

  /** load the original module for the "original" side of the A/B switch */
  loadOriginal(bytes: Uint8Array | null) {
    this.stop();
    this.origBuf = null;
    this.modBytes = bytes ? bytes.slice().buffer : null;
    if (!bytes) return;
    if (!this.orig && !this.origLoading && location.protocol !== 'file:') {
      this.origLoading = true;
      createOrigPlayer(this.ctx).then((p) => {
        this.orig = p;
        p.onInitialized(() => { this.origReady = true; p.gain.connect(this.origGain); });
      }).catch((e) => console.error('original-module player unavailable', e));
    }
  }

  /** the original as interleaved stereo int16 (e.g. an SPC rendered by the emulator) */
  setOriginalPcm(pcm: Int16Array | null, sr: number, loopStart = 0) {
    this.stop();
    this.modBytes = null;
    if (!pcm) { this.origBuf = null; return; }
    this.origLoop = loopStart;
    const n = pcm.length >> 1;
    const b = this.ctx.createBuffer(2, n, sr);
    const l = new Float32Array(n), r = new Float32Array(n);
    for (let i = 0; i < n; i++) { l[i] = pcm[i * 2] / 32768; r[i] = pcm[i * 2 + 1] / 32768; }
    b.copyToChannel(l, 0); b.copyToChannel(r, 1);
    this.origBuf = b;
  }

  setAy(pcm: Float32Array, sr = 44100, loopStart = 0) {
    const wasPlaying = this.playing, pos = this.position();
    this.stop();
    const b = this.ctx.createBuffer(1, pcm.length, sr);
    b.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    this.ayBuf = b;
    this.duration = b.duration;
    this.ayLoop = loopStart < b.duration - 0.05 ? loopStart : 0;
    if (wasPlaying) this.play(pos);
  }

  position(): number {
    if (!this.playing) return this.offset;
    const d = this.duration || 1, t = this.ctx.currentTime - this.t0;
    if (t < d) return t;
    const l = this.ayLoop;
    return l + ((t - d) % (d - l));
  }

  async play(from = 0) {
    if (!this.ayBuf) return;
    await this.ctx.resume();
    this.stopNodes();
    this.offset = from;
    this.t0 = this.ctx.currentTime - from;
    this.ayNode = this.ctx.createBufferSource();
    this.ayNode.buffer = this.ayBuf;
    this.ayNode.loop = true;
    if (this.ayLoop) { this.ayNode.loopStart = this.ayLoop; this.ayNode.loopEnd = this.ayBuf.duration; }
    this.ayNode.connect(this.ayGain);
    this.ayNode.start(0, from);
    if (this.origBuf) {
      this.origNode = this.ctx.createBufferSource();
      this.origNode.buffer = this.origBuf;
      this.origNode.loop = true;
      if (this.origLoop && this.origLoop < this.origBuf.duration - 0.05) { this.origNode.loopStart = this.origLoop; this.origNode.loopEnd = this.origBuf.duration; }
      this.origNode.connect(this.origGain);
      this.origNode.start(0, from % this.origBuf.duration);
    }
    if (this.orig && this.origReady && this.modBytes) {
      this.orig.play(this.modBytes.slice(0));
      if (from > 0) setTimeout(() => this.orig?.setPos(from), 150);
    }
    this.playing = true;
  }

  private stopNodes() {
    try { this.ayNode?.stop(); } catch { /* already stopped */ }
    this.ayNode?.disconnect(); this.ayNode = null;
    try { this.origNode?.stop(); } catch { /* already stopped */ }
    this.origNode?.disconnect(); this.origNode = null;
    try { this.orig?.stop(); } catch { /* not playing */ }
  }

  stop() {
    this.offset = this.playing ? this.position() : this.offset;
    this.stopNodes();
    this.playing = false;
  }

  rewind() { this.stop(); this.offset = 0; }

  // ---- short one-shot sounds (pattern editor note audition), independent of the main buffer
  private audNode: AudioBufferSourceNode | null = null;
  private audGain: GainNode | null = null;
  audition(pcm: Float32Array, sr = 44100) {
    this.stopAudition(0);
    this.ctx.resume();
    const b = this.ctx.createBuffer(1, pcm.length, sr);
    b.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    const g = this.ctx.createGain();
    g.connect(this.ctx.destination);
    const n = this.ctx.createBufferSource();
    n.buffer = b; n.connect(g); n.start();
    this.audNode = n; this.audGain = g;
    n.onended = () => { if (this.audNode === n) { this.audNode = null; this.audGain = null; } };
  }
  stopAudition(fade = 0.04) {
    const n = this.audNode, g = this.audGain;
    this.audNode = null; this.audGain = null;
    if (!n || !g) return;
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(0, t + fade);
    try { n.stop(t + fade + 0.01); } catch { /* already stopped */ }
  }

  seek(sec: number) {
    if (this.playing) this.play(sec); else this.offset = sec;
  }
}
