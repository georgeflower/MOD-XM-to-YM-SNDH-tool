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

export function replayerHeader(name: string, drums = false): string {
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
  const drumCode = drums ? `
/* ---- digidrum engine (68000 machine code, position independent; needs RAM, so not const) ---- */
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
` : '';
  const irq = `#if defined(__GNUC__) && defined(__mc68000__)
#define YMPLAY_IRQ_OFF(sr)     __asm__ volatile ("move.w %%sr,%0\\n\\tor.w #0x0600,%%sr" : "=d"(sr) : : "cc")
#define YMPLAY_IRQ_RESTORE(sr) __asm__ volatile ("move.w %0,%%sr" : : "d"(sr) : "cc")
#else
#define YMPLAY_IRQ_OFF(sr)     ((sr) = 0)
#define YMPLAY_IRQ_RESTORE(sr) ((void)(sr))
#endif`;
  const writeFn = drums ? `
/* Write the registers to the PSG (supervisor mode).  Drum triggers are handled here: stop first, then the register
   writes (not the volume of the voice that is playing a drum, IPL 6 so the Timer D interrupt cannot interleave),
   then a new drum starts. */
static void ymplay_write(void)
{
    volatile unsigned char *sel = (volatile unsigned char *)0xffff8800L;
    volatile unsigned char *wr  = (volatile unsigned char *)0xffff8802L;
    unsigned short sr = 0;
    int k, skip = -1;
    if (ymplay_trig && (ymplay_trig & 63) == 63) ymdrum_stop();
    YMPLAY_IRQ_OFF(sr);
    if (ymdrum_busy()) skip = ymdrum_voice() + 8;
    for (k = 0; k < 14; k++) {
        if (k == skip || (k == 13 && ymplay_reg[13] == 0xff)) continue;
        *sel = (unsigned char)k; *wr = ymplay_reg[k];
    }
    YMPLAY_IRQ_RESTORE(sr);
    if (ymplay_trig && (ymplay_trig & 63) != 63) ymdrum_start((ymplay_trig >> 6) - 1, ymplay_trig & 63);
}
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
  return `/* ymplay.h - packed YM2149 register stream replayer (generated with the MOD/XM -> YM tool)
 *
 *   #include "${n}.h"          // stream data from the tool
 *   #include "ymplay.h"
 *
 *   ymplay_start(${n}_data, ${N}_FRAMES, ${N}_LOOP_FRAME, ${N}_LOOP_OFFSET);
 *   ...every 50 Hz tick (VBL):  ymplay_step();
${drumDoc} *   R13 (envelope shape) is 0xff in ymplay_reg when it must not be written (writing it restarts the envelope).
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
${irq}
${drumCode}
static void ymplay_start(const unsigned char *data, unsigned short frames,
                         unsigned short loop_frame, unsigned long loop_off)
{
    int k;
    ymplay_data = ymplay_p = data;
    ymplay_frames = frames; ymplay_loop_frame = loop_frame; ymplay_loop_off = loop_off;
    ymplay_frame = 0; ymplay_trig = 0;
    for (k = 0; k < 14; k++) ymplay_reg[k] = 0;
    ymplay_reg[7] = 0xff; ymplay_reg[13] = 0xff;
}

static void ymplay_step(void)               /* advance one 50 Hz frame */
{
    unsigned char a = *ymplay_p++;
    unsigned short mask = a & 0x7f;
    int k;
    ymplay_trig = 0;
    ymplay_reg[13] = 0xff;
    if (a & 0x80) {
        unsigned char b = *ymplay_p++;
        mask |= (unsigned short)(b & 0x7f) << 7;
        if (b & 0x80) ymplay_trig = *ymplay_p++;
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
