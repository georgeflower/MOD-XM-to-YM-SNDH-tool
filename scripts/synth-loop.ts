// builds a small synthetic song with a loop point to test the SNDH wrap-around: npx tsx scripts/synth-loop.ts <outdir>
import { writeFileSync } from 'node:fs';
import { writeSndh } from '../src/export/sndh';
const n = 120, loop = 40;
const regs = new Uint8Array(n * 14);
let seed = 7;
for (let f = 0; f < n; f++) {
  for (let k = 0; k < 14; k++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const hold = f > 0 && (seed >> 8) % 3 === 0;           // keep some registers unchanged (delta coding)
    regs[f * 14 + k] = hold ? regs[(f - 1) * 14 + k] : (seed >> 4) & (k === 7 ? 0xff : k === 13 ? 0 : 0xf);
  }
  regs[f * 14 + 7] |= 0xc0; regs[f * 14 + 13] = 0;
}
const dir = process.argv[2];
writeFileSync(`${dir}/synth.regs`, regs);
writeFileSync(`${dir}/synth.sndh`, writeSndh(regs, n, loop, { title: 'synth', author: 'test', seconds: 20 }));
