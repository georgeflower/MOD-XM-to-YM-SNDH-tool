| SNDH player for the packed YM2149 delta stream.  Position independent, 68000.
| Layout of the blob (no relocation needed):
|   +0  bra.w init   +4  bra.w exit   +8  bra.w play
|   +12 .w nframes   +14 .w loopframes (frames from loop point to the end)   +16 .l loop byte offset
|   +20 .l offset of the digidrum table from the start of the blob (0 = no digidrums)
|   +24 code ... vars ... stream (data appended by the exporter, even aligned) ... drum table
| Stream frame:  A = bit7 'B follows' | mask R0-R6;   B = bit7 'trigger byte follows' | mask R7-R13;
|                [trigger = (voice+1)<<6 | drum (63 = stop)]  then one data byte per mask bit
        .text
        .even
blob:
        bra.w   init
        bra.w   exit
        bra.w   play
p_nframes:      dc.w 0
p_loopframes:   dc.w 0
p_loopoff:      dc.l 0
p_drumoff:      dc.l 0

init:   movem.l d0-d1/a0-a2,-(sp)
        move.l  p_drumoff(pc),d0
        beq.s   .nodr
        lea     blob(pc),a0
        add.l   d0,a0
        bsr     drum_init
.nodr:
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

exit:   bsr     drum_exit
        move.l  a2,-(sp)
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

play:   movem.l d0-d4/a0-a2,-(sp)
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
        moveq   #-1,d3                  | d3 = drum trigger byte, -1 = none
        tst.b   d2
        bpl.s   .nob
        moveq   #0,d0
        move.b  (a0)+,d0
        btst    #7,d0
        beq.s   .nt
        moveq   #0,d3
        move.b  (a0)+,d3
.nt:    and.w   #0x7f,d0
        lsl.w   #7,d0
        or.w    d0,d1
.nob:   tst.w   d3                      | a 'stop' comes before the register writes ...
        bmi.s   .nostop
        move.w  d3,d4
        and.w   #63,d4
        cmp.w   #63,d4
        bne.s   .nostop
        bsr     drum_stop
.nostop:
        move.w  sr,d2                   | register writes must not be interrupted by the drum timer
        ori.w   #0x0600,sr
        lea     0xffff8800.w,a2
        moveq   #0,d0
.next:  lsr.w   #1,d1
        bcc.s   .skip
        move.b  d0,(a2)
        move.b  (a0)+,2(a2)
.skip:  addq.b  #1,d0
        tst.w   d1
        bne.s   .next
        move.w  d2,sr
        move.l  a0,(a1)
        tst.w   d3                      | ... a 'start' after them
        bmi.s   .fin
        move.w  d3,d1
        and.w   #63,d1
        cmp.w   #63,d1
        beq.s   .fin
        lsr.w   #6,d3
        subq.w  #1,d3
        move.w  d3,d0
        bsr     drum_start
.fin:   movem.l (sp)+,d0-d4/a0-a2
        rts

        .even
        .include "drumeng.s"
        .even
vars:   dc.l 0
        dc.w 0
        .even
stream:
