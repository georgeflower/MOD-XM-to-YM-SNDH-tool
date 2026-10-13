| gamedrum.s - the digidrum engine as a stand-alone blob for games (no arguments in registers, so any C
| compiler can call it).  Set the mailbox fields, then call the entry point at the given offset.
|   +0  init    reads g_tab         +4  exit        +8  start   reads g_voice, g_idx        +12 stop
|   +16 fxstart reads g_voice, g_kind, g_code, g_count    +20 fxstop
|   then the mailbox g_tab (.l) g_voice g_idx g_kind g_code g_count (.w each) and the engine variables:
|   dv_act is non-zero while a drum plays, dv_sel = 8 + voice of the running drum;
|   fx_base+1 (fx_sel) = 8 + voice an effect drives (0xff = none) - never write that register - and the shadow
|   of R0..R15 at fx_base+16 must be kept up to date by the host (R13 only when it was really written)
        .text
        .even
gblob:  bra.w   g_init
        bra.w   g_exit
        bra.w   g_start
        bra.w   g_stop
        bra.w   g_fxstart
        bra.w   g_fxstop
g_tab:  dc.l 0
g_voice:dc.w 0
g_idx:  dc.w 0
g_kind: dc.w 0
g_code: dc.w 0
g_count:dc.w 0
        .include "drumeng.s"
g_init: movem.l d0-d7/a0-a6,-(sp)
        bsr     fx_init
        move.l  g_tab(pc),a0
        bsr     drum_init
        movem.l (sp)+,d0-d7/a0-a6
        rts
g_exit: movem.l d0-d7/a0-a6,-(sp)
        bsr     drum_exit
        movem.l (sp)+,d0-d7/a0-a6
        rts
g_start:movem.l d0-d7/a0-a6,-(sp)
        move.w  g_voice(pc),d0
        move.w  g_idx(pc),d1
        bsr     drum_start
        movem.l (sp)+,d0-d7/a0-a6
        rts
g_stop: movem.l d0-d7/a0-a6,-(sp)
        bsr     drum_stop
        movem.l (sp)+,d0-d7/a0-a6
        rts
g_fxstart:
        movem.l d0-d7/a0-a6,-(sp)
        move.w  g_voice(pc),d0
        move.w  g_kind(pc),d1
        move.w  g_code(pc),d2
        move.w  g_count(pc),d3
        bsr     fx_start
        movem.l (sp)+,d0-d7/a0-a6
        rts
g_fxstop:
        movem.l d0-d7/a0-a6,-(sp)
        bsr     fx_stop
        movem.l (sp)+,d0-d7/a0-a6
        rts
