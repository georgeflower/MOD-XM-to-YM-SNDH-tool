#!/usr/bin/env python3
"""Verify an SNDH against a .regs dump by running it in psgplay's 68000 core and comparing the YM2149
register writes, frame by frame.   usage: sndh_check.py PSGPLAY x.sndh x.regs
psgplay: github.com/frno7/psgplay (if --trace aborts, build with CC='gcc -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0').
Frames that change no register produce no write burst; they are recovered from the 50 Hz timestamps."""
import re, subprocess, sys

psgplay, sndh, regsf = sys.argv[1:4]
loop = int(sys.argv[4]) if len(sys.argv) > 4 else None     # loop frame: also check the wrap-around
ref = open(regsf, 'rb').read(); n = len(ref) // 14
out = subprocess.run([psgplay, '--trace=psg', sndh], capture_output=True, text=True, timeout=900).stdout
P = 160425.0                                   # CPU cycles per 50 Hz tick (8021247 Hz / 50)
sel = 0; cur = [0] * 16
bursts = []                                    # [start_time, snapshot after burst]
last = None
for line in out.splitlines():
    m = re.match(r'psg\s+(\d+)\s+ff88(0[02]):\s+wr\s+u(8|16)\s+([0-9a-f]+)', line)
    if not m or m[3] == '16': continue
    t, port, v = int(m[1]), m[2], int(m[4], 16)
    if last is None or t - last > 20000: bursts.append([t, None])
    last = t
    if port == '00': sel = v & 15
    else: cur[sel] = v
    bursts[-1][1] = list(cur)
init, play = bursts[0], bursts[1:]
t0 = play[0][0]
at = {round((t - t0) / P): snap for t, snap in play}
img = None; bad = 0; first = None; frames = max(at) + 1 if loop is not None else min(n, max(at) + 1)
for f in range(frames):
    if f in at: img = at[f]
    g = f if f < n else loop + (f - n) % (n - loop)
    if bytes(img[:14]) != ref[g * 14:g * 14 + 14]:
        bad += 1
        if first is None:
            first = f
            print('first diff: got', bytes(img[:14]).hex(' '), '\n           exp', ref[f*14:f*14+14].hex(' '), '\n   prev exp', ref[(f-1)*14:f*14].hex(' '))
print(f'{sndh}: {frames} frames compared against {regsf}, {bad} differ' + (f' (first at frame {first})' if first is not None else ''))
sys.exit(1 if bad else 0)
