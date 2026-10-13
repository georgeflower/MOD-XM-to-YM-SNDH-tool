"""Tick-accurate FastTracker II replayer (just enough of it): produces, for every 50 Hz frame, the
sounding state of every XM channel (instrument, real pitch, loudness, drum age)."""
import math
import numpy as np
import samples as smp
smp_ended = smp.ended

FPS = 50


def period_of(note_plus_rel, fine):
    """Linear-frequency XM period for a (0-based) note index incl. relative note, finetune in 1/128 st."""
    return 7680 - note_plus_rel * 64 - fine / 2.0


def rate_of(period):
    return 8363.0 * 2.0 ** ((4608.0 - period) / 768.0)


VIB_SINE = [math.sin(2 * math.pi * i / 64) for i in range(64)]


class Ch:
    def __init__(self):
        self.inst = 0
        self.smp = None
        self.note = 0           # 1-based XM note incl. no rel
        self.period = 0.0       # incl. portamento
        self.base_period = 0.0
        self.vol = 0
        self.env_tick = 0
        self.fade = 32768
        self.keyoff = False
        self.pos = 0.0
        self.active = False
        self.age = 0            # ticks since trigger
        self.porta = 0
        self.vslide = 0
        self.vib_speed = 0
        self.vib_depth = 0
        self.vib_pos = 0
        self.arp = 0
        self.av_pos = 0
        self.av_amp = 0.0
        self.trig_vol = 0


def env_value(ins, tick, keyoff):
    pts = ins['venv']
    if not (ins['vflags'] & 1) or not pts:
        return 64.0
    # sustain / loop handling is done by the caller by clamping the tick
    for k in range(len(pts) - 1):
        x0, y0 = pts[k]; x1, y1 = pts[k + 1]
        if x0 <= tick <= x1:
            return y0 if x1 == x0 else y0 + (y1 - y0) * (tick - x0) / (x1 - x0)
    return pts[-1][1]


def play(m, info, arp_order='xy', max_ticks=200000, log=print):
    """info[inst_index] = analysis dict {'cls','cycle'} for the first sample of the instrument.
    Returns (frames, order_frame) ; frames[f] = list over channels of None | dict."""
    nch = m.nch
    ch = [Ch() for _ in range(nch)]
    speed, bpm = m.tempo, m.bpm
    order_i, row_i = 0, 0
    frames = []
    order_frame = {}
    tclock = 0.0                      # start time of current tick
    next_frame = 0
    warn = {}
    arp_seq = (0, 1, 2) if arp_order == 'xy' else (0, 2, 1)

    def tick_state(c, t):
        """snapshot of the channel for the frame being emitted"""
        if not c.active or c.smp is None:
            return None
        ins = m.inst[c.inst]
        s = c.smp
        inf = info[(c.inst, c.keysmp)]
        per = c.period
        # auto vibrato
        if ins['vib'][2] > 0:
            wave = 1 if (c.av_pos & 128) == 0 else -1  # square (type 1) - sine for type 0 below
            vt = ins['vib'][0]
            if vt == 0:
                wave = math.sin(2 * math.pi * (c.av_pos & 255) / 256)
            elif vt == 2:
                wave = 1 - 2 * ((c.av_pos & 255) / 255)
            elif vt == 3:
                wave = -1 + 2 * ((c.av_pos & 255) / 255)
            per = per - wave * c.av_amp * 4          # delta in 1/64 semitone units
        if c.vib_depth and c.vib_speed:
            per = per + VIB_SINE[c.vib_pos & 63] * c.vib_depth * 4
        arpoff = 0
        if c.arp:
            x, y = (c.arp >> 4) & 15, c.arp & 15
            arpoff = (0, x, y)[arp_seq[t % 3]]
        per_eff = per - arpoff * 64
        rate = rate_of(per_eff)
        v = c.vol / 64.0
        v *= env_value(ins, c.env_tick, c.keyoff) / 64.0
        v *= c.fade / 32768.0
        return dict(inst=c.inst, ksmp=c.keysmp, cls=inf['cls'], period=per_eff, rate=rate, vol=v,
                    age=c.age, pos=c.pos, cycle=inf['cycle'], smp=s)

    done = False
    ticks = 0
    jump_order = None
    while not done and ticks < max_ticks:
        if row_i == 0 and order_i not in order_frame:
            order_frame[order_i] = next_frame
        if order_i >= m.songlen:
            break
        pat = m.pats[m.order[order_i]]
        row = pat[row_i]
        tick = 0
        brk_row = None
        pos_jump = None
        while tick < speed:
            dt = 2.5 / bpm
            for ci in range(nch):
                c = ch[ci]
                note, inst, vcol, eff, par = row[ci]
                if tick == 0:
                    # ---- row data ----
                    if inst:
                        if inst < len(m.inst) and m.inst[inst]['samples']:
                            c.inst = inst
                            if not (note and note < 97):      # inst w/o note: reset vol/env only
                                if c.smp is not None:
                                    c.vol = c.smp['vol']; c.env_tick = 0; c.fade = 32768; c.keyoff = False
                    if note and note < 97:
                        ins = m.inst[c.inst] if c.inst else None
                        if ins and ins['samples']:
                            ks = ins['keymap'][note - 1]
                            if ks >= len(ins['samples']): ks = 0
                            s = ins['samples'][ks]
                            c.smp, c.keysmp = s, ks
                            c.note = note
                            nn = note - 1 + s['rel']
                            c.base_period = c.period = period_of(nn, s['fine'])
                            c.vol = s['vol']; c.env_tick = 0; c.fade = 32768; c.keyoff = False
                            c.pos = 0.0; c.active = True; c.age = 0
                            c.vib_pos = 0; c.av_pos = 0; c.av_amp = 0.0
                        else:
                            c.active = False
                    elif note == 97:
                        c.keyoff = True
                        if c.inst and not (m.inst[c.inst]['vflags'] & 1):
                            c.vol = 0
                    # volume column
                    if 0x10 <= vcol <= 0x50:
                        c.vol = vcol - 0x10
                    elif vcol:
                        warn['volcol%02X' % (vcol >> 4)] = warn.get('volcol%02X' % (vcol >> 4), 0) + 1
                    # effects at tick 0
                    if eff == 0x0:
                        c.arp = par
                    else:
                        c.arp = 0
                    if eff in (1, 2):
                        if par: c.porta = par
                    if eff == 4:
                        if par >> 4: c.vib_speed = par >> 4
                        if par & 15: c.vib_depth = par & 15
                    elif eff != 4:
                        c.vib_depth_active = False
                    if eff == 0xA:
                        if par: c.vslide = par
                    if eff == 0xC:
                        c.vol = min(64, par)
                    if eff == 0xF:
                        if par == 0:
                            pass
                        elif par < 32:
                            speed = par
                        else:
                            bpm = par
                    if eff == 0xB:
                        pos_jump = par
                    if eff == 0xD:
                        brk_row = (par >> 4) * 10 + (par & 15)
                    if eff not in (0, 1, 2, 4, 0xA, 0xC, 0xF, 0xB, 0xD, 3, 5, 6, 7, 9) and eff:
                        warn['eff%X' % eff] = warn.get('eff%X' % eff, 0) + 1
                    # remember the vibrato state of this row (cleared when no 4xy and no vib-continue)
                    c._row_vib = (eff == 4)
                    c._row_eff = eff
                    c._row_par = par
                else:
                    # ---- per-tick effects ----
                    eff = c._row_eff
                    par = c._row_par
                    if eff == 1:
                        c.period -= 4 * c.porta
                    elif eff == 2:
                        c.period += 4 * c.porta
                    elif eff == 0xA:
                        x, y = c.vslide >> 4, c.vslide & 15
                        if x: c.vol = min(64, c.vol + x)
                        elif y: c.vol = max(0, c.vol - y)
                    if eff == 4:
                        c.vib_pos = (c.vib_pos + c.vib_speed) & 63
                # ---- every tick ----
                if not getattr(c, '_row_vib', False) and tick == 0:
                    pass
            # emit frames covering [tclock, tclock+dt)
            snap = []
            for ci in range(nch):
                c = ch[ci]
                vib_on = getattr(c, '_row_vib', False)
                saved = (c.vib_depth, c.vib_speed)
                if not vib_on:
                    c.vib_depth = 0
                snap.append(tick_state(c, tick))
                c.vib_depth, c.vib_speed = saved
            while next_frame / FPS < tclock + dt - 1e-9:
                if next_frame / FPS >= tclock - 1e-9:
                    frames.append(snap)
                    next_frame += 1
                else:
                    next_frame += 1
            # ---- advance channel state to the next tick ----
            for ci in range(nch):
                c = ch[ci]
                if not c.active or c.smp is None:
                    continue
                ins = m.inst[c.inst]
                c.pos += rate_of(c.period) * dt
                c.age += 1
                if smp_ended(c.smp, c.pos):
                    pass
                # volume envelope
                if ins['vflags'] & 1 and ins['venv']:
                    pts = ins['venv']
                    sus_tick = pts[ins['vsus']][0] if (ins['vflags'] & 2 and ins['vsus'] < len(pts)) else None
                    if sus_tick is not None and not c.keyoff and c.env_tick >= sus_tick:
                        c.env_tick = sus_tick
                    else:
                        c.env_tick += 1
                        if ins['vflags'] & 4 and ins['vle'] < len(pts):
                            le = pts[ins['vle']][0]
                            if c.env_tick > le and not (sus_tick is not None and not c.keyoff):
                                c.env_tick = pts[ins['vls']][0]
                if c.keyoff and ins['fade']:
                    c.fade = max(0, c.fade - ins['fade'])
                # auto vibrato ramp
                vt, vs, vd, vr = ins['vib']
                if vd:
                    c.av_pos = (c.av_pos + vr) & 255
                    c.av_amp = min(float(vd), c.av_amp + (vd / max(1, vs)))
            tclock += dt
            tick += 1
            ticks += 1
            if tick == speed:
                pass
        # next row
        if pos_jump is not None:
            order_i = pos_jump; row_i = brk_row or 0
        elif brk_row is not None:
            order_i += 1; row_i = brk_row
        else:
            row_i += 1
            if row_i >= len(pat):
                order_i += 1; row_i = 0
    # clean: remove the 'smp' arrays? keep (needed by the voice builder)
    for k, v in warn.items():
        log(f'  note: unhandled XM feature {k} x{v}')
    return frames, order_frame
