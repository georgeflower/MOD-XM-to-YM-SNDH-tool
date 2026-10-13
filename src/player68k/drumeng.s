| drumeng.s - YM2149 digidrum engine for the Atari ST.
| A 4-bit sample is played by writing one byte per MFP Timer D interrupt into a voice's volume register
| (the mixer bits of that voice must have tone and noise disabled; the register stream takes care of that).
| Position independent, 68000, supervisor mode.  Included by player.s (SNDH) and gamedrum.s (game kit).
|
| Drum table (big endian):  dc.w count
|    count entries of 8 bytes:  dc.l pcm offset from the start of the table
|                               dc.w length in samples
|                               dc.b MFP prescaler code (1..7)   dc.b MFP data register (1..255)
|    then the PCM bytes (values 0..15)
|
| drum_init   a0 = table      save MFP state, install the Timer D vector
| drum_exit                   stop, restore MFP state and vector
| drum_start  d0.w = voice 0..2, d1.w = drum index     (cuts a drum that is still playing)
| drum_stop                   stop the drum and silence its voice
| All of them preserve every register.

V_SEL   = 8
V_ACT   = 9
V_INST  = 10
V_IERB  = 11
V_IMRB  = 12
V_TCDCR = 13
V_TDDR  = 14
V_TAB   = 16
V_VEC   = 20

        .even
dv_ptr: dc.l 0                  | 0   next sample
dv_end: dc.l 0                  | 4   end of sample
dv_sel: dc.b 8                  | 8   YM register select value of the drum voice (8 + voice)
dv_act: dc.b 0                  | 9   a drum is playing
dv_inst:dc.b 0                  | 10  MFP state saved / vector installed
dv_ierb:dc.b 0                  | 11
dv_imrb:dc.b 0                  | 12
dv_tcdcr:dc.b 0                 | 13
dv_tddr:dc.b 0                  | 14
        dc.b 0
dv_tab: dc.l 0                  | 16
dv_vec: dc.l 0                  | 20

| timer D off, interrupt masked and cleared (IPL must be 7)
drum_timer_off:
        and.b   #0xf8,0xfffffa1d.w
        bclr    #4,0xfffffa15.w
        bclr    #4,0xfffffa0d.w
        rts

| a1 = dv_ptr, IPL 7: stop the timer, silence the voice of a running drum
drum_stop_core:
        bsr   drum_timer_off
        tst.b   V_ACT(a1)
        beq.s   .dr_stop_core_z
        clr.b   V_ACT(a1)
        move.b  V_SEL(a1),0xffff8800.w
        clr.b   0xffff8802.w
.dr_stop_core_z:     rts

drum_init:
        movem.l d0/a0-a1,-(sp)
        lea     dv_ptr(pc),a1
        move.l  a0,V_TAB(a1)
        tst.b   V_INST(a1)
        bne.s   .dr_init_have
        move.b  #1,V_INST(a1)
        move.l  0x110.w,V_VEC(a1)
        move.b  0xfffffa09.w,V_IERB(a1)
        move.b  0xfffffa15.w,V_IMRB(a1)
        move.b  0xfffffa1d.w,V_TCDCR(a1)
        move.b  0xfffffa25.w,V_TDDR(a1)
.dr_init_have:  move.w  sr,-(sp)
        ori.w   #0x0700,sr
        bsr   drum_timer_off
        clr.b   V_ACT(a1)
        lea     drum_isr(pc),a0
        move.l  a0,0x110.w
        move.w  (sp)+,sr
        movem.l (sp)+,d0/a0-a1
        rts

drum_exit:
        movem.l d0-d1/a1,-(sp)
        lea     dv_ptr(pc),a1
        tst.b   V_INST(a1)
        beq.s   .dr_exit_out
        move.w  sr,-(sp)
        ori.w   #0x0700,sr
        bsr   drum_stop_core
        move.l  V_VEC(a1),0x110.w
        move.b  V_IERB(a1),d0
        and.b   #0x10,d0
        bclr    #4,0xfffffa09.w
        or.b    d0,0xfffffa09.w
        move.b  V_IMRB(a1),d0
        and.b   #0x10,d0
        bclr    #4,0xfffffa15.w
        or.b    d0,0xfffffa15.w
        move.b  V_TDDR(a1),0xfffffa25.w
        move.b  V_TCDCR(a1),d0
        and.b   #7,d0
        move.b  0xfffffa1d.w,d1
        and.b   #0xf8,d1
        or.b    d0,d1
        move.b  d1,0xfffffa1d.w
        clr.b   V_INST(a1)
        move.w  (sp)+,sr
.dr_exit_out:   movem.l (sp)+,d0-d1/a1
        rts

drum_stop:
        movem.l a1,-(sp)
        lea     dv_ptr(pc),a1
        move.w  sr,-(sp)
        ori.w   #0x0700,sr
        bsr   drum_stop_core
        move.w  (sp)+,sr
        movem.l (sp)+,a1
        rts

drum_start:
        movem.l d0-d3/a0-a1,-(sp)
        lea     dv_ptr(pc),a1
        tst.b   V_INST(a1)
        beq.s   .dr_start_out
        move.l  V_TAB(a1),d2
        beq.s   .dr_start_out
        move.w  sr,-(sp)
        ori.w   #0x0700,sr
        bsr   drum_stop_core
        move.l  d2,a0
        cmp.w   (a0),d1
        bcc.s   .dr_start_done
        lsl.w   #3,d1
        lea     2(a0,d1.w),a0
        move.l  (a0),d3
        add.l   d2,d3
        move.l  d3,(a1)
        moveq   #0,d1
        move.w  4(a0),d1
        add.l   d1,d3
        move.l  d3,4(a1)
        addq.b  #8,d0
        move.b  d0,V_SEL(a1)
        move.b  #1,V_ACT(a1)
        move.b  7(a0),0xfffffa25.w
        move.b  0xfffffa1d.w,d1
        and.b   #0xf8,d1
        or.b    6(a0),d1
        move.b  d1,0xfffffa1d.w
        bset    #4,0xfffffa09.w
        bset    #4,0xfffffa15.w
.dr_start_done:  move.w  (sp)+,sr
.dr_start_out:   movem.l (sp)+,d0-d3/a0-a1
        rts

| Timer D interrupt: next sample -> volume register
drum_isr:
        movem.l d0/a0-a1,-(sp)
        lea     dv_ptr(pc),a0
        move.l  (a0),a1
        cmp.l   4(a0),a1
        bcc.s   .dr_isr_end
        moveq   #0,d0
        move.b  (a1)+,d0
        move.l  a1,(a0)
        move.b  V_SEL(a0),0xffff8800.w
        move.b  d0,0xffff8802.w
        bra.s   .dr_isr_eoi
.dr_isr_end:   move.b  V_SEL(a0),0xffff8800.w
        clr.b   0xffff8802.w
        clr.b   V_ACT(a0)
        and.b   #0xf8,0xfffffa1d.w
        bclr    #4,0xfffffa15.w
.dr_isr_eoi:   bclr    #4,0xfffffa11.w
        movem.l (sp)+,d0/a0-a1
        rte
