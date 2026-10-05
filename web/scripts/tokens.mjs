// Compiles design/tokens.json (the OpenLeaf design system's tokens) into src/styles/tokens.css.
// Run with `npm run tokens` after the design system changes.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const tokens = JSON.parse(readFileSync(new URL('design/tokens.json', root), 'utf8'));
const themes = tokens.color.themes.map((t) => t.id);
const value = (v) => (v.startsWith('{') ? `var(--${v.slice(1, -1)})` : v);

const out = ['/* Generated from design/tokens.json by scripts/tokens.mjs. Do not edit by hand. */'];
out.push(`:root, [data-theme="${themes[0]}"] {`);
for (const t of tokens.color.tokens) out.push(`  --${t.name}: ${value(t.value[themes[0]])};`);
out.push('}');
for (const id of themes.slice(1)) {
  out.push(`[data-theme="${id}"] {`);
  for (const t of tokens.color.tokens) out.push(`  --${t.name}: ${value(t.value[id] ?? t.value[themes[0]])};`);
  out.push('}');
}
out.push(':root {');
for (const family of ['spacing', 'radius', 'measure']) {
  for (const t of tokens[family].tokens) out.push(`  --${t.name}: ${t.value};`);
}
for (const [key, stack] of Object.entries(tokens.type.families)) out.push(`  --font-${key}: ${stack};`);
out.push('}');
for (const group of tokens.type.groups) {
  for (const s of group.styles) {
    out.push(`.${s.name} {`);
    out.push(`  font-family: var(--font-${s.family ?? group.family});`);
    out.push(`  font-size: ${s.fontSize};`, `  line-height: ${s.lineHeight};`, `  font-weight: ${s.fontWeight};`);
    out.push(`  letter-spacing: ${s.letterSpacing ?? 'normal'};`);
    if (s.fontStyle === 'italic') out.push('  font-style: italic;');
    out.push('}');
  }
}
for (const f of tokens.type.fonts) {
  out.push('@font-face {');
  out.push(`  font-family: "${f.family}";`);
  out.push(`  src: url("/${f.file}") format("woff2");`);
  out.push(`  font-weight: ${f.weight};`, `  font-style: ${f.style};`, '  font-display: swap;');
  out.push('}');
}
writeFileSync(new URL('src/styles/tokens.css', root), out.join('\n') + '\n');
console.log(`tokens.css: ${tokens.color.tokens.length} colours, ${themes.length} themes, ${tokens.type.fonts.length} fonts`);
