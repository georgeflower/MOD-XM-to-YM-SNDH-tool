"""Small YM2149 emulator -> WAV (for previewing a register dump).  Tone/noise/mixer/volume, no envelope."""
import wave
import numpy as np

CLK = 2_000_000
# YM2149 4-bit volume DAC (approx. measured amplitudes, 0..1)
VOL = np.array([0.0, 0.00465, 0.00772, 0.01095, 0.01625, 0.02359, 0.03317, 0.04658, 0.06655, 0.09396,
                0.13264, 0.18732, 0.26407, 0.37316, 0.5, 1.0])[[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]]


def _noise_seq(n):
    # 17-bit LFSR (taps 0 and 3), as in the YM2149
    out = np.zeros(n, dtype=np.uint8)
    lfsr = 1
    for i in range(n):
        out[i] = lfsr & 1
        bit = (lfsr ^ (lfsr >> 3)) & 1
        lfsr = (lfsr >> 1) | (bit << 16)
    return out


def render(regs, sr=44100, fps=50, over=4):
    nf = len(regs)
    spf = sr * over // fps
    total = nf * spf
    t_step = (CLK / 16.0) / (sr * over)       # noise LFSR shifts per output sample at NP=1 (fclk/16 = 125 kHz)
    tone_step = 2.0 * t_step                  # square toggles at fclk/8 / TP  ->  f = fclk / (16 TP)
    noise = _noise_seq(1 << 17)
    ph = [0.0, 0.0, 0.0]
    nph = 0.0
    out = np.zeros(total, dtype=np.float32)
    for f in range(nf):
        r = regs[f]
        n = np.arange(spf)
        mix = int(r[7])
        mixed = np.zeros(spf)
        nper = max(1, int(r[6]) & 31)
        npos = nph + (n + 1) * t_step / nper
        nbit = noise[(npos.astype(np.int64)) & 0x1FFFF].astype(np.float64)
        nph = float(npos[-1])
        for v in range(3):
            per = max(1, int(r[2 * v]) | ((int(r[2 * v + 1]) & 15) << 8))
            pos = ph[v] + (n + 1) * tone_step / per
            ph[v] = float(pos[-1])
            tone = ((pos.astype(np.int64)) & 1).astype(np.float64)
            tone_on = not (mix & (1 << v))
            noise_on = not (mix & (8 << v))
            sig = np.ones(spf)
            if tone_on: sig = sig * tone
            if noise_on: sig = sig * nbit if tone_on else nbit
            if not tone_on and not noise_on: sig = np.ones(spf)
            vol = VOL[int(r[8 + v]) & 15]
            mixed += sig * vol
        out[f * spf:(f + 1) * spf] = mixed
    # box-filter decimation (over x) + DC removal
    out = out.reshape(-1, over).mean(axis=1)
    out -= out.mean()
    return out / 3.0


def render_wav(regs, path, sr=44100):
    pcm = render(regs, sr)
    pk = np.abs(pcm).max()
    pcm = pcm / pk * 0.8 if pk > 0 else pcm
    w = wave.open(path, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes((pcm * 32767).astype('<i2').tobytes()); w.close()
