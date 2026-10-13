// npx tsx scripts/import-cli.ts <file.sndh|file.ym> <out.regs> [subtune] [seconds]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseSndh } from '../src/import/sndh';
import { parseYm } from '../src/import/ym';
import { isSndh } from '../src/import/sndh';

const [inp, out, sub, sec] = process.argv.slice(2);
const d = new Uint8Array(readFileSync(inp));
const t = isSndh(d) ? parseSndh(d, { subtune: sub ? +sub : 1, seconds: sec ? +sec : undefined }) : parseYm(d);
writeFileSync(out, t.regs);
console.log(`${inp}: "${t.title}" by ${t.author} — ${t.nframes} frames (${(t.nframes / 50).toFixed(1)} s), loop frame ${t.loopFrame}`);
for (const w of t.warnings) console.log('  warning:', w);
