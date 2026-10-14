// Every JavaScript file the site, the API and the scripts run — parsed. One stray character in a
// page module stops the whole page (the browser loads nothing of it); this finds it before a page
// does. Inline <script> blocks in the HTML pages are checked too.
//   node tests/syntax.test.mjs
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const DIRS = ['api', 'crm-assets', 'track-assets', 'dashboard-assets', 'finance-assets', 'shared-assets', 'home-assets', 'scripts', 'tests'];
const files = [];
for (const d of DIRS) for (const f of readdirSync(d)) if (['.js', '.mjs'].includes(extname(f))) files.push(join(d, f));
const tmp = mkdtempSync(join(tmpdir(), 'syntax-'));
let n = 0;
for (const html of readdirSync('.').filter(f => f.endsWith('.html'))) {
  const src = readFileSync(html, 'utf8');
  for (const m of src.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/type=["'](?!module|text\/javascript)/.test(m[1])) continue;   // JSON, templates
    const p = join(tmp, `${html.replace(/\W/g, '_')}_${n++}${/module/.test(m[1]) ? '.mjs' : '.js'}`);
    writeFileSync(p, m[2]);
    files.push(p);
  }
}
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { failed++; console.log(`  FAIL  ${f}\n${(r.stderr || '').split('\n').slice(0, 4).map(l => '        ' + l).join('\n')}`); }
}
rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} of ${files.length} files do not parse.` : `All good (${files.length} files parse).`);
process.exit(failed ? 1 : 0);
