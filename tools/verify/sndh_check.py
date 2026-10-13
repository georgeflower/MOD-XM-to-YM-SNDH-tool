#!/usr/bin/env python3
"""Verify an SNDH against a .regs dump by running it in psgplay's 68000 core and comparing the YM2149
register writes, frame by frame.   usage: sndh_check.py PSGPLAY x.sndh x.regs
psgplay: github.com/frno7/psgplay (if --trace aborts, build with CC='gcc -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0').
Frames that change no register produce no write burst; they are recovered from the 50 Hz timestamps."""
import os, re, subprocess, sys

psgplay, sndh, regsf = sys.argv[1:4]
args = [a for a in sys.argv[4:] if not a.startswith('--')]
loop = int(args[0]) if args else None                       # loop frame: also check the wrap-around
no_init = '--no-init-writes' in sys.argv                    # the init routine itself does not touch the PSG
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
init, play = (None, bursts) if no_init else (bursts[0], bursts[1:])
t0 = play[0][0]
gaps = [b[0] - a[0] for a, b in zip(play, play[1:])]
if len(play) > 200 and all(abs(g - P) < P * 0.25 for g in gaps):          # every frame wrote: measure the tick exactly
    P = (play[-1][0] - play[0][0]) / (len(play) - 1)
at = {round((t - t0) / P): snap for t, snap in play}
dump = [a for a in sys.argv if a.startswith('--dump=')]
dumped = bytearray()
img = None; bad = 0; first = None; fails = []; frames = max(at) + 1 if loop is not None else min(n, max(at) + 1)
for f in range(frames):
    if f in at: img = at[f]
    g = f if f < n else loop + (f - n) % (n - loop)
    want = ref[g * 14:g * 14 + 14]
    dumped += bytes(img[:14])
    got = bytes(img[:14])
    got = got[:7] + bytes([got[7] | 0xc0]) + got[8:]; want = want[:7] + bytes([want[7] | 0xc0]) + want[8:]   # R7 bits 6/7 are forced on by the importer
    if want[13] == 0xFF: got = got[:13]; want = want[:13]          # 0xFF = R13 not written this frame
    if got != want:
        bad += 1
        fails.append(f)
        if bad <= 12 or str(f) in os.environ.get('SHOW', '').split(','): print(f'frame {f}: got', got.hex(' '), ' exp', want.hex(' '))
        if first is None:
            first = f
            print('first diff: got', got.hex(' '), '\n           exp', ref[f*14:f*14+14].hex(' '), '\n   prev exp', ref[(f-1)*14:f*14].hex(' '))
print(f'{sndh}: {frames} frames compared against {regsf}, {bad} differ' + (f' (first at frame {first})' if first is not None else ''))
if dump: open(dump[0][7:], 'wb').write(bytes(dumped))
import os
if fails and os.environ.get('NT'):
    nt = int(os.environ['NT']); names = open(os.environ['NAMES']).read().split('\n') if os.environ.get('NAMES') else []
    from collections import Counter
    cnt = Counter(f % nt for f in fails)
    stable = [f for f in fails if f < fails[0] + 1 or True]
    print('  failing frames (first 40):', fails[:40])
    worst = [(k, c) for k, c in sorted(cnt.items(), key=lambda kc: -kc[1])][:12]
    for k, c in worst:
        print(f'  test {k} {names[k] if k < len(names) else ""}: {c} failing frame(s)')
sys.exit(1 if bad else 0)
