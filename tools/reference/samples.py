"""Sample analysis: playback-position folding, true pitch (cycle length) and tonal/kick/noise classification."""
import numpy as np


def fold(s, a, b):
    """Return the sample values at integer positions [a, b) honouring forward / ping-pong loops.
    Positions beyond the end of a non-looping sample are dropped."""
    n = len(s['data'])
    idx = np.arange(int(a), int(b))
    if len(idx) == 0:
        return np.zeros(0)
    ls, ll, lt = s['ls'], s['ll'], s['loop']
    le = ls + ll
    if lt == 1:
        idx = np.where(idx >= le, ls + (idx - ls) % ll, idx)
    elif lt == 2:
        m = (idx - ls) % (2 * ll)
        wrapped = np.where(m < ll, ls + m, ls + 2 * ll - 1 - m)
        idx = np.where(idx >= le, wrapped, idx)
    idx = idx[(idx >= 0) & (idx < n)]
    return s['data'][idx]


def ended(s, pos):
    return s['loop'] == 0 and pos >= len(s['data'])


def autocorr_cycle(x, minlag=3):
    """Estimate the fundamental period (in samples, float) and its confidence from the autocorrelation."""
    x = x - x.mean()
    if np.abs(x).max() < 1e-4 or len(x) < 16:
        return None, 0.0
    n = len(x)
    f = np.fft.rfft(x, 2 * n)
    ac = np.fft.irfft(f * np.conj(f))[:n // 2]
    ac = ac / (ac[0] + 1e-12)
    neg = np.where(ac < 0)[0]
    if len(neg) == 0:
        return None, 0.0
    start = max(neg[0], minlag)
    seg = ac[start:]
    if len(seg) < 3:
        return None, 0.0
    peak = seg.max()
    # first local maximum that is within 90 % of the best peak -> fundamental, not a multiple
    for k in range(1, len(seg) - 1):
        if seg[k] >= 0.9 * peak and seg[k] >= seg[k - 1] and seg[k] >= seg[k + 1]:
            lag = start + k
            # parabolic refinement
            y0, y1, y2 = ac[lag - 1], ac[lag], ac[lag + 1]
            den = (y0 - 2 * y1 + y2)
            frac = 0.5 * (y0 - y2) / den if abs(den) > 1e-12 else 0.0
            return lag + frac, float(peak)
    return None, float(peak)


def analyse(s, override_cycle=None):
    """Return dict(cls, cycle, q) for a sample.  cls in tonal | kick | noise."""
    d = s['data']
    if len(d) < 8:
        return dict(cls='empty', cycle=None, q=0.0, zc=0.0)
    if s['loop']:
        # unrolled loop body, long enough for a stable estimate
        body = fold(s, s['ls'], s['ls'] + max(4096, 2 * s['ll'] + 2))
    else:
        body = d[:8192]
    cyc, q = autocorr_cycle(body)
    if cyc and s['loop'] and s['loop'] == 1:
        # designed loops contain whole cycles -> snap cycle to ll / round(ll / cycle)
        n = max(1, round(s['ll'] / cyc))
        snapped = s['ll'] / n
        if abs(snapped - cyc) / cyc < 0.02:
            cyc = snapped
    if override_cycle:
        cyc = override_cycle
    # zero-crossing rate of the (whole) sample, in crossings per sample
    sg = np.signbit(d)
    zc = np.count_nonzero(sg[1:] != sg[:-1]) / max(1, len(d))
    if q >= 0.75 and cyc:
        cls = 'tonal'
    else:
        cls = 'noise' if zc > 0.04 else 'kick'
    return dict(cls=cls, cycle=cyc, q=q, zc=zc)
