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
|
| Timer effects (Q/S/U): MFP Timer A drives the volume register of one voice (SID voice: toggles between the voice's
| volume and 0; sinus-SID: 64-step table, the first 32 a rectified sine scaled by the volume) or rewrites the envelope shape
| register R13 (sync-buzzer).  The engine reads the voice volume / shape from a shadow of R0..R15 (fx_sh) that the host
| keeps up to date, and the host must not write the volume register of the voice that fx_sel names (0xff = none).
| fx_init            clear state          fx_exit            stop, restore MFP state and vector
| fx_start  d0.w voice 0..2, d1.w kind 1 SID / 2 sinus / 3 sync, d2.w prescaler code, d3.w data register
| fx_stop            stop, put the shadow volume back on the chip
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
        bsr     fx_exit
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


| ------------------------------------------------------------------ timer effects (Timer A)
FX_KIND = 0
FX_SEL  = 1
FX_TOG  = 2
FX_IDX  = 3
FX_INST = 4
FX_IERA = 5
FX_IMRA = 6
FX_TACR = 7
FX_TADR = 8
FX_VEC  = 12
FX_SH   = 16

        .even
fx_base:
        dc.b 0,0xff,0,0,0,0,0,0,0,0,0,0     | 0..11   kind sel tog idx inst iera imra tacr tadr
        dc.l 0                              | 12      saved vector $134
fx_sh:  .fill 16,1,0                        | 16      shadow of the YM registers R0..R15
fx_sin: dc.b 0,3,6,8,11,12,14,15,15,15,14,12,11,8,6,3
        dc.b 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .even

fx_init:
        movem.l a0,-(sp)
        lea     fx_base(pc),a0
        clr.b   FX_KIND(a0)
        move.b  #0xff,FX_SEL(a0)
        clr.b   FX_TOG(a0)
        clr.b   FX_INST(a0)
        movem.l (sp)+,a0
        rts

| a0 = fx_base, IPL 7: stop the timer, give the voice back (clobbers d4)
fx_stop_core:
        and.b   #0xf0,0xfffffa19.w
        bclr    #5,0xfffffa13.w
        bclr    #5,0xfffffa0b.w
        moveq   #0,d4
        move.b  FX_SEL(a0),d4
        cmp.b   #0xff,d4
        beq.s   .fx_sc_done
        move.b  d4,0xffff8800.w
        move.b  FX_SH(a0,d4.w),0xffff8802.w
.fx_sc_done:
        move.b  #0xff,FX_SEL(a0)
        clr.b   FX_KIND(a0)
        rts

fx_stop:
        movem.l d4/a0,-(sp)
        lea     fx_base(pc),a0
        move.w  sr,-(sp)
        ori.w   #0x0700,sr
        bsr     fx_stop_core
        move.w  (sp)+,sr
        movem.l (sp)+,d4/a0
        rts

fx_start:
        movem.l d0-d4/a0-a1,-(sp)
        lea     fx_base(pc),a0
        move.w  sr,-(sp)
        ori.w   #0x0700,sr
        tst.b   FX_INST(a0)
        bne.s   .fx_st_have
        move.b  #1,FX_INST(a0)
        move.l  0x134.w,FX_VEC(a0)
        move.b  0xfffffa07.w,FX_IERA(a0)
        move.b  0xfffffa13.w,FX_IMRA(a0)
        move.b  0xfffffa19.w,FX_TACR(a0)
        move.b  0xfffffa1f.w,FX_TADR(a0)
.fx_st_have:
        lea     fx_isr(pc),a1
        move.l  a1,0x134.w
        bsr     fx_stop_core
        move.b  d1,FX_KIND(a0)
        clr.b   FX_TOG(a0)
        clr.b   FX_IDX(a0)
        cmp.b   #3,d1
        beq.s   .fx_st_sync
        addq.b  #8,d0
        move.b  d0,FX_SEL(a0)
.fx_st_sync:
        move.b  d3,0xfffffa1f.w
        move.b  0xfffffa19.w,d4
        and.b   #0xf0,d4
        or.b    d2,d4
        move.b  d4,0xfffffa19.w
        bset    #5,0xfffffa07.w
        bset    #5,0xfffffa13.w
        move.w  (sp)+,sr
        movem.l (sp)+,d0-d4/a0-a1
        rts

fx_exit:
        movem.l d0-d1/d4/a0,-(sp)
        lea     fx_base(pc),a0
        tst.b   FX_INST(a0)
        beq.s   .fx_ex_out
        move.w  sr,-(sp)
        ori.w   #0x0700,sr
        bsr     fx_stop_core
        move.l  FX_VEC(a0),0x134.w
        move.b  FX_IERA(a0),d0
        and.b   #0x20,d0
        bclr    #5,0xfffffa07.w
        or.b    d0,0xfffffa07.w
        move.b  FX_IMRA(a0),d0
        and.b   #0x20,d0
        bclr    #5,0xfffffa13.w
        or.b    d0,0xfffffa13.w
        move.b  FX_TADR(a0),0xfffffa1f.w
        move.b  FX_TACR(a0),d0
        and.b   #0x0f,d0
        move.b  0xfffffa19.w,d1
        and.b   #0xf0,d1
        or.b    d0,d1
        move.b  d1,0xfffffa19.w
        clr.b   FX_INST(a0)
        move.w  (sp)+,sr
.fx_ex_out:
        movem.l (sp)+,d0-d1/d4/a0
        rts

| Timer A interrupt
fx_isr:
        movem.l d0-d2/a0-a1,-(sp)
        lea     fx_base(pc),a0
        move.b  FX_KIND(a0),d1
        cmp.b   #3,d1
        beq.s   .fx_isr_sync
        moveq   #0,d0
        move.b  FX_SEL(a0),d0
        cmp.b   #0xff,d0
        beq.s   .fx_isr_eoi
        moveq   #0,d1
        move.b  FX_SH(a0,d0.w),d1         | the voice's volume register
        btst    #4,d1
        beq.s   .fx_isr_v
        moveq   #15,d1                    | hardware envelope: full level
        bra.s   .fx_isr_h
.fx_isr_v:
        and.w   #15,d1
.fx_isr_h:
        cmp.b   #2,FX_KIND(a0)
        beq.s   .fx_isr_sin
        eori.b  #1,FX_TOG(a0)             | SID: every tick toggles V / 0
        bne.s   .fx_isr_put
        moveq   #0,d1
        bra.s   .fx_isr_put
.fx_isr_sin:
        moveq   #0,d2
        move.b  FX_IDX(a0),d2
        addq.b  #1,d2
        and.b   #63,d2
        move.b  d2,FX_IDX(a0)
        cmp.b   #32,d2
        bcc.s   .fx_isr_zero              | second half of the cycle: silent
        lea     fx_sin(pc),a1
        move.b  0(a1,d2.w),d2
        mulu    d1,d2
        mulu    #17,d2                    | ~ /15 : (x * 17 + 128) >> 8
        add.w   #128,d2
        lsr.w   #8,d2
        move.w  d2,d1
        bra.s   .fx_isr_put
.fx_isr_zero:
        moveq   #0,d1
.fx_isr_put:
        move.b  d0,0xffff8800.w
        move.b  d1,0xffff8802.w
        bra.s   .fx_isr_eoi
.fx_isr_sync:
        move.b  #13,0xffff8800.w          | rewrite the envelope shape: restarts the envelope
        move.b  FX_SH+13(a0),d1
        and.b   #15,d1
        move.b  d1,0xffff8802.w
.fx_isr_eoi:
        bclr    #5,0xfffffa0f.w
        movem.l (sp)+,d0-d2/a0-a1
        rte
