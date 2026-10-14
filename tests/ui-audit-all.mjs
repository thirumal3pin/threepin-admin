// The design audit over every page and view the previews reach (tests/_ui-audit.mjs says what is
// checked). Runs each preview with the audit attached, then prints what it found, worst first.
//   node tests/ui-audit-all.mjs [out.jsonl] [preview-name …]   (npm run audit:ui-all)
// Exit 1 if any overflow, overlap, clipped text, wrong font or contrast failure is found.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PREVIEWS = ['posting-preview', 'posting-roles', 'track-preview', 'brochure-board', 'shoot-extras', 'tags-preview',
  'brochure-code-preview', 'series-editor-preview', 'posting-brochure-preview', 'appnav-preview', 'crm-today-preview',
  'today-invites-preview', 'crm-lead-panel-preview', 'crm-calendar-preview', 'crm-assign-agent', 'crm-lead-agent',
  'crm-pipeline-preview', 'crm-scroll-preview', 'crm-tailortalk-preview', 'crm-conversation-preview', 'crm-attio-preview',
  'dashboard-sync-preview', 'property-mobile-preview', 'map-preview', 'match-preview', 'search-preview', 'brief-preview',
  'analytics-preview', 'app-preview', 'home-preview'];
const [outArg, ...only] = process.argv.slice(2);
const OUT = outArg || join(tmpdir(), 'ui-audit.jsonl');
writeFileSync(OUT, '');
const shotsDir = join(tmpdir(), 'ui-audit-shots');
mkdirSync(shotsDir, { recursive: true });
const list = only.length ? only : PREVIEWS;
for (const t of list) {
  if (!existsSync(`tests/${t}.mjs`)) { console.log(`${t}: (no such preview)`); continue; }
  const r = spawnSync(process.execPath, ['--import', './tests/_ui-audit.mjs', `tests/${t}.mjs`, join(shotsDir, t)],
    { env: { ...process.env, UI_AUDIT_OUT: OUT, UI_AUDIT_TEST: t }, encoding: 'utf8', timeout: 600000 });
  console.log(`${t}: exit ${r.status}`);
}
const lines = readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const HARD = ['overflow', 'overlap', 'clipped', 'font', 'contrast'];
const total = {};
for (const l of lines) for (const [k, v] of Object.entries(l.count || {})) total[k] = (total[k] || 0) + v;
console.log(`\n${lines.length} screens audited (each as shot and in the other scheme)`);
console.log('totals:', JSON.stringify(total));
for (const kind of [...HARD, 'small', 'target']) {
  const hits = lines.filter(l => l.count && l.count[kind]);
  if (!hits.length) continue;
  console.log(`\n── ${kind} (${hits.length} screens) ──`);
  const ex = new Map();
  for (const l of hits) for (const i of l.issues.filter(i => i.kind === kind)) {
    const key = i.el + ' ' + i.detail.replace(/[\d.]+:1.*/, '');
    if (!ex.has(key)) ex.set(key, `${l.test}/${l.shot} [${l.scheme}, ${l.width}px] ${i.el} "${i.text}" — ${i.detail}`);
  }
  [...ex.values()].slice(0, 40).forEach(x => console.log('  ' + x));
  if (ex.size > 40) console.log(`  … ${ex.size - 40} more`);
}
const errs = lines.filter(l => l.error);
if (errs.length) { console.log('\naudit errors:'); errs.slice(0, 10).forEach(e => console.log('  ' + e.test + ' ' + e.shot + ': ' + e.error)); }
process.exit(HARD.some(k => total[k]) ? 1 : 0);
