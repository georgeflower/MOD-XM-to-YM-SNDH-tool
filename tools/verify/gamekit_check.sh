#!/bin/sh
# End-to-end check of the generated game kit: compiles song.h + ymplay.h with the 68000 gcc into an SNDH wrapper,
# runs it in psgplay and compares the PSG writes with the register dump.
#   usage: tools/verify/gamekit_check.sh PSGPLAY WORKDIR      (needs m68k-linux-gnu-gcc/as/ld/objcopy, npx tsx)
set -e
PSGPLAY=$(readlink -f "$1"); W=$(readlink -f "$2"); mkdir -p "$W"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
(cd "$ROOT" && npx tsx scripts/gamekit-test.ts "$W")
cat > "$W/main.c" <<'C'
#include "song.h"
#include "ymplay.h"
void sndh_init(void) { ymdrum_init(song_drums); ymplay_start(song_data, SONG_FRAMES, SONG_LOOP_FRAME, SONG_LOOP_OFFSET); }
void sndh_play(void) { ymplay_step(); ymplay_write(); }
void sndh_exit(void) { ymdrum_exit(); }
C
cat > "$W/crt.s" <<'S'
        .text
        bra.w sndh_init
        bra.w sndh_exit
        bra.w sndh_play
S
cd "$W"
m68k-linux-gnu-as -m68000 -o crt.o crt.s
m68k-linux-gnu-gcc -m68000 -O2 -ffreestanding -fno-pic -fno-pie -fno-asynchronous-unwind-tables -fno-zero-initialized-in-bss -Wall -Wno-unused-function -I. -c main.c -o main.o
m68k-linux-gnu-ld -N -Ttext=0x80000 -e 0 -o img.elf crt.o main.o
m68k-linux-gnu-objcopy -O binary img.elf img.bin
cat > stub.s <<'S'
        .text
        bra.w   s_init
        bra.w   s_exit
        bra.w   s_play
        .ascii  "SNDH"
        .ascii  "TITL"
        .asciz  "gamekit"
        .ascii  "COMM"
        .asciz  "test"
        .ascii  "TC50"
        .byte   0,0
        .ascii  "TIME"
        .word   12
        .ascii  "HDNS"
        .even
s_init: movem.l d0-d7/a0-a6,-(sp)
        lea     img(pc),a0
        move.l  #0x80000,a1
        move.w  #(imgend-img)/4-1,d0
1:      move.l  (a0)+,(a1)+
        dbra    d0,1b
        jsr     0x80000
        movem.l (sp)+,d0-d7/a0-a6
        rts
s_exit: movem.l d0-d7/a0-a6,-(sp)
        jsr     0x80004
        movem.l (sp)+,d0-d7/a0-a6
        rts
s_play: movem.l d0-d7/a0-a6,-(sp)
        jsr     0x80008
        movem.l (sp)+,d0-d7/a0-a6
        rts
        .even
img:    .incbin "img4.bin"
imgend:
S
python3 -c "d=open('img.bin','rb').read(); open('img4.bin','wb').write(d+b'\\0'*(-len(d)%4))"
m68k-linux-gnu-as -m68000 --register-prefix-optional -o stub.o stub.s
m68k-linux-gnu-objcopy -O binary -j .text stub.o gamekit.sndh
ls -l gamekit.sndh
echo "stream/regs expected:"; ls -l expected.txt
