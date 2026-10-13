// Single-header C replayer for games (works with the .h written by cheader.ts).
// The game owns the PSG; it calls ymplay_step() once per 50 Hz tick and then ymplay_write() (or writes ymplay_reg[]
// to the chip itself, so sound effects can steal a voice by overriding registers before the write).
// With digidrums the header also carries the 68000 drum engine (Timer D) and a trigger-aware ymplay_write().
import { GAME_DRUM_BLOB, GAME_DRUM_OFFSETS } from '../player68k/blob';

function blobWords(): string {
  const b = GAME_DRUM_BLOB, rows: string[] = [];
  for (let i = 0; i < b.length; i += 16) {
    const r: string[] = [];
    for (let k = i; k < Math.min(i + 16, b.length); k += 2) r.push('0x' + (((b[k] << 8) | (b[k + 1] ?? 0)) >>> 0).toString(16).padStart(4, '0'));
    rows.push('    ' + r.join(',') + ',');
  }
  return rows.join('\n');
}

export function replayerHeader(name: string, drums = false, fx = false): string {
  const engine = drums || fx;
  const N = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const n = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const O = GAME_DRUM_OFFSETS;
  const drumDoc = drums ? ` *
 *   Digidrums (4-bit samples played through a voice's volume register by MFP Timer D):
 *   ymdrum_init(${n}_drums);      // once, supervisor mode: takes over Timer D (vector $110)
 *   ...every 50 Hz tick, supervisor mode:  ymplay_step();  ymplay_write();
 *   ymdrum_exit();                // when the music ends: restores Timer D
 *   ymplay_write() writes the PSG for you, leaves the volume register of the voice that is playing a drum alone
 *   and starts / stops drums.  If you write the PSG yourself, check ymplay_trig after ymplay_step() (see ymplay_write)
 *   and never write R8+voice while ymdrum_busy() is non-zero.  Only one drum plays at a time; a new one cuts the old.
 *   Timer D must not be used by anything else; the interrupt runs at IPL 6.
` : ` *   then ymplay_write() (supervisor mode), or write ymplay_reg[0..13] to the PSG yourself
`;
  const fxDoc = fx ? ` *
 *   Timer effects (Q SID voice, S sinus-SID, U sync-buzzer) run on MFP Timer A (vector $134, level 6):
 *   ymdrum_init(${drums ? n + '_drums' : '0'});   // once, supervisor mode (also the engine's init when the song has no digidrums)
 *   ...every 50 Hz tick, supervisor mode:  ymplay_step();  ymplay_write();
 *   ymdrum_exit();                // restores Timer A / D and the volume of the voice
 *   ymplay_write() keeps a shadow of the registers for the interrupt and never writes the volume register of the voice
 *   the effect drives (ymfx_voice() >= 0 while one runs).  If you write the PSG yourself: copy ymplay_reg[0..13] to the
 *   shadow (ymplay_write shows how), skip R8+ymfx_voice(), and call the ymplay_fxev actions after the writes.
 *   Timer A must not be used by anything else while the music plays.  Only one effect runs at a time.
` : '';
  const drumCode = engine ? `
/* ---- digidrum / timer effect engine (68000 machine code, position independent; needs RAM, so not const) ---- */
static unsigned short ymdrum_code[${(GAME_DRUM_BLOB.length + 1) >> 1}] = {
${blobWords()}
};
#define YMDRUM_INIT  ${O.init}
#define YMDRUM_EXIT  ${O.exit}
#define YMDRUM_START ${O.start}
#define YMDRUM_STOP  ${O.stop}
#define YMDRUM_TAB   ${O.tab}
#define YMDRUM_VOICE ${O.voice}
#define YMDRUM_IDX   ${O.idx}
#define YMDRUM_SEL   ${O.sel}
#define YMDRUM_ACT   ${O.act}
#define YMFX_START   ${O.fxstart}
#define YMFX_STOP    ${O.fxstop}
#define YMFX_KIND    ${O.kind}
#define YMFX_CODE    ${O.code}
#define YMFX_COUNT   ${O.count}
#define YMFX_SEL     ${O.fxsel}
#define YMFX_SHADOW  ${O.fxshadow}
#ifndef YMDRUM_CALL
#define YMDRUM_CALL(off) (((void (*)(void))((char *)ymdrum_code + (off)))())
#endif
#define YMDRUM_W(off) (*(volatile unsigned short *)((char *)ymdrum_code + (off)))
#define YMDRUM_B(off) (*(volatile unsigned char *)((char *)ymdrum_code + (off)))

static void ymdrum_init(const unsigned short *table)
{
    YMDRUM_W(YMDRUM_TAB)     = (unsigned short)((unsigned long)table >> 16);
    YMDRUM_W(YMDRUM_TAB + 2) = (unsigned short)((unsigned long)table);
    YMDRUM_CALL(YMDRUM_INIT);
}
static void ymdrum_exit(void) { YMDRUM_CALL(YMDRUM_EXIT); }
static void ymdrum_start(int voice, int idx)
{
    YMDRUM_W(YMDRUM_VOICE) = (unsigned short)voice;
    YMDRUM_W(YMDRUM_IDX)   = (unsigned short)idx;
    YMDRUM_CALL(YMDRUM_START);
}
static void ymdrum_stop(void) { YMDRUM_CALL(YMDRUM_STOP); }
/* non-zero while a drum is playing */
static int ymdrum_busy(void) { return YMDRUM_B(YMDRUM_ACT); }
/* the voice (0..2) that the running drum owns; only meaningful while ymdrum_busy() */
static int ymdrum_voice(void) { return YMDRUM_B(YMDRUM_SEL) - 8; }
static void ymfx_start(int voice, int kind, int code, int count)
{
    YMDRUM_W(YMDRUM_VOICE) = (unsigned short)voice;
    YMDRUM_W(YMFX_KIND)    = (unsigned short)kind;
    YMDRUM_W(YMFX_CODE)    = (unsigned short)code;
    YMDRUM_W(YMFX_COUNT)   = (unsigned short)count;
    YMDRUM_CALL(YMFX_START);
}
static void ymfx_stop(void) { YMDRUM_CALL(YMFX_STOP); }
/* the voice (0..2) whose volume (SID / sinus-SID) an effect drives, -1 when none (sync-buzzer drives the envelope) */
static int ymfx_voice(void) { int s = YMDRUM_B(YMFX_SEL); return s == 0xff ? -1 : s - 8; }
` : '';
  const irq = `#if defined(__GNUC__) && defined(__mc68000__)
#define YMPLAY_IRQ_OFF(sr)     __asm__ volatile ("move.w %%sr,%0\\n\\tor.w #0x0600,%%sr" : "=d"(sr) : : "cc")
#define YMPLAY_IRQ_RESTORE(sr) __asm__ volatile ("move.w %0,%%sr" : : "d"(sr) : "cc")
#else
#define YMPLAY_IRQ_OFF(sr)     ((sr) = 0)
#define YMPLAY_IRQ_RESTORE(sr) ((void)(sr))
#endif`;
  const writeFn = engine ? `
/* Write the registers to the PSG (supervisor mode).  Drum / effect events are handled here: stops first, then the
   register writes (not the volume of a voice that a drum or an effect owns; IPL 6 so the timer interrupts cannot
   interleave), then new drums / effects start.  The shadow copy is what the effect interrupts read. */
static void ymplay_write(void)
{
    volatile unsigned char *sel = (volatile unsigned char *)0xffff8800L;
    volatile unsigned char *wr  = (volatile unsigned char *)0xffff8802L;
    volatile unsigned char *sh  = &YMDRUM_B(YMFX_SHADOW);
    unsigned short sr = 0;
    int k, skip = -1, fskip;
${drums ? '    if (ymplay_trig && (ymplay_trig & 63) == 63) ymdrum_stop();\n' : ''}${fx ? '    if (ymplay_fxev == 1) ymfx_stop();\n' : ''}    YMPLAY_IRQ_OFF(sr);
${drums ? '    if (ymdrum_busy()) skip = ymdrum_voice() + 8;\n' : ''}    fskip = ${fx ? 'ymfx_voice() >= 0 ? ymfx_voice() + 8 : -1' : '-1'};
    for (k = 0; k < 14; k++) {
        if (k == 13 && ymplay_reg[13] == 0xff) continue;
        sh[k] = ymplay_reg[k];
        if (k == skip || k == fskip) continue;
        *sel = (unsigned char)k; *wr = ymplay_reg[k];
    }
    YMPLAY_IRQ_RESTORE(sr);
${drums ? '    if (ymplay_trig && (ymplay_trig & 63) != 63) ymdrum_start((ymplay_trig >> 6) - 1, ymplay_trig & 63);\n' : ''}${fx ? '    if (ymplay_fxev == 2) ymfx_start(ymplay_fxvoice, ymplay_fxkind, ymplay_fxcode, ymplay_fxcount);\n' : ''}}
` : `
/* Write the registers to the PSG (supervisor mode). */
static void ymplay_write(void)
{
    volatile unsigned char *sel = (volatile unsigned char *)0xffff8800L;
    volatile unsigned char *wr  = (volatile unsigned char *)0xffff8802L;
    int k;
    for (k = 0; k < 14; k++) {
        if (k == 13 && ymplay_reg[13] == 0xff) continue;
        *sel = (unsigned char)k; *wr = ymplay_reg[k];
    }
}
`;
  const parse = fx ? `        if (b & 0x80) {
            unsigned char t = *ymplay_p++;
            if ((t & 0xc0) == 0) {                        /* timer effect: kind<<4 | voice<<2 | drum byte follows */
                ymplay_fxkind = (t >> 4) & 3; ymplay_fxvoice = (t >> 2) & 3;
                if (ymplay_fxkind) { ymplay_fxcode = *ymplay_p++; ymplay_fxcount = *ymplay_p++; ymplay_fxev = 2; }
                else ymplay_fxev = 1;
                t = (t & 1) ? *ymplay_p++ : 0;
            }
            ymplay_trig = t;
        }` : `        if (b & 0x80) ymplay_trig = *ymplay_p++;`;
  return `/* ymplay.h - packed YM2149 register stream replayer (generated with the MOD/XM -> YM tool)
 *
 *   #include "${n}.h"          // stream data from the tool
 *   #include "ymplay.h"
 *
 *   ymplay_start(${n}_data, ${N}_FRAMES, ${N}_LOOP_FRAME, ${N}_LOOP_OFFSET);
 *   ...every 50 Hz tick (VBL):  ymplay_step();
${drumDoc}${fxDoc} *   R13 (envelope shape) is 0xff in ymplay_reg when it must not be written (writing it restarts the envelope).
 *   To let a sound effect steal a voice, override tone R0-R5, volume R8-R10 and the mixer bits in R7 before the write.
 */
#ifndef YMPLAY_H
#define YMPLAY_H
static const unsigned char *ymplay_data, *ymplay_p;
static unsigned short ymplay_frames, ymplay_loop_frame, ymplay_frame;
static unsigned long  ymplay_loop_off;
static unsigned char  ymplay_reg[14];
/* digidrum trigger of the frame just stepped: 0 = none, else ((voice + 1) << 6) | drum, drum 63 = stop */
static unsigned char  ymplay_trig;
${fx ? `/* timer effect event of the frame just stepped: 0 none, 1 stop, 2 start (kind 1 SID, 2 sinus-SID, 3 sync-buzzer) */
static unsigned char  ymplay_fxev, ymplay_fxkind, ymplay_fxvoice, ymplay_fxcode, ymplay_fxcount;
` : ''}${irq}
${drumCode}
static void ymplay_start(const unsigned char *data, unsigned short frames,
                         unsigned short loop_frame, unsigned long loop_off)
{
    int k;
    ymplay_data = ymplay_p = data;
    ymplay_frames = frames; ymplay_loop_frame = loop_frame; ymplay_loop_off = loop_off;
    ymplay_frame = 0; ymplay_trig = 0;${fx ? ' ymplay_fxev = 0;' : ''}
    for (k = 0; k < 14; k++) ymplay_reg[k] = 0;
    ymplay_reg[7] = 0xff; ymplay_reg[13] = 0xff;
}

static void ymplay_step(void)               /* advance one 50 Hz frame */
{
    unsigned char a = *ymplay_p++;
    unsigned short mask = a & 0x7f;
    int k;
    ymplay_trig = 0;${fx ? ' ymplay_fxev = 0;' : ''}
    ymplay_reg[13] = 0xff;
    if (a & 0x80) {
        unsigned char b = *ymplay_p++;
        mask |= (unsigned short)(b & 0x7f) << 7;
${parse}
    }
    for (k = 0; k < 14; k++, mask >>= 1)
        if (mask & 1) ymplay_reg[k] = *ymplay_p++;
    if (++ymplay_frame >= ymplay_frames) {   /* the loop point starts with a full register refresh */
        ymplay_frame = ymplay_loop_frame;
        ymplay_p = ymplay_data + ymplay_loop_off;
    }
}
${writeFn}#endif
`;
}
