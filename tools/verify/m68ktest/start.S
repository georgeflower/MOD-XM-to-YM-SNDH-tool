        .section .text.start,"ax"
        .globl _start
_start:
        bra.w   sndh_init
        bra.w   sndh_exit
        bra.w   sndh_play
        .ascii  "SNDH"
        .ascii  "TITL"
        .asciz  "m68k test"
        .even
        .ascii  "COMM"
        .asciz  "test"
        .even
        .ascii  "##01"
        .byte   0
        .even
        .ascii  "TC50"
        .byte   0
        .even
        .ascii  "TIME"
        .word   200
        .ascii  "HDNS"
        .even
sndh_exit:
        rts
