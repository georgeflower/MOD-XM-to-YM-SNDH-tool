| SNDH wrapper that plays a .MYS / .MYV pair through gwEm's maxYMiser replayer (MYM_REPL.BIN, not part of this repo).
| Same job as MULTSNDH.S in the maxYMiser package, for a single tune; see tools/verify/maxymiser/oracle.sh.
        .text
        bra.w   init
        bra.w   exit
        bra.w   inter
        .ascii  "SNDH"
        .ascii  "TITL"
        .asciz  "mym"
        .ascii  "COMM"
        .asciz  "t"
        .ascii  "TC200"
        .byte   0
        .ascii  "TIME"
        .word   60
        .ascii  "HDNS"
        .even
init:   movem.l d1/a0-a1,-(sp)
        lea     voicecell(pc),a0
        move.l  #voice-voicecell,(a0)+
        move.l  #song-songcell,(a0)+
        move.l  #songend-song,(a0)
        lea     ref(pc),a1
        add.l   #song-ref+22,a1
        moveq   #0,d1
        move.b  (a1),d1
        lea     hz(pc),a0
        move.w  d1,(a0)
        move.w  #200,2(a0)
        movem.l (sp)+,d1/a0-a1
        bra.w   repl+0
ref:
exit:   clr.w   hz
        bra.w   repl+4
inter:  movem.l a0/d0,-(sp)
        lea     cnt(pc),a0
        move.w  hz(pc),d0
        sub.w   d0,(a0)
        bgt.s   1f
        add.w   #200,(a0)
        movem.l (sp)+,a0/d0
        bra.w   repl+8
1:      movem.l (sp)+,a0/d0
        rts
hz:     .word   0
cnt:    .word   200
repl:   .incbin "MYM_REPL.BIN"
voicecell: .long 0
songcell:  .long 0
songlen:   .long 0
voice:  .incbin "VOICE.MYV"
song:   .incbin "SONG.MYS"
songend:
