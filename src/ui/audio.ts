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
  loadOriginal(bytes: Uint8Array) {
    this.stop();
    this.modBytes = bytes.slice().buffer;
    if (!this.orig && !this.origLoading && location.protocol !== 'file:') {
      this.origLoading = true;
      createOrigPlayer(this.ctx).then((p) => {
        this.orig = p;
        p.onInitialized(() => { this.origReady = true; p.gain.connect(this.origGain); });
      }).catch((e) => console.error('original-module player unavailable', e));
    }
  }

  setAy(pcm: Float32Array, sr = 44100) {
    const wasPlaying = this.playing, pos = this.position();
    this.stop();
    const b = this.ctx.createBuffer(1, pcm.length, sr);
    b.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    this.ayBuf = b;
    this.duration = b.duration;
    if (wasPlaying) this.play(pos);
  }

  position(): number {
    if (!this.playing) return this.offset;
    const d = this.duration || 1;
    return (this.ctx.currentTime - this.t0) % d;
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
    this.ayNode.connect(this.ayGain);
    this.ayNode.start(0, from);
    if (this.orig && this.origReady && this.modBytes) {
      this.orig.play(this.modBytes.slice(0));
      if (from > 0) setTimeout(() => this.orig?.setPos(from), 150);
    }
    this.playing = true;
  }

  private stopNodes() {
    try { this.ayNode?.stop(); } catch { /* already stopped */ }
    this.ayNode?.disconnect(); this.ayNode = null;
    try { this.orig?.stop(); } catch { /* not playing */ }
  }

  stop() {
    this.offset = this.playing ? this.position() : this.offset;
    this.stopNodes();
    this.playing = false;
  }

  rewind() { this.stop(); this.offset = 0; }

  seek(sec: number) {
    if (this.playing) this.play(sec); else this.offset = sec;
  }
}
