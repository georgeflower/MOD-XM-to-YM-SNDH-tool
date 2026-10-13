| gamedrum.s - the digidrum engine as a stand-alone blob for games (no arguments in registers, so any C
| compiler can call it).  Set the mailbox fields, then call the entry point at the given offset.
|   +0  init    reads g_tab         +4  exit        +8  start   reads g_voice, g_idx        +12 stop
|   +16 .l g_tab   +20 .w g_voice   +22 .w g_idx    +24.. engine variables (dv_act at +33: nonzero while a drum plays,
|   dv_sel at +32 = 8 + voice of the running drum)
        .text
        .even
gblob:  bra.w   g_init
        bra.w   g_exit
        bra.w   g_start
        bra.w   g_stop
g_tab:  dc.l 0
g_voice:dc.w 0
g_idx:  dc.w 0
        .include "drumeng.s"
g_init: movem.l d0-d7/a0-a6,-(sp)
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
