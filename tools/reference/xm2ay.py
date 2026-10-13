#!/usr/bin/env python3
"""xm2ay - convert a FastTracker II .XM module into a 50 Hz YM2149 / AY-3-8910 register dump.

An XM has up to 32 sample channels, the YM2149 has 3 square voices + 1 noise generator, so the
conversion is a *reduction*: the XM is replayed tick by tick, every sounding channel is turned
into an AY "event" (tone period + level, or a noise/kick drum macro) and the 3 loudest/most
important events are written to the chip registers every frame.

Outputs (all start with --out; pick with --formats, default regs,ym,qym,h,txt):
  .regs   raw dump, 14 bytes/frame (R0..R13), frame-major
  .ym     YM5! file (uncompressed, interleaved) - plays in ST-Sound / desktop YM players
  .qym    packed delta stream ("QYM1" header + stream) for a 68000 replayer
  .h      the same stream as a C array (what QUANOID's Makefile includes)
  .txt    conversion report
  .wav    preview rendered by the built-in YM2149 emulator (--wav)

Only numpy is needed.  Usage:  python3 xm2ay.py song.xm --out build/song --name music --wav
"""
import argparse
import math
import os
import struct
import sys
from collections import Counter

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xmfile
import samples as smp
import xmplay

FPS = 50
YM_CLOCK = 2_000_000
TONE_HZ = YM_CLOCK / 16.0           # period 1 -> 125 kHz


# --------------------------------------------------------------------------- candidates
def drum_macro(cls, inst_info, age, base_level, rate_play):
    """Drum macros (the XM drum samples are only 1-3 ticks long, far too short for the AY)."""
    if cls == 'kick':
        lv = (1.0, 0.8, 0.55, 0.3)
        if age >= len(lv): return None
        f0 = 150.0
        f = f0 * (0.45 ** (age / (len(lv) - 1)))            # falling thump 150 -> 68 Hz
        return dict(kind='tone', per=TONE_HZ / f, np=None, lvl=base_level * lv[age])
    if cls == 'hat':
        lv = (0.9, 0.5)
        if age >= len(lv): return None
        return dict(kind='noise', per=None, np=3, lvl=base_level * lv[age])
    # snare
    lv = (1.0, 0.85, 0.6, 0.3)
    npv = (12, 10, 8, 8)
    if age >= len(lv): return None
    return dict(kind='noise', per=None, np=npv[age], lvl=base_level * lv[age])


def build_candidates(m, frames, info, args):
    """Per frame: list of dicts (ch, kind, per, np, lvl, inst)."""
    dt = 1.0 / FPS
    cand = []
    base_cache = {}
    for f, snap in enumerate(frames):
        lst = []
        for ci, st in enumerate(snap):
            if st is None or st['vol'] <= 0:
                continue
            inf = info[(st['inst'], st['ksmp'])]
            s = st['smp']
            cls = inf['cls']
            if cls == 'empty':
                continue
            if cls == 'tonal':
                if smp.ended(s, st['pos']):
                    continue
                n = max(4, int(st['rate'] * dt))
                w = smp.fold(s, st['pos'], st['pos'] + n)
                if len(w) == 0:
                    continue
                rms = float(np.sqrt(np.mean(w * w)))
                lvl = rms * st['vol']
                hz = st['rate'] / inf['cycle']
                per = TONE_HZ / hz
                lst.append(dict(ch=ci, kind='tone', per=per, np=None, lvl=lvl, inst=st['inst']))
            else:
                key = (st['inst'], st['ksmp'])
                if key not in base_cache:
                    d = s['data']
                    rate_c5 = 8363.0 * 2 ** ((s['rel'] * 128 + s['fine']) / (12 * 128)) * 2   # nominal
                    F = np.abs(np.fft.rfft(d * np.hanning(len(d)))) ** 2
                    fr = np.fft.rfftfreq(len(d), 1.0 / rate_c5)
                    cen = float((F * fr).sum() / max(F.sum(), 1e-12))
                    dur_ticks = len(d) / rate_c5 / dt
                    over = args.drum_class.get(st['inst'])
                    if over:
                        k = over
                    elif cls == 'kick' or cen < 400:
                        k = 'kick'
                    else:
                        k = 'hat' if dur_ticks <= 2.0 else 'snare'
                    base_cache[key] = (k, float(np.sqrt(np.mean(d * d))), cen, dur_ticks)
                k, rms, cen, dur = base_cache[key]
                mac = drum_macro(k, inf, st['age'], rms * st['vol'] * args.drum_gain, st['rate'])
                if mac:
                    mac.update(ch=ci, inst=st['inst'], drum=k)
                    lst.append(mac)
        cand.append(lst)
    return cand, base_cache


# --------------------------------------------------------------------------- allocation
def ay_volume(lvl, ref, gain_db):
    if lvl <= 0: return 0
    v = 15 + 2.0 * math.log2(lvl / ref) + gain_db / 3.0103
    return max(0, min(15, int(round(v))))


def allocate(cand, args, log=print):
    # reference loudness: high percentile of the tonal levels -> AY volume 15
    tl = np.array([c['lvl'] for fr in cand for c in fr if c['kind'] == 'tone' and 'drum' not in c])
    ref = float(np.percentile(tl, args.ref_percentile))
    nvoices = 3
    # static importance of every channel (loudness x frames sounding) -> stable voice A..C ordering
    imp = Counter()
    for fr in cand:
        for c in fr:
            imp[c['ch']] += ay_volume(c['lvl'], ref, args.gain_db) if 'drum' not in c else 0
    rank = {ch: -imp[ch] - 1000.0 * args.prio.get(ch, 0.0) for ch in imp}
    slots = [None] * nvoices            # channel held by each slot in the previous frame
    out = []
    stats = Counter()
    dropped_by_ch = Counter()
    played_by_ch = Counter()
    for fr in cand:
        scored = []
        for c in fr:
            v = ay_volume(c['lvl'], ref, args.gain_db)
            if v <= 0:
                continue
            score = v + args.prio.get(c['ch'], 0.0)
            if 'drum' in c: score += args.drum_bonus
            if c['ch'] in slots: score += args.sticky
            scored.append((score, v, c))
        scored.sort(key=lambda t: -t[0])
        if args.dup_penalty:
            # greedy re-pick: a line doubling the pitch class of an already chosen line is worth less
            pool = list(scored); picked = []
            def pc(c):
                return int(round(12 * math.log2(TONE_HZ / c['per'] / 261.6256))) % 12 if c['kind'] == 'tone' else None
            while pool and len(picked) < nvoices + 4:
                best = max(pool, key=lambda t: t[0] - (args.dup_penalty if (pc(t[2]) is not None and
                           any(pc(p[2]) == pc(t[2]) for p in picked[:nvoices])) else 0))
                pool.remove(best); picked.append(best)
            scored = picked
        chosen = []
        noise_taken = False
        for score, v, c in scored:
            if len(chosen) == nvoices:
                dropped_by_ch[c['ch']] += 1
                continue
            if c['kind'] == 'noise':
                if noise_taken:
                    dropped_by_ch[c['ch']] += 1
                    continue
                noise_taken = True
            chosen.append((v, c))
            played_by_ch[c['ch']] += 1
        # keep previously used slots stable
        new = [None] * nvoices
        rest = []
        for v, c in chosen:
            if c['ch'] in slots and new[slots.index(c['ch'])] is None:
                new[slots.index(c['ch'])] = (v, c)
            else:
                rest.append((v, c))
        # newcomers: most important line takes the lowest free voice (A), drums prefer the last voice (C)
        rest.sort(key=lambda it: (('drum' in it[1]), rank.get(it[1]['ch'], 0.0)))
        for item in rest:
            order = range(nvoices - 1, -1, -1) if 'drum' in item[1] else range(nvoices)
            for i in order:
                if new[i] is None:
                    new[i] = item
                    break
        slots = [it[1]['ch'] if it else None for it in new]
        emit = list(new)
        # time-multiplexing: on odd frames the weakest melodic voice hands over to the best leftover line
        if args.mux:
            left = [(v, c) for score, v, c in scored
                    if c['kind'] == 'tone' and 'drum' not in c and all(c is not x[1] for x in chosen if x)]
            melodic = [i for i in range(nvoices) if new[i] and new[i][1]['kind'] == 'tone' and 'drum' not in new[i][1]]
            if left and melodic and len(chosen) == nvoices:
                low = min(melodic, key=lambda i: new[i][0])
                lv, lc = left[0]
                if lv >= args.mux_min and (len(out) & 1):
                    emit[low] = (lv, lc)
        out.append(emit)
    return out, ref, played_by_ch, dropped_by_ch


# --------------------------------------------------------------------------- registers
def to_registers(alloc, args, log=print):
    nf = len(alloc)
    regs = np.zeros((nf, 14), dtype=np.uint8)
    prev_per = [1000, 1000, 1000]
    prev_np = 8
    prev_mix = [0, 0, 0]               # per voice: 1 = tone, 2 = noise  (kept while voice is silent)
    oct_shift = 0
    for f, sl in enumerate(alloc):
        vols = [0, 0, 0]
        mixbits = list(prev_mix)
        npv = prev_np
        for i, it in enumerate(sl):
            if it is None:
                continue
            v, c = it
            vols[i] = v
            if c['kind'] == 'tone':
                per = c['per']
                while per > 4095:
                    per /= 2.0; oct_shift += 1
                while per < 1.0:
                    per *= 2.0
                per = int(round(per))
                per = max(1, min(4095, per))
                prev_per[i] = per
                mixbits[i] = 1
            else:
                npv = c['np']
                mixbits[i] = 2
        prev_np = npv
        prev_mix = mixbits
        mix = 0xC0                                   # bits 6/7: I/O ports A/B stay outputs (ST needs that)
        for i in range(3):
            if mixbits[i] != 1: mix |= (1 << i)      # tone off  (bit set = disabled)
            if mixbits[i] != 2: mix |= (8 << i)      # noise off
        for i in range(3):
            regs[f, 2 * i] = prev_per[i] & 0xFF
            regs[f, 2 * i + 1] = prev_per[i] >> 8
        regs[f, 6] = prev_np
        regs[f, 7] = mix
        regs[f, 8], regs[f, 9], regs[f, 10] = vols
    return regs, oct_shift


# --------------------------------------------------------------------------- writers
def pack_stream(regs, loop_frame):
    """Delta stream. Per frame:  A = bit7 'B follows' | mask of R0..R6 (bits 0-6)
                                 B = mask of R7..R13 (bits 0-6)  [only if bit7 of A set]
                                 then one byte per set mask bit, in register order.
    First frame writes all 14 regs. Returns (bytes, offset_of_loop_frame)."""
    out = bytearray()
    cur = None
    loop_off = 0
    for f in range(len(regs)):
        if f == loop_frame:
            loop_off = len(out)
            cur = None                       # force a full refresh so the loop point is self-contained
        r = regs[f]
        mask = 0
        for k in range(14):
            if cur is None or r[k] != cur[k]:
                mask |= (1 << k)
        a = mask & 0x7F
        b = (mask >> 7) & 0x7F
        if b: a |= 0x80
        out.append(a)
        if b: out.append(b)
        for k in range(14):
            if mask & (1 << k): out.append(int(r[k]))
        cur = r
    return bytes(out), loop_off


def unpack_stream(data, nframes, loop_off=0):
    """Reference decoder (mirrors music_replay.c) - used for self-check."""
    regs = np.zeros((nframes, 14), dtype=np.uint8)
    cur = [0] * 14
    p = 0
    for f in range(nframes):
        a = data[p]; p += 1
        mask = a & 0x7F
        if a & 0x80:
            mask |= (data[p] & 0x7F) << 7; p += 1
        for k in range(14):
            if mask & (1 << k):
                cur[k] = data[p]; p += 1
        regs[f] = cur
    return regs


def write_ym(path, regs, loop_frame, title, author, comment):
    nf = len(regs)
    full = np.zeros((nf, 16), dtype=np.uint8)
    full[:, :14] = regs
    full[:, 13] = 0xFF                      # no envelope restart
    hdr = b'YM5!' + b'LeOnArD!'
    hdr += struct.pack('>IIHIHIH', nf, 1, 0, YM_CLOCK, FPS, loop_frame, 0)
    for s in (title, author, comment):
        hdr += s.encode('latin1', 'replace') + b'\0'
    body = b''.join(full[:, r].tobytes() for r in range(16))      # interleaved
    open(path, 'wb').write(hdr + body + b'End!')


def write_header(path, name, data, nframes, loop_frame, loop_off):
    lines = [f"/* generated by xm2ay.py - {nframes} frames @ 50 Hz, {len(data)} bytes */",
             f"#define {name.upper()}_FRAMES {nframes}",
             f"#define {name.upper()}_LOOP_FRAME {loop_frame}",
             f"#define {name.upper()}_LOOP_OFFSET {loop_off}",
             f"static const unsigned char {name}_data[{len(data)}] = {{"]
    for i in range(0, len(data), 24):
        lines.append("    " + ",".join(str(b) for b in data[i:i + 24]) + ",")
    lines.append("};")
    open(path, 'w').write("\n".join(lines) + "\n")


# --------------------------------------------------------------------------- main
def parse_kv(s, conv=float):
    d = {}
    if s:
        for part in s.split(','):
            k, v = part.split('=')
            d[int(k)] = conv(v)
    return d


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('xm')
    ap.add_argument('--out', default=None, help='output basename (default: next to the xm)')
    ap.add_argument('--name', default=None, help='C identifier / file stem (default: xm file stem)')
    ap.add_argument('--wav', action='store_true', help='render a preview .wav with the built-in YM emulator')
    ap.add_argument('--formats', default='regs,ym,qym,h,txt', help='comma list of outputs to write (regs,ym,qym,h,txt)')
    ap.add_argument('--prio', default='', help='channel priority bonus, 1-based XM channels, e.g. 1=2,5=-1')
    ap.add_argument('--drum-class', default='', help='force drum macro per instrument, e.g. 7=hat,8=kick,9=snare')
    ap.add_argument('--drum-bonus', type=float, default=3.0, help='allocation bonus for drum hits (default 3)')
    ap.add_argument('--drum-gain', type=float, default=1.0)
    ap.add_argument('--gain-db', type=float, default=0.0)
    ap.add_argument('--sticky', type=float, default=1.5, help='hysteresis bonus for a channel already holding a voice')
    ap.add_argument('--ref-percentile', type=float, default=97.0)
    ap.add_argument('--dup-penalty', type=float, default=0.0, help='allocation penalty for a line doubling a chosen line\'s pitch class')
    ap.add_argument('--mux', action='store_true', help='time-multiplex the weakest voice with the best dropped line (25 Hz)')
    ap.add_argument('--mux-min', type=float, default=5.0, help='minimum AY volume of a line to be multiplexed in')
    ap.add_argument('--arp-order', choices=['xy', 'yx'], default='xy')
    ap.add_argument('--cycle', default='', help='override sample cycle length per instrument, e.g. 2=25')
    ap.add_argument('--loop-order', type=int, default=None, help='order index to loop to (default: XM restart pos)')
    args = ap.parse_args()
    args.prio = {k - 1: v for k, v in parse_kv(args.prio).items()}
    dc = {}
    if args.drum_class:
        for part in args.drum_class.split(','):
            k, v = part.split('=')
            dc[int(k)] = v
    args.drum_class = dc
    cyc_over = parse_kv(args.cycle)

    stem = os.path.splitext(os.path.basename(args.xm))[0]
    name = (args.name or stem).lower().replace('-', '_').replace(' ', '_')
    outbase = args.out or os.path.join(os.path.dirname(os.path.abspath(args.xm)), stem.lower())
    rep = []
    log = lambda *a: (print(*a), rep.append(' '.join(str(x) for x in a)))

    m = xmfile.load(args.xm)
    log(f"'{m.title}': {m.nch} channels, {len(m.pats)} patterns, order length {m.songlen}, speed {m.tempo}, BPM {m.bpm}")
    info = {}
    for i, ins in enumerate(m.inst):
        if not ins or not ins['samples']: continue
        for k, s in enumerate(ins['samples']):
            info[(i, k)] = smp.analyse(s, cyc_over.get(i) if k == 0 else None)
    log('instrument analysis:')
    for (i, k), a in sorted(info.items()):
        if k == 0 and a['cls'] != 'empty':
            extra = ''
            if a['cls'] == 'tonal':
                s = m.inst[i]['samples'][0]
                f4 = xmplay.rate_of(xmplay.period_of(48 + s['rel'], s['fine'])) / a['cycle']
                extra = f", C-4 sounds {f4:.1f} Hz ({12 * math.log2(f4 / 261.6256):+.2f} st vs C4)"
            log(f"  inst {i:2d} {m.inst[i]['name'][:20]!r:24} {a['cls']:6}{extra}")

    frames, order_frame = xmplay.play(m, info, args.arp_order, log=log)
    nf = len(frames)
    loop_order = m.restart if args.loop_order is None else args.loop_order
    loop_frame = order_frame.get(loop_order, 0)
    log(f"replayed {nf} frames = {nf / FPS:.2f} s, loop to order {loop_order} (frame {loop_frame})")

    cand, drum_info = build_candidates(m, frames, info, args)
    alloc, ref, played, dropped = allocate(cand, args, log)
    regs, octs = to_registers(alloc, args, log)
    data, loop_off = pack_stream(regs, loop_frame)
    chk = unpack_stream(data, nf)
    assert (chk == regs).all(), "pack/unpack mismatch"

    # ---- report
    log(f"loudness reference (tonal p{args.ref_percentile:g}) = {ref:.3f} -> AY volume 15")
    log("channel   voice-frames   dropped   (dropped = lost to the 3-voice limit)")
    for c in sorted(set(played) | set(dropped)):
        log(f"  ch{c + 1:02d}    {played[c]:8d}   {dropped[c]:8d}   {100.0 * dropped[c] / max(1, played[c] + dropped[c]):5.1f}%")
    if octs: log(f"{octs} frames needed an octave shift (period > 4095)")
    changes = sum(1 for f in range(1, nf) if (regs[f] != regs[f - 1]).any())
    log(f"packed stream: {len(data)} bytes ({len(data) / nf:.2f} B/frame), raw dump {nf * 14} bytes; frames with changes: {changes}")

    base = outbase
    fmts = set(x.strip() for x in args.formats.split(','))
    os.makedirs(os.path.dirname(os.path.abspath(base)), exist_ok=True)
    wrote = []
    if 'regs' in fmts:
        open(base + '.regs', 'wb').write(regs.tobytes()); wrote.append('.regs')
    if 'ym' in fmts:
        write_ym(base + '.ym', regs, loop_frame, m.title, 'xm2ay', 'converted from ' + os.path.basename(args.xm)); wrote.append('.ym')
    if 'qym' in fmts:
        hdr = struct.pack('>4sHHI', b'QYM1', nf, loop_frame, loop_off)
        open(base + '.qym', 'wb').write(hdr + data); wrote.append('.qym')
    if 'h' in fmts:
        write_header(base + '.h', name, data, nf, loop_frame, loop_off); wrote.append('.h')
    if 'txt' in fmts:
        open(base + '.txt', 'w').write('\n'.join(rep) + '\n'); wrote.append('.txt')
    log('wrote', ', '.join(os.path.basename(base) + e for e in wrote))
    if args.wav:
        import ymemu
        wav = base + '.wav'
        ymemu.render_wav(regs, wav)
        log('wrote', os.path.basename(wav))


if __name__ == '__main__':
    main()
