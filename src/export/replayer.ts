// Single-header C replayer for games (works with the .h written by cheader.ts).
// The game owns the PSG; it calls ymplay_step() once per 50 Hz tick and writes ymplay_reg[] to the chip
// itself (so sound effects can steal a voice by overriding registers before the write).
export function replayerHeader(name: string): string {
  const N = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const n = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `/* ymplay.h - packed YM2149 register stream replayer (generated with the MOD/XM -> YM tool)
 *
 *   #include "${n}.h"          // stream data from the tool
 *   #include "ymplay.h"
 *
 *   ymplay_start(${n}_data, ${N}_FRAMES, ${N}_LOOP_FRAME, ${N}_LOOP_OFFSET);
 *   ...every 50 Hz tick (VBL):  ymplay_step();   then write ymplay_reg[0..13] to the PSG
 *   (skip the voices a sound effect is using: tone R0-R5, volume R8-R10, mixer bits in R7)
 */
#ifndef YMPLAY_H
#define YMPLAY_H
static const unsigned char *ymplay_data, *ymplay_p;
static unsigned short ymplay_frames, ymplay_loop_frame, ymplay_frame;
static unsigned long  ymplay_loop_off;
static unsigned char  ymplay_reg[14];

static void ymplay_start(const unsigned char *data, unsigned short frames,
                         unsigned short loop_frame, unsigned long loop_off)
{
    int k;
    ymplay_data = ymplay_p = data;
    ymplay_frames = frames; ymplay_loop_frame = loop_frame; ymplay_loop_off = loop_off;
    ymplay_frame = 0;
    for (k = 0; k < 14; k++) ymplay_reg[k] = 0;
    ymplay_reg[7] = 0xff;
}

static void ymplay_step(void)               /* advance one 50 Hz frame */
{
    unsigned char a = *ymplay_p++;
    unsigned short mask = a & 0x7f;
    int k;
    if (a & 0x80) mask |= (unsigned short)(*ymplay_p++ & 0x7f) << 7;
    for (k = 0; k < 14; k++, mask >>= 1)
        if (mask & 1) ymplay_reg[k] = *ymplay_p++;
    if (++ymplay_frame >= ymplay_frames) {   /* the loop point starts with a full register refresh */
        ymplay_frame = ymplay_loop_frame;
        ymplay_p = ymplay_data + ymplay_loop_off;
    }
}
#endif
`;
}
