import { useEffect, useRef } from 'react';

const CH_COL = ['#ff5555', '#55dd55', '#5599ff'];

/** piano-roll style overview of what the three AY voices do: pitch (log) vs time, brightness = volume,
 *  orange = noise, white playhead */
export function AyRoll({ regs, nframes, position }: { regs: Uint8Array; nframes: number; position: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bg = useRef<HTMLCanvasElement | null>(null);
  const W = 960, H = 150;

  useEffect(() => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const lanes = 3, lh = H / lanes;
    for (let v = 0; v < lanes; v++) {
      g.fillStyle = '#12142a'; g.fillRect(0, v * lh + lh - 1, W, 1);
      for (let x = 0; x < W; x++) {
        const f0 = Math.floor((x / W) * nframes), f1 = Math.max(f0 + 1, Math.floor(((x + 1) / W) * nframes));
        let best = -1, bestY = 0, noise = false;
        for (let f = f0; f < Math.min(f1, nframes); f++) {
          const r = regs.subarray(f * 14, f * 14 + 14);
          const vol = r[8 + v] & 15;
          if (!vol || (vol & 16)) continue;
          const toneOn = !(r[7] & (1 << v)), noiseOn = !(r[7] & (8 << v));
          if (vol > best) {
            best = vol; noise = !toneOn && noiseOn;
            if (toneOn) {
              const per = Math.max(1, r[2 * v] | ((r[2 * v + 1] & 15) << 8));
              const hz = 125000 / per;
              bestY = 1 - Math.min(1, Math.max(0, Math.log2(hz / 30) / Math.log2(4000 / 30)));
            } else bestY = 0.5;
          }
        }
        if (best > 0) {
          const k = 0.25 + 0.75 * (best / 15);
          g.globalAlpha = k;
          g.fillStyle = noise ? '#ffaa33' : CH_COL[v];
          g.fillRect(x, v * lh + 2 + bestY * (lh - 6), 1, 2);
        }
      }
      g.globalAlpha = 1;
    }
    bg.current = c;
    draw();
  }, [regs, nframes]);

  function draw() {
    const cv = ref.current, b = bg.current;
    if (!cv || !b) return;
    const g = cv.getContext('2d')!;
    g.drawImage(b, 0, 0);
    g.fillStyle = '#fff';
    g.fillRect(Math.floor(position * 50 / nframes * W), 0, 1, H);
  }
  useEffect(draw, [position]);

  return <canvas ref={ref} width={W} height={H} className="roll" />;
}
