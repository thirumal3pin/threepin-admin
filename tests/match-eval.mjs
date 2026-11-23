// ═══════ MATCHING — MEASURED ═══════
//
//   node tests/match-eval.mjs                       this checkout's engine, every source
//   node tests/match-eval.mjs --engine=../other     another checkout's engine (e.g. main, before)
//   node tests/match-eval.mjs --json                also write tests/out/match-eval.json
//
// Runs the hand-labelled set in tests/fixtures/match-eval-data.mjs and prints, per query and
// overall:
//   P@5, P@10   share of the top 5 / 10 that are relevant (grade ≥ 1), out of what COULD be —
//               min(k, relevant) — so a query with two right answers is not capped at 40%.
//   R@10        relevant found in the top 10 / all relevant.
//   nDCG@10     ranking quality with grades (exact fit 2, alternative 1).
//   FP          a "never" item shown as a match (not ruled out): wrong deal, kind, a refused place,
//               sold or closed. FP rate = never-items shown / never-items judged.
//   FN          a relevant item not returned at all (any rank). FN rate = missed / relevant.
//   Coverage    relevant items NOT yet onboarded (cards, seller leads, submissions) found.
// and extraction accuracy: each field of each EXTRACTION entry read correctly by the parser.
//
// An engine without PinSources (before Nov 2026) is run the way the screens ran it then: over the
// onboarded inventory only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as DATA from './fixtures/match-eval-data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = k => (process.argv.find(a => a.startsWith('--' + k + '=')) || '').split('=')[1];
const root = path.resolve(here, '..', arg('engine') ? path.relative(path.resolve(here, '..'), path.resolve(arg('engine'))) : '.');
const load = f => { const p = path.join(root, ...f.split('/')); if (fs.existsSync(p)) new Function(fs.readFileSync(p, 'utf8'))(); return fs.existsSync(p); };
load('dashboard-assets/search-engine.js'); load('shared-assets/chennai-geo.js'); load('shared-assets/area-model.js'); load('shared-assets/match-engine.js');
const hasSources = load('shared-assets/match-sources.js');
const M = globalThis.PinMatch, PS = globalThis.PinSources;
const NOW = DATA.NOW;

// ── run one engine ──
const stageKeyOf = l => (/lost/.test(l.stageId || '') ? 'lost' : /won/.test(l.stageId || '') ? 'won' : null);
let unified = null;
if (hasSources) unified = PS.buildUnified({ properties: DATA.PROPERTIES, listings: DATA.LISTINGS, leads: DATA.LEADS, submissions: DATA.SUBMISSIONS, trackStages: DATA.TRACK_STAGES });
const idOfRow = r => (r.link ? r.link.id : String(r.p && r.p.id));

function forward(text) {
  if (hasSources) return PS.findProperties(text, unified, { now: NOW }).filter(r => !r.vetoed).map(r => ({ id: idOfRow(r), pct: r.pct }));
  return M.propertiesFor(M.briefProfile(text, { now: NOW }), DATA.PROPERTIES, { now: NOW, minPct: 50 }).filter(r => !r.vetoed).map(r => ({ id: String(r.p.id), pct: r.pct }));
}
function typedProperty(d) {
  if (hasSources) return PS.propertyFromDetails(d);
  // What the old screens could do with typed details: a property-shaped record through the profiler.
  return M.propertyProfile({ id: '__typed__', name: 'Typed', type: d.type, config: d.bhk + ' BHK', location: d.location, startingPrice: String(d.price), sqftRange: d.area + ' sqft', saleType: d.condition === 'resale' ? 'Resale' : '' });
}
function reverse(q) {
  let prop;
  if (q.details) prop = typedProperty(q.details);
  else if (q.listingId) {
    if (hasSources) prop = unified.find(e => e.src && e.src.ids.listingId === q.listingId);
    else { const li = DATA.LISTINGS.find(x => x.id === q.listingId); prop = M.listingProfile(li, { lead: DATA.LEADS.find(l => l.listingId === li.id) }); }
  } else prop = M.propertyProfile(DATA.PROPERTIES.find(p => p.id === q.propertyId));
  if (hasSources) return PS.findClients(prop, DATA.LEADS, { inventory: DATA.PROPERTIES, unified, stages: DATA.STAGES, now: NOW }).filter(r => !r.vetoed).map(r => ({ id: r.leadId, pct: r.pct }));
  return M.buyersFor(prop, DATA.LEADS, { inventory: DATA.PROPERTIES, now: NOW, minPct: 50, stageKeyOf }).filter(r => !r.vetoed).map(r => ({ id: String(r.lead.id), pct: r.pct }));
}

// ── metrics ──
const UNONBOARDED = id => /^(L|S|U)\d/.test(id);
function metrics(q, ranked) {
  const grade = id => (q.g2.includes(id) ? 2 : q.g1.includes(id) ? 1 : 0);
  const rel = [...q.g2, ...q.g1];
  const ids = ranked.map(r => r.id);
  const topk = k => ids.slice(0, k).filter(id => grade(id) > 0).length;
  const pAt = k => (rel.length ? topk(k) / Math.min(k, rel.length) : 1);
  const dcg = ids.slice(0, 10).reduce((n, id, i) => n + (2 ** grade(id) - 1) / Math.log2(i + 2), 0);
  const ideal = rel.map(grade).sort((a, b) => b - a).slice(0, 10).reduce((n, g, i) => n + (2 ** g - 1) / Math.log2(i + 2), 0);
  const fp = q.never.filter(id => ids.includes(id));
  const fn = rel.filter(id => !ids.includes(id));
  const unRel = rel.filter(UNONBOARDED);
  return {
    id: q.id, test: q.test, p5: pAt(5), p10: pAt(10), r10: rel.length ? topk(10) / rel.length : 1, ndcg: ideal ? dcg / ideal : 1,
    fp, fn, fpN: fp.length, neverN: q.never.length, fnN: fn.length, relN: rel.length,
    unFound: unRel.filter(id => ids.includes(id)).length, unN: unRel.length,
    top: ranked.slice(0, 5).map(r => `${r.id}${grade(r.id) === 2 ? '✓' : grade(r.id) === 1 ? '~' : q.never.includes(r.id) ? '✗' : ''} ${r.pct}%`)
  };
}

// ── extraction ──
function extraction() {
  const fields = [];
  for (const e of DATA.EXTRACTION) {
    const r = M.briefProfile(e.text, { now: NOW });
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const sorted = a => (a || []).slice().sort();
    const check = (name, got, want) => fields.push({ text: e.text, field: name, ok: same(got, want), got, want });
    if ('deal' in e) check('deal', r.deal ? sorted(r.deal.values) : null, sorted(e.deal));
    if ('types' in e) check('types', r.types && !r.types.residentialOnly ? sorted(r.types.values) : null, sorted(e.types));
    if ('sub' in e) check('sub', r.types && r.types.subs ? Object.values(r.types.subs)[0] || null : null, e.sub);
    if ('bhk' in e) check('bhk', r.bhk ? r.bhk.values : null, e.bhk);
    if ('loc' in e) check('locations', r.localities ? sorted(r.localities.keys) : null, sorted(e.loc));
    if ('exclude' in e) check('exclude', r.localities && r.localities.exclude ? sorted(r.localities.exclude) : [], sorted(e.exclude));
    if ('anywhere' in e) check('anywhere', !!(r.localities && r.localities.anywhere), e.anywhere);
    if ('corridor' in e) check('corridor', r.localities && r.localities.corridors && r.localities.corridors.includes(e.corridor) ? e.corridor : null, e.corridor);
    if ('radiusKm' in e) check('radius', r.localities ? r.localities.radiusKm || null : null, e.radiusKm);
    if ('budgetMax' in e) check('budget', r.budget ? Math.round(r.budget.max) : null, e.budgetMax);
    if ('budgetMin' in e) check('budget min', r.budget ? Math.round(r.budget.min) : null, e.budgetMin);
    if ('mode' in e) check('budget kind', r.budget ? r.budget.mode : null, e.mode);
    if ('flexible' in e) check('flexible', !!(r.budget && r.budget.flexible), e.flexible);
    if ('sizeMin' in e) check('size', r.size ? Math.round(r.size.min) : null, e.sizeMin);
    if ('sizeMax' in e) check('size max', r.size ? Math.round(r.size.max) : null, e.sizeMax);
    if ('sizeUnit' in e) check('land unit', r.size ? r.size.unit || null : null, e.sizeUnit);
    if ('specs' in e) check('asks', sorted((r.specs && r.specs.keys) || []).filter(k => e.specs.includes(k)), sorted(e.specs));
    if ('saleType' in e) check('new/resale', (r.facets && r.facets.saleType) || null, e.saleType);
    if ('possession' in e) check('possession', r.possession ? r.possession.want : null, e.possession);
  }
  return fields;
}

// ── report ──
const pct = n => (n * 100).toFixed(0) + '%';
const rowsF = DATA.QUERIES.map(q => metrics(q, forward(q.text)));
const rowsR = DATA.REVERSE.map(q => metrics(q, reverse(q)));
const all = rowsF.concat(rowsR);
const avg = (list, k) => list.reduce((n, r) => n + r[k], 0) / list.length;
const sum = (list, k) => list.reduce((n, r) => n + r[k], 0);
const ex = extraction();

console.log(`\nEngine: ${root}${hasSources ? '' : '  (no PinSources — onboarded inventory only, as the screens ran it)'}\n`);
console.log('query  test                     P@5   P@10  R@10  nDCG  FP  FN  top 5');
for (const r of all) {
  console.log(`${r.id.padEnd(6)} ${r.test.padEnd(24)} ${pct(r.p5).padStart(4)}  ${pct(r.p10).padStart(4)}  ${pct(r.r10).padStart(4)}  ${r.ndcg.toFixed(2)}  ${String(r.fpN).padStart(2)}  ${String(r.fnN).padStart(2)}  ${r.top.join(', ')}`);
  if (r.fp.length) console.log(`       shown but should never be: ${r.fp.join(', ')}`);
  if (r.fn.length) console.log(`       not found: ${r.fn.join(', ')}`);
}
const summary = {
  queries: all.length,
  p5: avg(all, 'p5'), p10: avg(all, 'p10'), r10: avg(all, 'r10'), ndcg: avg(all, 'ndcg'),
  fpRate: sum(all, 'fpN') / sum(all, 'neverN'), fnRate: sum(all, 'fnN') / sum(all, 'relN'),
  coverage: sum(rowsF, 'unN') ? sum(rowsF, 'unFound') / sum(rowsF, 'unN') : 1,
  extraction: ex.filter(f => f.ok).length / ex.length, extractionFields: ex.length
};
console.log('\n── Overall ──');
console.log(`Precision@5 ${pct(summary.p5)} · Precision@10 ${pct(summary.p10)} · Recall@10 ${pct(summary.r10)} · nDCG@10 ${summary.ndcg.toFixed(2)}`);
console.log(`False positive rate ${pct(summary.fpRate)} (${sum(all, 'fpN')} of ${sum(all, 'neverN')} must-not items shown) · False negative rate ${pct(summary.fnRate)} (${sum(all, 'fnN')} of ${sum(all, 'relN')} relevant missed)`);
console.log(`Not-yet-onboarded relevant stock found: ${pct(summary.coverage)} (${sum(rowsF, 'unFound')} of ${sum(rowsF, 'unN')})`);
console.log(`Requirement extraction: ${pct(summary.extraction)} of ${ex.length} fields read correctly`);
const wrong = ex.filter(f => !f.ok);
if (wrong.length) { console.log('  misread:'); wrong.forEach(f => console.log(`   · ${f.field}: got ${JSON.stringify(f.got)}, want ${JSON.stringify(f.want)} — "${f.text.slice(0, 70)}"`)); }

if (process.argv.includes('--json')) {
  fs.mkdirSync(path.join(here, 'out'), { recursive: true });
  fs.writeFileSync(path.join(here, 'out', 'match-eval.json'), JSON.stringify({ engine: root, sources: hasSources, summary, rows: all, extraction: ex }, null, 2));
}
export { summary };
