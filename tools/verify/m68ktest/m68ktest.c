/* CPU conformance SNDH for src/import/m68k.ts.  Position independent (-mpcrel).
 *   default build : ALU / addressing-mode suite, one instruction form per frame (alu_tests.c)
 *   -DMODE_MIX    : compiler-generated code (mixed integer arithmetic)
 * Results are written to the YM2149 registers so any 68000 emulator's register trace can be compared. */
typedef unsigned char u8; typedef unsigned short u16; typedef unsigned int u32;
typedef signed char s8; typedef short s16; typedef int s32;

#define YMSEL (*(volatile u8 *)0xFF8800)
#define YMDAT (*(volatile u8 *)0xFF8802)
static const u8 masks[14] = {255, 15, 255, 15, 255, 15, 31, 255, 31, 31, 31, 255, 255, 15};
static void ym(int reg, u32 v) { YMSEL = (u8)reg; YMDAT = (u8)(v & masks[reg]); }

/* the m68k libgcc is built for 68020+, so supply the one helper plain C code needs */
u32 __mulsi3(u32 a, u32 b)
{
    u32 r = 0;
    while (b) { if (b & 1) r += a; a <<= 1; b >>= 1; }
    return r;
}

static u32 frame, kk, rr;
static u32 lcg;
static u32 rnd(void) { lcg = lcg * 69069u + 1u; return lcg; }

#ifndef MODE_MIX
#include "alu_tests.c"
static u8 buf[32];
static const u32 special[][2] = {
    {0, 0}, {1, 1}, {0xffffffffu, 1}, {0x80000000u, 0x7fffffffu}, {0x7fffffffu, 1}, {0x00008000u, 0x0000ffffu},
    {0x000000ffu, 0x00000080u}, {0x0000ffffu, 0xffff0000u}, {0x12345678u, 0x9abcdef0u}, {0x99999999u, 0x01010101u},
};
void sndh_init(int sub_unused) { int i; for (i = 0; i < 32; i++) buf[i] = (u8)(i * 29); lcg = 12345u; frame = 0; kk = 0; rr = 0; }
void sndh_play(void)
{
    u32 a, b, ccr, f, mask, k = kk, round = rr;
    if (round < 10) { a = special[round][0]; b = special[round][1]; }
    else { a = rnd(); b = rnd(); if (round & 1) b &= 63; }
    if (IS_DIV(k)) { b |= 1; if (a == 0x80000000u) a = 0x80000001u; }   /* no zero divide (traps); no INT_MIN/-1 (emulator quirk) */
    if (IS_BCD(k)) { u32 i; for (i = 0; i < 32; i += 4) { if (((a >> i) & 15) > 9) a -= 6u << i; if (((b >> i) & 15) > 9) b -= 6u << i; } }  /* BCD operands only: invalid digits are undefined */
    ccr = (frame * 7u + round) & 0x1f;
    run_test((int)k, &a, b, ccr, buf, &f);
    mask = tmask[k];
    f &= 0x1f;
    if (tmask[k] == 0x02) mask = (f & 2) ? 0x02 : 0x0f;           /* divu/divs: N,Z undefined on overflow */
    ym(0, a); ym(2, a >> 8); ym(4, a >> 16); ym(7, a >> 24);
    ym(8, f & mask); ym(9, k); ym(10, k >> 5); ym(11, b); ym(12, ccr);
    ym(1, a >> 4); ym(3, a >> 12); ym(5, a >> 20); ym(6, a >> 27);
    ym(13, 0xff);
    frame++;
    if (++kk == NT) { kk = 0; rr++; }
}
#else
static u32 st[8];
static u8 tab[64];
static u16 wtab[16];
static inline u32 divu16(u32 a, u16 b) { u32 r = a; __asm__("divu.w %1,%0" : "+d"(r) : "d"(b)); return r; }
static inline u32 divs16(u32 a, s16 b) { u32 r = a; __asm__("divs.w %1,%0" : "+d"(r) : "d"(b)); return r; }
static u32 rotl(u32 x, int n) { return (x << n) | (x >> (32 - n)); }
static u16 rotr16(u16 x, int n) { return (u16)((x >> n) | (x << (16 - n))); }
static u32 mix(u32 a, u32 b, int round)
{
    s16 sa = (s16)a, sb = (s16)b;
    u16 ua = (u16)a, ub = (u16)(b | 1);
    u32 r = a;
    r += (u32)((s32)sa * (s32)sb);
    r ^= (u32)ua * (u32)ub;
    r += divs16(a, (s16)(sb | 3));
    r ^= divu16(a, (u16)(ub | 5));
    r += rotl(b, round & 15);
    r ^= (u32)rotr16(ua, round & 7) << 8;
    r += (s32)((s8)a) * 3 - (s32)((s8)(b >> 8));
    r ^= (a >> 3) | (b << 5);
    r += (u32)((s32)b >> (round & 7));
    r -= (u32)(a < b) + (u32)((s32)a < (s32)b) * 2 + (u32)(sa > sb) * 4;
    switch (round & 7) {
    case 0: r += tab[(a >> 2) & 63]; break;
    case 1: r ^= wtab[(b >> 3) & 15] * 7; break;
    case 2: r = ~r + 1; break;
    case 3: r = (r & 0xffff0000u) | ((r & 0xff) << 8) | ((r >> 8) & 0xff); break;
    case 4: r += (u32)(-(s32)sa); break;
    case 5: { u32 c = 0; u32 x = r; while (x) { c += x & 1; x >>= 1; } r += c; break; }
    case 6: r ^= (u32)((u8)a) * (u32)((u8)b); break;
    default: r += (u32)(s32)(s8)(r >> 16); break;
    }
    return r;
}
void sndh_init(int sub_unused)
{
    int i;
    for (i = 0; i < 8; i++) st[i] = 0x1234567u * (u32)(i + 1);
    for (i = 0; i < 64; i++) tab[i] = (u8)(i * 37 + 11);
    for (i = 0; i < 16; i++) wtab[i] = (u16)(i * 4099 + 17);
    frame = 0;
}
void sndh_play(void)
{
    int i;
    frame++;
    for (i = 0; i < 8; i++) st[i] = mix(st[i], st[(i + 1) & 7], (int)frame + i);
    st[0] ^= frame;
    for (i = 0; i < 13; i++) ym(i, st[i & 7] >> ((i * 3) & 15));
    ym(13, 0xff);
}
#endif
