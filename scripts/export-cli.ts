// npx tsx scripts/export-cli.ts <module> <outdir> [name]  -> .ym .sndh .h .wav .regs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { loadModule } from '../src/core/load';
import { convert } from '../src/core/convert';
import { packStream } from '../src/export/stream';
import { writeYm5 } from '../src/export/ym';
import { writeSndh } from '../src/export/sndh';
import { writeCHeader } from '../src/export/cheader';
import { renderYm } from '../src/export/ymemu';
import { encodeWav } from '../src/export/wav';

const [file, outDir, nameArg] = process.argv.slice(2);
const name = nameArg ?? basename(file).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '_');
const m = loadModule(new Uint8Array(readFileSync(file)));
const r = convert(m, {});
mkdirSync(outDir, { recursive: true });
const title = m.title || name;
writeFileSync(`${outDir}/${name}.regs`, r.regs);
writeFileSync(`${outDir}/${name}.ym`, writeYm5(r.regs, r.nframes, r.loopFrame, title, 'MOD-XM tool', ''));
writeFileSync(`${outDir}/${name}.sndh`, writeSndh(r.regs, r.nframes, r.loopFrame, { title, author: 'unknown' }));
const p = packStream(r.regs, r.nframes, r.loopFrame);
writeFileSync(`${outDir}/${name}.h`, writeCHeader(name, p.data, r.nframes, r.loopFrame, p.loopOffset));
if (process.env.WAV) writeFileSync(`${outDir}/${name}.wav`, encodeWav(renderYm(r.regs, r.nframes), 44100));
console.log(`${name}: ${r.nframes} frames, stream ${p.data.length} bytes, loop frame ${r.loopFrame}`);
