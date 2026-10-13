| SNDH player for the packed YM2149 delta stream.  Position independent, 68000.
| Layout of the blob (no relocation needed):
|   +0  bra.w init   +4  bra.w exit   +8  bra.w play
|   +12 .w nframes   +14 .w loopframes (frames from loop point to the end)   +16 .l loop byte offset
|   +20 .l offset of the digidrum table from the start of the blob (0 = no digidrums)
|   +24 code ... vars ... stream (data appended by the exporter, even aligned) ... drum table
| Stream frame:  A = bit7 'B follows' | mask R0-R6;   B = bit7 'events follow' | mask R7-R13;
|                [timer effect: kind<<4 | voice<<2 | cont (top bits 00), kinds 1-3 + prescaler code + data register]
|                [drum trigger = (voice+1)<<6 | drum (63 = stop)]  then one data byte per mask bit
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
        bsr     fx_init
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

play:   movem.l d0-d7/a0-a3,-(sp)
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
        moveq   #-1,d5                  | d5 = timer effect header, -1 = none
        moveq   #0,d6                   | d6 = effect prescaler code
        moveq   #0,d7                   | d7 = effect data register
        tst.b   d2
        bpl.s   .nob
        moveq   #0,d0
        move.b  (a0)+,d0
        btst    #7,d0
        beq.s   .nt
        moveq   #0,d4
        move.b  (a0)+,d4
        move.w  d4,d2
        and.w   #0xc0,d2
        bne.s   .drumbyte
        move.w  d4,d5                   | timer effect header
        move.w  d5,d2
        and.w   #0x30,d2
        beq.s   .fxnoarg
        move.b  (a0)+,d6
        move.b  (a0)+,d7
.fxnoarg:
        btst    #0,d5
        beq.s   .nt                     | no drum byte behind it
        moveq   #0,d4
        move.b  (a0)+,d4
.drumbyte:
        move.w  d4,d3
.nt:    and.w   #0x7f,d0
        lsl.w   #7,d0
        or.w    d0,d1
.nob:   tst.w   d3                      | a drum 'stop' comes before the register writes ...
        bmi.s   .nostop
        move.w  d3,d4
        and.w   #63,d4
        cmp.w   #63,d4
        bne.s   .nostop
        bsr     drum_stop
.nostop:
        tst.w   d5                      | ... and so does an effect 'stop'
        bmi.s   .nofxstop
        move.w  d5,d2
        and.w   #0x30,d2
        bne.s   .nofxstop
        bsr     fx_stop
.nofxstop:
        move.w  sr,d2                   | register writes must not be interrupted by the timers
        ori.w   #0x0600,sr
        lea     0xffff8800.w,a2
        lea     fx_base(pc),a3
        moveq   #0,d0
.next:  lsr.w   #1,d1
        bcc.s   .skip
        move.b  (a0)+,d4
        cmp.b   #8,d0                   | sync-square: bit 5 of a volume byte (R8-R10) restarts that voice's tone counter
        blo.s   .nosq
        cmp.b   #10,d0
        bhi.s   .nosq
        btst    #5,d4
        beq.s   .nosq
        bsr     sync_sq
        bclr    #5,d4
.nosq:  move.b  d4,FX_SH(a3,d0.w)       | shadow for the timer effects
        cmp.b   FX_SEL(a3),d0           | the voice an effect drives is not ours to write
        beq.s   .skip
        move.b  d0,(a2)
        move.b  d4,2(a2)
.skip:  addq.b  #1,d0
        tst.w   d1
        bne.s   .next
        move.w  d2,sr
        move.l  a0,(a1)
        tst.w   d3                      | ... a drum 'start' after them
        bmi.s   .nodrum
        move.w  d3,d1
        and.w   #63,d1
        cmp.w   #63,d1
        beq.s   .nodrum
        lsr.w   #6,d3
        subq.w  #1,d3
        move.w  d3,d0
        bsr     drum_start
.nodrum:
        tst.w   d5                      | ... and an effect 'start'
        bmi.s   .fin
        move.w  d5,d1
        lsr.w   #4,d1
        and.w   #3,d1
        beq.s   .fin
        move.w  d5,d0
        lsr.w   #2,d0
        and.w   #3,d0
        move.w  d6,d2
        move.w  d7,d3
        bsr     fx_start
.fin:   movem.l (sp)+,d0-d7/a0-a3
        rts

| Restart the square wave of voice d0-8 (d0 = its volume register, a2 = PSG, a3 = fx_base; the period registers of this
| frame are already in the shadow).  The tone counter only toggles when it reaches the period, so a very short period
| written for at least 8 PSG clocks (32 CPU cycles) forces an edge; the real period goes back high byte first so no
| stray short period appears.  STFM only: the STE clocks CPU and PSG apart, so it can miss an edge.
sync_sq:
        movem.l d0/d4,-(sp)
        subq.b  #8,d0
        add.b   d0,d0                   | R(2v) low byte of the period
        moveq   #0,d4
        move.b  d0,(a2)
        move.b  d4,2(a2)
        addq.b  #1,d0
        move.b  d0,(a2)
        move.b  d4,2(a2)                | period 0
        nop
        nop
        nop
        nop
        nop
        nop
        nop
        nop
        move.b  d0,(a2)
        move.b  FX_SH(a3,d0.w),2(a2)    | high nibble back first
        subq.b  #1,d0
        move.b  d0,(a2)
        move.b  FX_SH(a3,d0.w),2(a2)
        movem.l (sp)+,d0/d4
        rts

        .even
        .include "drumeng.s"
        .even
vars:   dc.l 0
        dc.w 0
        .even
stream:
