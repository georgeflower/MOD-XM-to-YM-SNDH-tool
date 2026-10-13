        .text
        bra.w   init
        bra.w   exit
        bra.w   play
        .ascii  "SNDH"
        .ascii  "TITL"
        .asciz  "alt"
        .ascii  "COMM"
        .asciz  "t"
        .ascii  "TC50"
        .byte   0,0
        .ascii  "TIME"
        .word   4
        .ascii  "HDNS"
        .even
YM      = 0xffff8800
init:   movem.l d0/a0,-(sp)
        lea     YM.w,a0
        moveq   #8,d0
1:      move.b  d0,(a0)
        clr.b   2(a0)
        addq.b  #1,d0
        cmp.b   #11,d0
        bne.s   1b
        move.b  #7,(a0)
        move.b  #0xf8,2(a0)         | tones off? keep noise off, tones on
        clr.w   frame
        lea     bisr(pc),a0
        move.l  a0,0x120.w
        lea     aon(pc),a0
        move.l  a0,0x134.w
        lea     disr(pc),a0
        move.l  a0,0x110.w
        movem.l (sp)+,d0/a0
        rts
exit:   rts
play:   movem.l d0-d1/a0-a1,-(sp)
        lea     frame(pc),a0
        move.w  (a0),d0
        addq.w  #1,(a0)
        cmp.w   #3,d0
        bne.s   .n3
        lea     samp(pc),a0         | start the digidrum on Timer B (voice B, /10 * 31 = 7928 Hz)
        lea     ptr(pc),a1
        move.l  a0,(a1)
        move.b  #31,0xfffffa21.w
        move.b  #2,0xfffffa1b.w
        bset    #0,0xfffffa07.w
        bset    #0,0xfffffa13.w
.n3:    cmp.w   #10,d0              | SID voice A on Timer A (/16 * 100 = 1536 Hz)
        bne.s   .n10
        move.b  #100,0xfffffa1f.w
        move.b  #3,0xfffffa19.w
        bset    #5,0xfffffa07.w
        bset    #5,0xfffffa13.w
.n10:   cmp.w   #40,d0
        bne.s   .n40
        clr.b   0xfffffa19.w        | SID off, volume back to 0
        bclr    #5,0xfffffa13.w
        move.b  #8,YM.w
        clr.b   YM+2.w
.n40:   cmp.w   #60,d0              | sync-buzzer on Timer D (/10 * 50 = 4915 Hz)
        bne.s   .n60
        move.b  #50,0xfffffa25.w
        move.b  0xfffffa1d.w,d1
        and.b   #0xf0,d1
        or.b    #2,d1
        move.b  d1,0xfffffa1d.w
        bset    #4,0xfffffa09.w
        bset    #4,0xfffffa15.w
.n60:   cmp.w   #90,d0
        bne.s   .n90
        move.b  0xfffffa1d.w,d1
        and.b   #0xf0,d1
        move.b  d1,0xfffffa1d.w
        bclr    #4,0xfffffa15.w
.n90:   movem.l (sp)+,d0-d1/a0-a1
        rts

| Timer B: one 4-bit sample per interrupt to R9 (movep-less select+data), stops at the end
bisr:   movem.l d0/a0-a1,-(sp)
        lea     ptr(pc),a1
        move.l  (a1),a0
        move.b  (a0)+,d0
        move.l  a0,(a1)
        lea     YM.w,a1
        move.b  #9,(a1)
        move.b  d0,2(a1)
        lea     sampend(pc),a1
        cmp.l   a1,a0
        lea     YM.w,a1
        bne.s   1f
        clr.b   0xfffffa1b.w
        bclr    #0,0xfffffa13.w
        move.b  #9,(a1)
        clr.b   2(a1)
1:      bclr    #0,0xfffffa0f.w
        movem.l (sp)+,d0/a0-a1
        rte
| Timer A: SID, the handler swaps itself between 'on' and 'off'
aon:    move.l  a0,-(sp)
        lea     aoff(pc),a0
        move.l  a0,0x134.w
        move.b  #8,YM.w
        move.b  #11,YM+2.w
        bclr    #5,0xfffffa0f.w
        move.l  (sp)+,a0
        rte
aoff:   move.l  a0,-(sp)
        lea     aon(pc),a0
        move.l  a0,0x134.w
        move.b  #8,YM.w
        clr.b   YM+2.w
        bclr    #5,0xfffffa0f.w
        move.l  (sp)+,a0
        rte
| Timer D: sync-buzzer, rewrites the envelope shape
disr:   move.b  #13,YM.w
        move.b  #12,YM+2.w
        bclr    #4,0xfffffa11.w
        rte
        .even
frame:  dc.w 0
ptr:    dc.l 0
samp:   dc.b 0,3,7,11,15,14,9,4,1,2,6,13,15,12,8,5
        dc.b 3,1,0,4,8,12,14,15,15,13,10,6,3,1,0,2
        dc.b 5,9,12,14,13,10,7,4,2,1,0,1,3,6,9,11
        dc.b 12,10,8,5,3,2,1,2,4,7,9,10,8,5,3,0
sampend:
