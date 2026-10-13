"""Minimal FastTracker II (.XM) loader: header, patterns, instruments + sample data."""
import struct
import numpy as np


class XM:
    pass


def load(path):
    d = open(path, 'rb').read()
    if d[:17] != b'Extended Module: ':
        raise ValueError('not an XM file')
    m = XM()
    m.title = d[17:37].split(b'\0')[0].decode('latin1').strip()
    hs, = struct.unpack_from('<I', d, 60)
    (m.songlen, m.restart, m.nch, npat, ninst, flags, m.tempo, m.bpm) = struct.unpack_from('<8H', d, 64)
    m.linear = bool(flags & 1)
    m.order = list(d[80:80 + m.songlen])
    off = 60 + hs
    m.pats = []
    for _ in range(npat):
        plh, _pack, nrows, psize = struct.unpack_from('<IBHH', d, off)
        data = d[off + plh: off + plh + psize]
        i = 0
        rows = []
        for _r in range(nrows):
            row = []
            for _c in range(m.nch):
                note = inst = vol = eff = par = 0
                if i < len(data):
                    b = data[i]; i += 1
                    if b & 0x80:
                        if b & 1: note = data[i]; i += 1
                        if b & 2: inst = data[i]; i += 1
                        if b & 4: vol = data[i]; i += 1
                        if b & 8: eff = data[i]; i += 1
                        if b & 16: par = data[i]; i += 1
                    else:
                        note, inst, vol, eff, par = b, data[i], data[i + 1], data[i + 2], data[i + 3]; i += 4
                row.append((note, inst, vol, eff, par))
            rows.append(row)
        m.pats.append(rows)
        off += plh + psize
    m.inst = [None]  # 1-based
    for _ in range(ninst):
        ih, = struct.unpack_from("<I", d, off)
        name = d[off + 4:off + 26].split(b'\0')[0].decode('latin1')
        ns, = struct.unpack_from('<H', d, off + 27)
        ins = dict(name=name, samples=[], venv=[], vflags=0, fade=0, vib=(0, 0, 0, 0), keymap=[0] * 96,
                   vsus=0, vls=0, vle=0)
        if ns > 0:
            shs, = struct.unpack_from('<I', d, off + 29)
            b = off + 33
            ins['keymap'] = list(d[b:b + 96])
            vp = struct.unpack_from('<24H', d, b + 96)
            nvp = d[b + 192]
            ins['venv'] = [(vp[2 * k], vp[2 * k + 1]) for k in range(nvp)]
            ins['vsus'], ins['vls'], ins['vle'] = d[b + 194], d[b + 195], d[b + 196]
            ins['vflags'] = d[b + 200]
            ins['vib'] = tuple(d[b + 202:b + 206])      # type, sweep, depth, rate
            ins['fade'], = struct.unpack_from('<H', d, b + 206)
            off += ih
            hdrs = []
            for _s in range(ns):
                sl, ls, ll, vol, fine, typ, pan, rel = struct.unpack_from('<IIIBbBBb', d, off)
                nm = d[off + 18:off + 40].split(b'\0')[0].decode('latin1').strip()
                hdrs.append(dict(len=sl, ls=ls, ll=ll, vol=vol, fine=fine, type=typ, pan=pan, rel=rel, name=nm))
                off += shs
            for h in hdrs:
                raw = d[off:off + h['len']]; off += h['len']
                if h['type'] & 0x10:
                    a = np.frombuffer(raw[:len(raw) // 2 * 2], dtype='<i2').astype(np.int64)
                    a = ((np.cumsum(a) + 32768) & 0xFFFF) - 32768
                    a = a.astype(np.float64) / 32768
                    h['ls'] //= 2; h['ll'] //= 2
                else:
                    a = np.frombuffer(raw, dtype='<i1').astype(np.int64)
                    a = ((np.cumsum(a) + 128) & 0xFF) - 128
                    a = a.astype(np.float64) / 128
                h['data'] = a
                h['loop'] = h['type'] & 3          # 0 none, 1 forward, 2 ping-pong
                if h['loop'] and h['ll'] < 2: h['loop'] = 0
                ins['samples'].append(h)
        else:
            off += ih
        m.inst.append(ins)
    return m
