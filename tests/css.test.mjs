// Every stylesheet — each .css file and each inline <style> in the pages — well-formed: braces that
// pair up, comments and strings closed. A stray "}" is not an error any browser reports: it silently
// throws away the rule that follows (a whole @media block on the Dashboard went unseen that way).
//   node tests/css.test.mjs
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const sources = [];
for (const d of ['crm-assets', 'track-assets', 'dashboard-assets', 'finance-assets', 'shared-assets', 'shared-assets/fonts', 'home-assets', 'match-assets']) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) if (f.endsWith('.css')) sources.push([join(d, f), readFileSync(join(d, f), 'utf8')]);
}
for (const html of readdirSync('.').filter(f => f.endsWith('.html'))) {
  const blocks = [...readFileSync(html, 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)];
  blocks.forEach((m, i) => sources.push([`${html} <style> #${i + 1}`, m[1]]));
}

function check(css) {
  let depth = 0, line = 1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '\n') { line++; continue; }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) return `a comment opened at line ${line} never closes`;
      line += (css.slice(i, end).match(/\n/g) || []).length;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c && css[j] !== '\n') { if (css[j] === '\\') j++; j++; }
      if (css[j] !== c) return `a string opened at line ${line} never closes`;
      i = j;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return `a "}" with nothing open, at line ${line}`;
  }
  return depth ? `${depth} block(s) never closed` : null;
}

let failed = 0;
for (const [name, css] of sources) {
  const problem = check(css);
  if (problem) { failed++; console.log(`  FAIL  ${name}: ${problem}`); }
}
console.log(failed ? `\n${failed} of ${sources.length} stylesheets are malformed.` : `All good (${sources.length} stylesheets well-formed).`);

// A page's own <style> loads after shared-assets/agent-ui.css, so a copied rule there wins. Two ways
// that silently undid a shared fix: the copy puts back a value a later shared rule changed, or it sets
// one edge (top) while the shared rule sets the other (bottom) — the Team page's "Saved" toast became
// a bar from the header to the bottom of the screen that way.
function rules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = []; let i = 0;
  (function block(media) {
    while (i < css.length) {
      const open = css.indexOf('{', i), close = css.indexOf('}', i);
      if (close !== -1 && (open === -1 || close < open)) { i = close + 1; return; }
      if (open === -1) { i = css.length; return; }
      const head = css.slice(i, open).trim(); i = open + 1;
      if (/^@(media|supports|container)/.test(head)) { block(media ? media + ' & ' + head : head); continue; }
      if (head.startsWith('@')) { let d = 1; while (d && i < css.length) { if (css[i] === '{') d++; else if (css[i] === '}') d--; i++; } continue; }
      const end = css.indexOf('}', i), decls = {};
      for (const d of css.slice(i, end).split(';')) { const k = d.indexOf(':'); if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim(); }
      i = end + 1;
      for (const sel of head.split(',')) out.push({ sel: sel.trim().replace(/\s+/g, ' '), media, decls });
    }
  })('');
  return out;
}
const shared = rules(readFileSync('shared-assets/agent-ui.css', 'utf8'));
const overlaps = (a, b) => a === b || !a || !b;
let clashes = 0;
for (const html of readdirSync('.').filter(f => f.endsWith('.html'))) {
  const src = readFileSync(html, 'utf8');
  const link = src.indexOf('shared-assets/agent-ui.css');
  if (link < 0) continue;
  for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    if (m.index < link) continue;
    for (const r of rules(m[1])) {
      const same = shared.filter(s => s.sel === r.sel && overlaps(s.media, r.media));
      if (!same.length) continue;
      const where = `${html}: ${r.media ? r.media + ' ' : ''}${r.sel}`;
      for (const [k, v] of Object.entries(r.decls)) {
        const set = same.filter(s => s.media === r.media && k in s.decls).map(s => s.decls[k]);
        if (set.length > 1 && set.slice(0, -1).includes(v) && set[set.length - 1] !== v) {
          clashes++; console.log(`  FAIL  ${where} puts back "${k}: ${v}" — agent-ui.css later changes it to "${set[set.length - 1]}"`);
        }
      }
      for (const [a, b] of [['top', 'bottom'], ['bottom', 'top'], ['left', 'right'], ['right', 'left']]) {
        if (!(a in r.decls) || r.decls[a] === 'auto' || b in r.decls) continue;
        let other = null;
        for (const s of same) if (b in s.decls) other = s.decls[b];
        if (other && other !== 'auto') { clashes++; console.log(`  FAIL  ${where} sets ${a} while agent-ui.css sets ${b}: ${other} — both apply and the box stretches`); }
      }
    }
  }
}
console.log(clashes ? `\n${clashes} page rule(s) clash with shared-assets/agent-ui.css.` : 'No page undoes shared-assets/agent-ui.css.');
process.exit(failed || clashes ? 1 : 0);
