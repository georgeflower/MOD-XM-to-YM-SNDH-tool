import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { buildDocs, extractTips, tooltipMarkdown, version } from '../scripts/build-docs';
import { EFFECT_LETTERS } from '../src/tracker/types';
import { LETTER_HELP } from '../src/tracker/hints';
import { INSTRUMENT_PRESETS } from '../src/tracker/presets';
import { LEVELS } from '../src/ui/ImportDialog';

const root = new URL('../', import.meta.url);
const md = (f: string) => readFileSync(new URL(`docs/${f}`, root), 'utf8');
const all = () => readdirSync(new URL('docs/', root)).filter((f) => f.endsWith('.md')).map(md).join('\n');

describe('documentation', () => {
  const built = buildDocs(false);
  it('is version 0.3 and says so', () => {
    expect(version()).toMatch(/^0\.3\./);
    expect(built.html).toContain('v0.3');
    expect(md('00-start.md')).toMatch(/version 0\.3/);
  });
  it('the generated tooltip chapter is up to date (run: npm run docs)', () => {
    expect(md('06-tooltips.md')).toBe(tooltipMarkdown());
  });
  it('the Help page in public/docs is up to date', () => {
    expect(existsSync(new URL('public/docs/index.html', root))).toBe(true);
    expect(readFileSync(new URL('public/docs/index.html', root), 'utf8')).toBe(built.html);
  });
  it('has unique ids and every internal link points at one', () => {
    const ids = new Set<string>();
    for (const c of built.chapters) { ids.add(c.id); for (const s of c.sections) ids.add(s.id); }
    const links = [...built.html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    const missing = links.filter((l) => !ids.has(l));
    expect(missing).toEqual([]);
    const text = all();
    const bad = [...text.matchAll(/\]\(#([\w-]+)\)/g)].map((m) => m[1]).filter((l) => !ids.has(l));
    expect(bad).toEqual([]);
  });
  it('documents every effect letter, with a status-line explanation', () => {
    const fx = md('05-effects.md');
    for (const l of EFFECT_LETTERS) {
      expect(LETTER_HELP[l], `status-line hint for ${l}`).toBeTruthy();
      expect(new RegExp('`' + l + '(xx|xy|y|[0-9A-F]{1,2}|\\b)').test(fx) || fx.includes('`' + l + '`'), `effect ${l} in docs/05-effects.md`).toBe(true);
    }
  });
  it('lists every instrument preset and every priority level', () => {
    const ed = md('03-manual-editor.md');
    for (const p of INSTRUMENT_PRESETS) expect(ed.toLowerCase(), p.name).toContain(p.name.split(/[ (]/)[0].toLowerCase());
    const conv = md('02-manual-converter.md');
    for (const l of LEVELS) expect(conv).toContain(`**${l.label}**`);
    expect(conv).toContain('+8');
  });
  it('every tooltip has a readable control name', () => {
    const tips = extractTips();
    expect(tips.length).toBeGreaterThan(80);
    for (const t of tips) {
      expect(t.control, t.text).not.toMatch(/=>|[{}]|^\(control\)$/);
      expect(t.text.length).toBeGreaterThan(2);
    }
  });
  it('uses the current names of the dialog buttons', () => {
    const text = all() + readFileSync(new URL('README.md', root), 'utf8');
    expect(text).not.toMatch(/Full import/);
    expect(text).toContain('Full preview');
  });
});
