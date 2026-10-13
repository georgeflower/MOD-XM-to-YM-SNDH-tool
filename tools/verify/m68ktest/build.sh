#!/bin/sh
# CPU conformance test tunes (position independent). Needs m68k-linux-gnu-gcc.   ./build.sh [outdir]
cd "$(dirname "$0")"
OUTDIR=${1:-.}
python3 gen_alu.py >/dev/null
for variant in alu mix; do
  DEF=""; [ "$variant" = mix ] && DEF="-DMODE_MIX"
  m68k-linux-gnu-gcc -m68000 -mpcrel -O${OPT:-1} $DEF -ffreestanding -fno-builtin -fno-stack-protector -nostdlib -nostartfiles -static \
    -Wl,-T,link.ld -Wl,--oformat=binary -o "$OUTDIR/m68k_$variant.sndh" start.S m68ktest.c
done
