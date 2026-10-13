#!/bin/sh
# Wraps a .MYS/.MYV pair into an SNDH with the real maxYMiser replayer so the registers it produces can be compared with ours.
# usage: oracle.sh MYM_REPL.BIN song.mys voice.myv out.sndh     (needs m68k-linux-gnu-as and -ld)
# MYM_REPL.BIN comes with the maxYMiser package (gwEm, free to use); it is deliberately not stored in this repository.
set -e
D=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d)
cp "$D/wrap.s" "$T/"; cp "$1" "$T/MYM_REPL.BIN"; cp "$2" "$T/SONG.MYS"; cp "$3" "$T/VOICE.MYV"
(cd "$T" && m68k-linux-gnu-as -m68000 --register-prefix-optional -o w.o wrap.s && m68k-linux-gnu-ld -e 0 -Ttext=0 --oformat=binary -o w.bin w.o)
cp "$T/w.bin" "$4"; rm -rf "$T"
