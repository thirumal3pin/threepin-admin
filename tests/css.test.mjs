// Every stylesheet — each .css file and each inline <style> in the pages — well-formed: braces that
// pair up, comments and strings closed. A stray "}" is not an error any browser reports: it silently
// throws away the rule that follows (a whole @media block on the Dashboard went unseen that way).
//   node tests/css.test.mjs
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const sources = [];
for (const d of ['crm-assets', 'track-assets', 'dashboard-assets', 'finance-assets', 'shared-assets', 'shared-assets/fonts', 'home-assets']) {
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
process.exit(failed ? 1 : 0);
