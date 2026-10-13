#!/usr/bin/env python3
"""Generates alu_tests.c: one inline-asm snippet per 68000 instruction form. Each test returns the result
register and the condition codes (masked to the architecturally defined ones)."""
tests = []   # (name, asm, flagmask)  operands: %0 = a (in/out), %1 = flags out, %2 = b, %3 = ccr in, %4 = pointer
def T(name, body, mask=0x1f): tests.append((name, body, mask))

PRE = "move.w %3,%%ccr\n\t"
POST = "\n\tmove.w %%sr,%1"
for sz in 'bwl':
    for op in ['add', 'sub', 'and', 'or', 'cmp']:
        T(f'{op}.{sz}', PRE + f"{op}.{sz} %2,%0" + POST, 0x0f if op in ('and', 'or') else 0x1f)
    T(f'eor.{sz}', PRE + f"eor.{sz} %2,%0" + POST, 0x0f)
    for op in ['addx', 'subx']:
        T(f'{op}.{sz}', PRE + f"{op}.{sz} %2,%0" + POST)
    for op in ['neg', 'negx', 'not', 'clr', 'tst']:
        T(f'{op}.{sz}', PRE + f"{op}.{sz} %0" + POST, 0x0f if op in ('not', 'clr', 'tst') else 0x1f)
    for op in ['addq', 'subq']:
        for q in (1, 3, 8):
            T(f'{op}.{sz} #{q}', PRE + f"{op}.{sz} #{q},%0" + POST)
    for op, m in [('addi', 0x1f), ('subi', 0x1f), ('andi', 0x0f), ('ori', 0x0f), ('eori', 0x0f), ('cmpi', 0x1f)]:
        imm = {'b': '0x5a', 'w': '0x5a96', 'l': '0x5a96c3e1'}[sz]
        T(f'{op}.{sz} imm', PRE + f"{op}.{sz} #{imm},%0" + POST, m)
    for op in ['asl', 'asr', 'lsl', 'lsr', 'rol', 'ror', 'roxl', 'roxr']:
        for c in (1, 2, 8):
            T(f'{op}.{sz} #{c}', PRE + f"{op}.{sz} #{c},%0" + POST, 0x1f)
        T(f'{op}.{sz} dn', PRE + f"{op}.{sz} %2,%0" + POST, 0x1f)
T('ext.w', PRE + "ext.w %0" + POST, 0x0f); T('ext.l', PRE + "ext.l %0" + POST, 0x0f)
T('swap', PRE + "swap %0" + POST, 0x0f)
T('mulu.w', PRE + "mulu.w %2,%0" + POST, 0x0f); T('muls.w', PRE + "muls.w %2,%0" + POST, 0x0f)
T('divu.w', PRE + "divu.w %2,%0" + POST, 0x02)     # V only: N/Z undefined on overflow, checked below when no overflow
T('divs.w', PRE + "divs.w %2,%0" + POST, 0x02)
for op in ['btst', 'bchg', 'bclr', 'bset']:
    T(f'{op} dn,dn', PRE + f"{op} %2,%0" + POST, 0x04)
    T(f'{op} #n,dn', PRE + f"{op} #13,%0" + POST, 0x04)
T('abcd', PRE + "abcd %2,%0" + POST, 0x15); T('sbcd', PRE + "sbcd %2,%0" + POST, 0x15); T('nbcd', PRE + "nbcd %0" + POST, 0x15)
T('tas', PRE + "tas %0" + POST, 0x0f)
T('exg', PRE + "exg %2,%0" + POST, 0x1f)
for cc in ['t', 'f', 'hi', 'ls', 'cc', 'cs', 'ne', 'eq', 'vc', 'vs', 'pl', 'mi', 'ge', 'lt', 'gt', 'le']:
    T(f's{cc}', PRE + f"s{cc} %0" + POST, 0x1f)
    T(f'db{cc}', PRE + f"db{cc} %0,0f\n\t0:" + POST, 0x1f)
T('movea.w/adda', PRE + "movea.w %0,%%a1; adda.w %2,%%a1; move.l %%a1,%0" + POST, 0x1f)
T('suba.l/cmpa', PRE + "movea.l %0,%%a1; suba.l %2,%%a1; cmpa.w %2,%%a1; move.l %%a1,%0" + POST, 0x1f)
T('movep.w', "move.w %3,%%ccr; movep.w %0,0(%4); clr.l %0; movep.w 0(%4),%0" + POST, 0x1f)
T('movep.l', "move.w %3,%%ccr; movep.l %0,0(%4); clr.l %0; movep.l 0(%4),%0" + POST, 0x1f)
T('move.b d,d', PRE + "move.b %2,%0" + POST, 0x0f); T('move.w d,d', PRE + "move.w %2,%0" + POST, 0x0f); T('move.l d,d', PRE + "move.l %2,%0" + POST, 0x0f)
T('moveq', PRE + "moveq #-27,%0" + POST, 0x0f)
T('mem add.w', PRE + "move.w %0,(%4); add.w %2,(%4); move.w (%4),%0" + POST, 0x1f)
T('mem sub.l', PRE + "move.l %0,(%4); sub.l %2,(%4); move.l (%4),%0" + POST, 0x1f)
T('mem asl.w', PRE + "move.w %0,(%4); asl.w (%4); move.w (%4),%0" + POST, 0x1f)
T('mem lsr.w', PRE + "move.w %0,(%4); lsr.w (%4); move.w (%4),%0" + POST, 0x1f)
T('mem roxl.w', PRE + "move.w %0,(%4); roxl.w (%4); move.w (%4),%0" + POST, 0x1f)
T('mem ror.w', PRE + "move.w %0,(%4); ror.w (%4); move.w (%4),%0" + POST, 0x1f)
T('mem bset.b', PRE + "move.l %0,(%4); bset %2,(%4); move.l (%4),%0" + POST, 0x04)
T('mem not.b/neg.w', PRE + "move.l %0,(%4); not.b (%4); neg.w 2(%4); move.l (%4),%0" + POST, 0x1f)
T('mem clr.l/tst', PRE + "move.l %0,(%4); tst.l (%4); clr.w 2(%4); move.l (%4),%0" + POST, 0x0f)
T('predec/postinc', PRE + "lea 8(%4),%%a1; move.l %0,-(%%a1); move.w %2,-(%%a1); move.b %0,-(%%a1); move.b (%%a1)+,%0; move.w (%%a1)+,%2; move.b (%%a1)+,%1" + POST, 0x0f)
T('movem w', PRE + "movem.l %0/%2,(%4); movem.w (%4),%%d1-%%d2; movem.w %%d1-%%d2,4(%4); move.l 4(%4),%0" + POST, 0x1f)
T('movem l pre/post', PRE + "lea 16(%4),%%a1; movem.l %0/%2,-(%%a1); movem.l (%%a1)+,%%d1-%%d2; move.l %%d2,%0; sub.l %4,%%a1; move.l %%a1,%2" + POST, 0x1f)
T('idx', PRE + "move.l %0,4(%4); move.l %2,8(%4); moveq #4,%%d1; move.l 0(%4,%%d1.w),%0; add.l 4(%4,%%d1.l),%0; move.b -1(%4,%%d1.w),%1" + POST, 0x1f)
T('link/unlk', PRE + "move.l %%a6,-(%%sp); link %%a6,#-8; move.l %0,-4(%%a6); move.l -4(%%a6),%0; unlk %%a6; move.l (%%sp)+,%%a6" + POST, 0x1f)
T('pea/lea', PRE + "pea 6(%4); move.l (%%sp)+,%0; lea 4(%4),%%a1; sub.l %%a1,%0; move.l %0,%2" + POST, 0x1f)
T('jsr/rts', PRE + "bsr 1f; bra 2f; 1: addq.l #1,%0; rts; 2:" + POST, 0x1f)
T('ccr ops', "move.w %3,%%ccr; ori #0x13,%%ccr; eori #0x05,%%ccr; andi #0x1b,%%ccr; move.w %%sr,%0; and.l #0x1f,%0" + POST, 0x1f)
T('sp byte', PRE + "move.b %0,-(%%sp); move.w %2,-(%%sp); move.w (%%sp)+,%1; move.b (%%sp)+,%0" + POST, 0x1f)
T('cmpm', PRE + "move.l %0,(%4); move.l %2,4(%4); lea (%4),%%a1; lea 4(%4),%%a2; cmpm.b (%%a1)+,(%%a2)+; cmpm.b (%%a1)+,(%%a2)+; cmpm.w (%%a1)+,(%%a2)+" + POST, 0x1f)

divk = [i for i, t in enumerate(tests) if t[0] in ('divu.w', 'divs.w')]
bcdk = [i for i, t in enumerate(tests) if t[0] in ('abcd', 'sbcd', 'nbcd')]
out = ['/* generated by gen_alu.py - do not edit */', '#define NT %d' % len(tests), '#define IS_DIV(k) (%s)' % ' || '.join('(k) == %d' % i for i in divk), '#define IS_BCD(k) (%s)' % ' || '.join('(k) == %d' % i for i in bcdk), 'static const u8 tmask[NT] = {%s};' % ','.join(str(t[2]) for t in tests),
       'static void run_test(int k, u32 *pa, u32 pb, u32 pccr, u8 *pbuf, u32 *pf)', '{',
       '    register u32 a __asm__("d3") = *pa;', '    register u32 f __asm__("d6") = 0;', '    register u32 b __asm__("d4") = pb;',
       '    register u32 ccr __asm__("d5") = pccr;', '    register u8 *buf __asm__("a3") = pbuf;', '    switch (k) {']
for i, (n, body, m) in enumerate(tests):
    body = body.replace('\n\t', '\\n\\t')
    out.append(f'    case {i}: /* {n} */\n        __asm__ volatile ("{body}" : "+d"(a), "=d"(f) : "d"(b), "d"(ccr), "a"(buf) : "cc", "memory", "d1", "d2", "a1", "a2");\n        break;')
out += ['    }', '    *pa = a; *pf = f;', '}']
open('alu_tests.c', 'w').write('\n'.join(out) + '\n')
open('alu_tests.txt','w').write('\n'.join(f'{i} {t[0]}' for i,t in enumerate(tests))+'\n')
print(len(tests), 'tests')
