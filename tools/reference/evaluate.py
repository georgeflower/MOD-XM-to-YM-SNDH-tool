"""Objective fidelity check: chroma similarity between a reference render (e.g. libopenmpt) and the AY preview."""
import sys, wave
import numpy as np


def load_mono(path, sr_expected=44100):
    w = wave.open(path, 'rb')
    ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
    raw = np.frombuffer(w.readframes(n), dtype='<i2').astype(np.float32) / 32768
    if ch == 2: raw = raw.reshape(-1, 2).mean(axis=1)
    return raw, sr


def chroma(x, sr, hop=0.1, win=0.2, fmin=60, fmax=2000):
    n = int(sr * win); h = int(sr * hop)
    w = np.hanning(n)
    freqs = np.fft.rfftfreq(n, 1 / sr)
    sel = (freqs >= fmin) & (freqs <= fmax)
    pc = (np.round(12 * np.log2(freqs[sel] / 261.6256)).astype(int)) % 12
    out = []
    for s in range(0, len(x) - n, h):
        sp = np.abs(np.fft.rfft(x[s:s + n] * w))[sel]
        c = np.zeros(12)
        np.add.at(c, pc, sp ** 2)
        out.append(c)
    return np.array(out)


def score(ref_path, test_path):
    a, sra = load_mono(ref_path)
    b, srb = load_mono(test_path)
    n = min(len(a), len(b))
    ca, cb = chroma(a[:n], sra), chroma(b[:n], srb)
    m = min(len(ca), len(cb))
    ca, cb = ca[:m], cb[:m]
    na = np.linalg.norm(ca, axis=1); nb = np.linalg.norm(cb, axis=1)
    ok = (na > np.percentile(na, 10)) & (nb > 0)
    sim = (ca[ok] * cb[ok]).sum(axis=1) / (na[ok] * nb[ok])
    return float(sim.mean()), float(np.percentile(sim, 10))


if __name__ == '__main__':
    mean, p10 = score(sys.argv[1], sys.argv[2])
    print(f"chroma cosine similarity: mean {mean:.3f}, p10 {p10:.3f}")
