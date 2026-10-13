// Builds the documentation: docs/*.md (+ the generated tooltip chapter) -> one self-contained HTML file, public/docs/index.html
//   npx tsx scripts/build-docs.ts            writes docs/06-tooltips.md and public/docs/index.html
// `npm run build` runs it first, so the Help page is always the one that matches the code.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { marked, type Token, type Tokens } from 'marked';
import { LETTER_HELP } from '../src/tracker/hints';
import { EFFECT_LETTERS } from '../src/tracker/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

export const version = (): string => JSON.parse(read('package.json')).version as string;

// ---------------------------------------------------------------------------------------------------------------------
// Tooltip chapter: every title="…" / hint="…" attribute of the UI, with the control it belongs to
// ---------------------------------------------------------------------------------------------------------------------
export interface Tip { panel: string; control: string; text: string }

const PANELS: [string, string][] = [
  ['src/ui/App.tsx', 'Converter'],
  ['src/ui/ImportDialog.tsx', 'Manual import dialog'],
  ['src/ui/Tracker.tsx', 'Pattern editor'],
  ['src/ui/InstrumentEditor.tsx', 'Instrument editor'],
  ['src/ui/DrumEditor.tsx', 'Digidrum editor'],
];

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** end of the JSX opening tag that starts at `start` (braces are skipped, so `=>` inside handlers does not count) */
function tagEnd(s: string, start: number): number {
  let depth = 0, q = '';
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && s[i - 1] !== '\\') q = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
  }
  return s.length - 1;
}

/** the visible text right after an opening tag: plain text, or the string literals of a {…} expression */
function visibleText(s: string, end: number): string {
  let rest = s.slice(end + 1, end + 400);
  const lt = rest.search(/<(?!\/?(kbd|b|i|span|small)\b)/);
  if (lt >= 0) rest = rest.slice(0, lt);
  rest = rest.replace(/<[^>]*>/g, '');
  const lits = [...rest.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const plain = rest.replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
  if (plain) return plain;
  return lits.slice(0, 2).join(' / ');
}

/** controls whose label cannot be read from the JSX (a handler, a conditional or a column): matched by the tooltip text */
const NAMES: [RegExp, string][] = [
  [/^Which subtune/, 'Subtune'],
  [/^noise period 0-31/, 'Noise period (instrument editor)'],
  [/^envelope period = tone period/, 'Env. period divisor (÷)'],
  [/^Match the sample's waveform/, 'Sample waveform → buzzer'],
  [/^How AY composers lay out/, 'Bass + drums on the middle voice'],
  [/^Percussion samples/, 'Percussion as digidrums'],
  [/^Waveform of the sample's cycle/, 'Wave (column of the instrument table)'],
  [/^How this instrument is played/, 'AY role (column of the instrument table)'],
  [/^Scale by the note volume of the source/, 'follow note volume (macro editor)'],
  [/^the original module, for comparison/, '▶ Original'],
  [/^Adds a fourth column for digidrums/, 'Drum channel'],
  [/^the song loops back here/, '↻ mark in the order list'],
  [/^click or drag to draw the volume/, 'Step volume chart'],
  [/^Digidrum samples of this instrument/, 'Drums… / Hide drums'],
  [/^Show or hide the instrument editor/, 'Edit… / Hide editor'],
  [/^Play the whole conversion with the priorities/, '▶ Full preview (YM2149)'],
  [/^Play this channel alone on the chip/, 'Solo ▶ (channel table)'],
];

export function extractTips(): Tip[] {
  const out: Tip[] = [];
  for (const [file, panel] of PANELS) {
    const s = read(file);
    const seen = new Set<string>();
    for (const m of s.matchAll(/\b(title|hint)="([^"{}]+)"/g)) {
      const at = m.index!;
      const start = s.lastIndexOf('<', at);
      if (start < 0) continue;
      const end = tagEnd(s, start);
      const tag = s.slice(start, end + 1);
      if (/^<Modal\b/.test(tag)) continue;
      const attr = (n: string) => new RegExp(`\\b${n}="([^"{}]*)"`).exec(tag)?.[1];
      let control = attr('label') ?? visibleText(s, end);
      if (!control || control === '✕') control = attr('aria-label') ?? control;
      if (!control) control = /<(\w+)/.exec(tag)?.[1] === 'div' ? 'area' : (attr('aria-label') ?? '(control)');
      const text = decode(m[2]);
      const named = NAMES.find(([re]) => re.test(text));
      if (named) control = named[1];
      const key = control + '|' + text;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ panel, control: decode(control).replace(/\s+/g, ' ').trim(), text });
    }
  }
  return out;
}

/** dynamic tooltips written as template strings in the UI (listed by hand so they are documented too) */
const EXTRA_TIPS: Tip[] = [
  { panel: 'Converter', control: 'Instrument name field', text: 'Rename instrument NN (module name: …). The name is used in the pattern editor and saved with the mapping; empty = module name.' },
  { panel: 'Manual import dialog', control: 'Instrument name field', text: 'Rename instrument NN: the name is used in the pattern editor and saved with the mapping' },
  { panel: 'Manual import dialog', control: 'Activity graph', text: 'Click to listen to this channel from that point of the song (silent channels: "This channel is silent")' },
  { panel: 'Manual import dialog', control: 'Priority levels', text: 'Off: leave this channel out of the import · Low: gives way to the others when voices run short · Normal: no preference · High: wins over normal channels · Lead: the melody: keeps its voice almost always' },
  { panel: 'Pattern editor', control: 'Status line', text: 'Explains the cell under the cursor: arpeggio notes, slide size, speed / tempo, effect meaning, drum name (see the effect list below)' },
];

export function keyRows(): [string, string][] {
  const s = read('src/ui/Tracker.tsx');
  const body = s.slice(s.indexOf('<summary>Keyboard reference</summary>'));
  const rows: [string, string][] = [];
  for (const m of body.slice(0, body.indexOf('</tbody>')).matchAll(/<tr><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><\/tr>/g)) {
    const clean = (x: string) => decode(x.replace(/<kbd>(.*?)<\/kbd>/g, '`$1`').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    rows.push([clean(m[1]), clean(m[2])]);
  }
  return rows;
}

export function tooltipMarkdown(): string {
  const tips = [...extractTips(), ...EXTRA_TIPS];
  const esc = (x: string) => x.replace(/\|/g, '\\|');
  const lines: string[] = [
    '<!-- GENERATED by scripts/build-docs.ts from the tooltips in src/ui/*.tsx and src/tracker/hints.ts — do not edit by hand -->',
    '# Tooltips and keys {#tooltips}',
    '',
    'Hover over any control for a tooltip. This chapter lists every one of them (generated from the program source, so it is always current), the explanations shown on the pattern editor\'s status line, and the keyboard reference.',
    '',
  ];
  for (const [, panel] of PANELS) {
    const list = tips.filter((t) => t.panel === panel);
    if (!list.length) continue;
    lines.push(`## ${panel} {#tooltips-${panel.toLowerCase().replace(/[^a-z]+/g, '-')}}`, '', '| Control | Tooltip |', '|---|---|');
    for (const t of list) lines.push(`| ${esc(t.control)} | ${esc(t.text)} |`);
    lines.push('');
  }
  lines.push('## Status line explanations (effects) {#tooltips-status}', '', 'The line under the pattern shows these when the cursor is on a cell with an effect:', '', '| Effect | Explanation |', '|---|---|');
  for (const l of EFFECT_LETTERS) lines.push(`| \`${l}\` | ${esc(LETTER_HELP[l] ?? '(not played by the YM2149 renderer)')} |`);
  lines.push('', '## Keyboard reference {#tooltips-keys}', '', '| Keys | Action |', '|---|---|');
  for (const [k, a] of keyRows()) lines.push(`| ${esc(k)} | ${esc(a)} |`);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// Markdown -> HTML
// ---------------------------------------------------------------------------------------------------------------------
const slug = (s: string) => s.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Section { id: string; title: string; tokens: Token[] }
interface Chapter { id: string; title: string; intro: Token[]; sections: Section[] }

function heading(t: Tokens.Heading): { id: string; title: string } {
  const m = /^(.*?)\s*\{#([\w-]+)\}\s*$/.exec(t.text);
  const title = (m ? m[1] : t.text).trim();
  return { id: m ? m[2] : slug(title), title };
}

export function parseChapters(sources: string[]): Chapter[] {
  const chapters: Chapter[] = [];
  for (const src of sources) {
    const tokens = marked.lexer(src);
    let ch: Chapter | null = null, sec: Section | null = null;
    for (const t of tokens) {
      if (t.type === 'heading' && (t as Tokens.Heading).depth === 1) {
        const h = heading(t as Tokens.Heading);
        ch = { id: h.id, title: h.title, intro: [], sections: [] }; chapters.push(ch); sec = null;
      } else if (t.type === 'heading' && (t as Tokens.Heading).depth === 2 && ch) {
        const h = heading(t as Tokens.Heading);
        sec = { id: h.id, title: h.title, tokens: [] }; ch.sections.push(sec);
      } else if (t.type === 'html' && /GENERATED/.test((t as Tokens.HTML).text)) {
        continue;
      } else if (ch) (sec ? sec.tokens : ch.intro).push(t);
    }
  }
  return chapters;
}

const render = (tokens: Token[]) => marked.parser(Object.assign([...tokens], { links: {} }) as never);

const CSS = `
:root { --bg:#fbfbfd; --ink:#1b1f2a; --dim:#5a6074; --line:#d9dce6; --accent:#2c5fd4; --side:#f0f2f8; --code:#eef0f6; --mark:#fff3b0; --head:#1d2342; --headink:#fff; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#10131f; --ink:#dfe3f1; --dim:#9aa2bd; --line:#2a3050; --accent:#7ea8ff; --side:#161a2c; --code:#1b2037; --mark:#5b4c00; --head:#0a0d1e; } }
:root[data-theme="dark"] { --bg:#10131f; --ink:#dfe3f1; --dim:#9aa2bd; --line:#2a3050; --accent:#7ea8ff; --side:#161a2c; --code:#1b2037; --mark:#5b4c00; --head:#0a0d1e; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 64px; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header.top { position: sticky; top: 0; z-index: 5; display: flex; gap: 12px; align-items: center; padding: 8px 16px; background: var(--head); color: var(--headink); }
header.top h1 { font-size: 16px; margin: 0; font-weight: 600; white-space: nowrap; }
header.top h1 small { font-weight: 400; opacity: .75; margin-left: 6px; }
header.top input { flex: 1; min-width: 80px; max-width: 360px; padding: 5px 9px; border-radius: 4px; border: 1px solid #5a6390; background: #fff; color: #111; font: inherit; }
header.top a, header.top button { color: var(--headink); background: transparent; border: 1px solid #5a6390; border-radius: 4px; padding: 4px 9px; font: inherit; cursor: pointer; text-decoration: none; }
header.top .sp { flex: 1; }
.layout { display: grid; grid-template-columns: 270px minmax(0, 1fr); }
nav.toc { position: sticky; top: 45px; align-self: start; height: calc(100vh - 45px); overflow: auto; padding: 14px 12px 40px 16px; background: var(--side); border-right: 1px solid var(--line); font-size: 13.5px; }
nav.toc ol { list-style: none; margin: 0; padding: 0; }
nav.toc li.ch { margin-top: 12px; font-weight: 600; }
nav.toc li.ch a { color: var(--ink); }
nav.toc li.sec { font-weight: 400; padding-left: 10px; margin: 1px 0; }
nav.toc a { color: var(--dim); text-decoration: none; display: block; padding: 1px 0; }
nav.toc a:hover, nav.toc a.on { color: var(--accent); }
main { padding: 8px 28px 80px; max-width: 980px; }
main section.chapter > h1 { font-size: 28px; margin: 36px 0 10px; padding-bottom: 6px; border-bottom: 2px solid var(--accent); }
main section.sec > h2 { font-size: 20px; margin: 28px 0 8px; }
h3 { font-size: 16px; margin: 20px 0 6px; }
a { color: var(--accent); }
.anchor { color: var(--dim); text-decoration: none; margin-left: 6px; opacity: 0; font-weight: 400; }
h1:hover .anchor, h2:hover .anchor { opacity: 1; }
table { border-collapse: collapse; margin: 12px 0; width: 100%; font-size: 14px; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: 5px 9px; vertical-align: top; text-align: left; }
th { background: var(--side); }
code { background: var(--code); border-radius: 3px; padding: 1px 4px; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { background: var(--code); padding: 10px 12px; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: 10px 0; padding: 4px 14px; border-left: 4px solid var(--accent); background: var(--side); }
mark { background: var(--mark); color: inherit; }
.hidden { display: none; }
.none { color: var(--dim); padding: 20px 0; }
footer { color: var(--dim); font-size: 13px; padding: 20px 28px 40px; border-top: 1px solid var(--line); }
#menu { display: none; }
@media (max-width: 860px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  nav.toc { position: fixed; left: 0; top: 45px; width: 280px; max-width: 85vw; z-index: 4; transform: translateX(-105%); transition: transform .15s; box-shadow: 2px 0 12px #0006; }
  body.menu nav.toc { transform: none; }
  #menu { display: inline-block; }
  header.top { gap: 6px; padding: 8px 10px; }
  header.top h1 small, header.top .sp { display: none; }
  header.top input { min-width: 0; }
  header.top a, header.top button { padding: 4px 7px; }
  main { padding: 6px 16px 60px; }
}
@media print {
  header.top, nav.toc { display: none; }
  .layout { display: block; }
  main { max-width: none; padding: 0; }
  main section.chapter { break-before: page; }
  a { color: inherit; }
}
`;

const JS = `
(function () {
  var q = document.getElementById('q'), secs = [].slice.call(document.querySelectorAll('section.sec, section.chapter > .intro')), none = document.getElementById('none');
  var links = [].slice.call(document.querySelectorAll('nav.toc a'));
  function clear(el) { [].slice.call(el.querySelectorAll('mark')).forEach(function (m) { m.replaceWith(document.createTextNode(m.textContent)); }); el.normalize(); }
  function mark(el, term) {
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null), n, hits = [];
    while ((n = w.nextNode())) { if (n.parentNode.closest('pre,code,script') ) continue; if (n.nodeValue.toLowerCase().indexOf(term) >= 0) hits.push(n); }
    hits.slice(0, 40).forEach(function (t) {
      var i = t.nodeValue.toLowerCase().indexOf(term), r = t.splitText(i), after = r.splitText(term.length), m = document.createElement('mark');
      m.textContent = r.nodeValue; r.parentNode.replaceChild(m, r);
    });
  }
  function run() {
    var term = q.value.trim().toLowerCase(), shown = 0;
    secs.forEach(function (s) {
      clear(s);
      if (!term) { s.classList.remove('hidden'); shown++; return; }
      var hit = s.textContent.toLowerCase().indexOf(term) >= 0;
      s.classList.toggle('hidden', !hit);
      if (hit) { shown++; mark(s, term); }
    });
    [].slice.call(document.querySelectorAll('section.chapter > h1')).forEach(function (h) { h.classList.toggle('hidden', !!term && !h.parentNode.querySelector('section.sec:not(.hidden), .intro:not(.hidden)')); });
    none.classList.toggle('hidden', shown > 0);
  }
  q.addEventListener('input', run);
  document.addEventListener('keydown', function (e) { if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); } if (e.key === 'Escape') { q.value = ''; run(); q.blur(); } });
  document.getElementById('menu').addEventListener('click', function () { document.body.classList.toggle('menu'); });
  links.forEach(function (a) { a.addEventListener('click', function () { document.body.classList.remove('menu'); }); });
  var t = document.getElementById('theme');
  t.addEventListener('click', function () {
    var r = document.documentElement, dark = r.getAttribute('data-theme') === 'dark' || (!r.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    r.setAttribute('data-theme', dark ? 'light' : 'dark');
    try { localStorage.setItem('xmod-docs-theme', dark ? 'light' : 'dark'); } catch (e) {}
  });
  try { var th = localStorage.getItem('xmod-docs-theme'); if (th) document.documentElement.setAttribute('data-theme', th); } catch (e) {}
  // a hidden target (search active) is revealed by following a link to it
  window.addEventListener('hashchange', function () { if (q.value) { q.value = ''; run(); var el = document.getElementById(location.hash.slice(1)); if (el) el.scrollIntoView(); } });
  // highlight the chapter being read
  if ('IntersectionObserver' in window) {
    var map = {}; links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting && map[e.target.id]) { links.forEach(function (a) { a.classList.remove('on'); }); map[e.target.id].classList.add('on'); } }); }, { rootMargin: '-60px 0px -75% 0px' });
    [].slice.call(document.querySelectorAll('section.chapter, section.sec')).forEach(function (s) { io.observe(s); });
  }
})();
`;

export function buildHtml(chapters: Chapter[], ver: string): string {
  const ids = new Set<string>();
  const uniq = (id: string) => { if (ids.has(id)) throw new Error(`duplicate id in the documentation: ${id}`); ids.add(id); return id; };
  const toc: string[] = [], body: string[] = [];
  for (const ch of chapters) {
    uniq(ch.id);
    toc.push(`<li class="ch"><a href="#${ch.id}">${esc(ch.title)}</a></li>`);
    body.push(`<section class="chapter" id="${ch.id}"><h1>${esc(ch.title)}<a class="anchor" href="#${ch.id}" aria-label="link">#</a></h1>`);
    if (ch.intro.length) body.push(`<div class="intro">${render(ch.intro)}</div>`);
    for (const s of ch.sections) {
      uniq(s.id);
      toc.push(`<li class="sec"><a href="#${s.id}">${esc(s.title)}</a></li>`);
      body.push(`<section class="sec" id="${s.id}"><h2>${esc(s.title)}<a class="anchor" href="#${s.id}" aria-label="link">#</a></h2>${render(s.tokens)}</section>`);
    }
    body.push('</section>');
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MOD/XM to YM2149 Help</title>
<meta name="description" content="Manual, how-to guide, effects reference, architecture and technical specifications of the MOD/XM to YM2149 tool, version ${esc(ver)}.">
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <button id="menu" aria-label="Contents">☰</button>
  <h1>MOD/XM → YM2149 <small>Help · v${esc(ver)}</small></h1>
  <input id="q" type="search" placeholder="Search the documentation  ( / )" aria-label="Search the documentation">
  <span class="sp"></span>
  <button id="theme" title="Switch between light and dark">◐</button>
  <a href="../index.html" title="Back to the tool">Open the tool</a>
</header>
<div class="layout">
<nav class="toc" aria-label="Contents"><ol>${toc.join('')}</ol></nav>
<main>
${body.join('\n')}
<p id="none" class="none hidden">Nothing found.</p>
</main>
</div>
<footer>MOD/XM → YM2149 · SNDH · game stream — version ${esc(ver)}. Runs entirely in your browser; this page is a single file and works offline.</footer>
<script>${JS}</script>
</body>
</html>
`;
}

export function buildDocs(write = true): { html: string; tooltips: string; chapters: Chapter[] } {
  const tooltips = tooltipMarkdown();
  const dir = join(ROOT, 'docs');
  const files = readdirSync(dir).filter((f) => /^\d\d-.*\.md$/.test(f)).sort();
  const sources = files.map((f) => (f === '06-tooltips.md' ? tooltips : readFileSync(join(dir, f), 'utf8')));
  if (!files.includes('06-tooltips.md')) throw new Error('docs/06-tooltips.md is missing (run the script once to create it)');
  const chapters = parseChapters(sources);
  const html = buildHtml(chapters, version());
  if (write) {
    writeFileSync(join(dir, '06-tooltips.md'), tooltips);
    mkdirSync(join(ROOT, 'public/docs'), { recursive: true });
    writeFileSync(join(ROOT, 'public/docs/index.html'), html);
  }
  return { html, tooltips, chapters };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!readdirSync(join(ROOT, 'docs')).includes('06-tooltips.md')) writeFileSync(join(ROOT, 'docs/06-tooltips.md'), '# Tooltips and keys {#tooltips}\n');
  const r = buildDocs(true);
  console.log(`docs: ${r.chapters.length} chapters, ${r.chapters.reduce((n, c) => n + c.sections.length, 0)} sections, ${(r.html.length / 1024).toFixed(0)} KB -> public/docs/index.html`);
}
