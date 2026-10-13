// Usage: npx tsx scripts/convert-cli.ts <module> <out-basename>
import { readFileSync, writeFileSync } from 'node:fs';
import { loadModule } from '../src/core/load';
import { convert } from '../src/core/convert';
const [, , inp, out] = process.argv;
const m = loadModule(new Uint8Array(readFileSync(inp)));
const r = convert(m);
console.log(r.report.join('\n'));
console.log('instruments:');
for (const i of r.instruments) console.log(`  ${String(i.inst).padStart(2)} ${i.name.padEnd(22)} ${i.cls}${i.c4Hz ? ' ' + i.c4Hz.toFixed(1) + 'Hz' : ''}${i.drum ? ' drum=' + i.drum : ''}`);
if (out) { writeFileSync(out + '.regs', r.regs); console.log('wrote', out + '.regs'); }
