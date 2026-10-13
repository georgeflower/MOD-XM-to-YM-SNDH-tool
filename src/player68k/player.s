| SNDH player for the packed YM2149 delta stream.  Position independent, 68000.
| Layout of the blob (no relocation needed):
|   +0  bra.w init   +4  bra.w exit   +8  bra.w play
|   +12 .w nframes   +14 .w loopframes (frames from loop point to the end)   +16 .l loop byte offset
|   +20 code ... vars ... stream (data appended by the exporter, even aligned)
        .text
        .even
blob:
        bra.w   init
        bra.w   exit
        bra.w   play
p_nframes:      dc.w 0
p_loopframes:   dc.w 0
p_loopoff:      dc.l 0

init:   movem.l d0-d1/a0-a2,-(sp)
        lea     vars(pc),a1
        lea     stream(pc),a0
        move.l  a0,(a1)
        move.w  p_nframes(pc),4(a1)
        lea     0xffff8800.w,a2
        moveq   #0,d0
        moveq   #0,d1
.clr:   move.b  d0,(a2)
        move.b  d1,2(a2)
        addq.b  #1,d0
        cmp.b   #14,d0
        bne.s   .clr
        move.b  #7,(a2)
        move.b  #0xff,2(a2)
        movem.l (sp)+,d0-d1/a0-a2
        rts

exit:   move.l  a2,-(sp)
        lea     0xffff8800.w,a2
        move.b  #8,(a2)
        clr.b   2(a2)
        move.b  #9,(a2)
        clr.b   2(a2)
        move.b  #10,(a2)
        clr.b   2(a2)
        move.b  #7,(a2)
        move.b  #0xff,2(a2)
        move.l  (sp)+,a2
        rts

play:   movem.l d0-d2/a0-a2,-(sp)
        lea     vars(pc),a1
        tst.w   4(a1)
        bne.s   .go
        lea     stream(pc),a0
        add.l   p_loopoff(pc),a0
        move.w  p_loopframes(pc),4(a1)
        bra.s   .have
.go:    move.l  (a1),a0
.have:  subq.w  #1,4(a1)
        moveq   #0,d1
        move.b  (a0)+,d1
        move.w  d1,d2
        and.w   #0x7f,d1
        tst.b   d2
        bpl.s   .nob
        moveq   #0,d0
        move.b  (a0)+,d0
        and.w   #0x7f,d0
        lsl.w   #7,d0
        or.w    d0,d1
.nob:   lea     0xffff8800.w,a2
        moveq   #0,d0
.next:  lsr.w   #1,d1
        bcc.s   .skip
        move.b  d0,(a2)
        move.b  (a0)+,2(a2)
.skip:  addq.b  #1,d0
        tst.w   d1
        bne.s   .next
        move.l  a0,(a1)
        movem.l (sp)+,d0-d2/a0-a2
        rts

        .even
vars:   dc.l 0
        dc.w 0
        .even
stream:
