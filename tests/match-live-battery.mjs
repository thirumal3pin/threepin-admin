// ═══════ MATCHING — EVERY REAL REQUIREMENT, EVERY REAL PROPERTY, CHECKED AGAINST THE RULES ═══════
//
//   node tests/match-live-battery.mjs <snapshot.json>
//
// The snapshot is a private copy of the live data ({ leads, props, listings, tp, pl }); it is read
// from wherever it is kept and never committed. Every open buyer's every requirement is matched
// against everything we hold, every property opportunity is matched against every client, and 60
// properties described in words (none of them in the records) are matched too. Each answer is
// checked against rules no match may break; anything that breaks one is printed with the client's
// NAME only (never a number). Also: which way the search box reads 40 sentences, name and number
// look-up, and the time every call takes.

import fs from 'node:fs';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('usage: node tests/match-live-battery.mjs <snapshot.json>'); process.exit(2); }
const D = JSON.parse(fs.readFileSync(file, 'utf8'));
const api = await import('../api/_match.js');
const M = globalThis.PinMatch, PS = globalThis.PinSources, G = globalThis.PinGeo;
api.__setSource(() => ({ properties: D.props, listings: D.listings, leads: D.leads, submissions: [], trackStages: D.tp.stages, stages: D.pl.stages }));
const data = await api.loadAll(null, 't');
const U = data.unified;
const staff = { me: 'qa@threepin.in', agent: false, team: [] };
const user = { tenantId: 't_3pinrealty' };
const stageKind = id => ((D.pl.stages || []).find(s => s.id === id) || {}).kind || 'open';

const problems = {};
const add = (rule, example) => { (problems[rule] = problems[rule] || []).push(example); };
const times = [];
const timed = (label, fn) => { const t = performance.now(); try { return fn(); } finally { times.push([label, performance.now() - t]); } };
const name = l => (l && l.name ? String(l.name).slice(0, 30) : '(no name)');

// ── The rules a shown (not ruled-out) match may never break ──
function checkPair(req, prop, row, who, what) {
  const tag = `${who} ⇄ ${what} (${row.pct}%)`;
  if (!(row.pct >= 0 && row.pct <= 100)) add('score outside 0–100', tag);
  if (!row.breakdown || !row.breakdown.length) add('a score with no breakdown', tag);
  const has = prop.deal || 'sale';
  if (req.deal && req.deal.values.length === 1) {
    const w = req.deal.values[0];
    if (w === 'rent' && has !== 'rent') add('a tenant shown a property for sale', tag);
    if (w === 'sale' && has === 'rent') add('a buyer shown a rental', tag);
    if (w === 'jv' && !prop.jv && !['Plot', 'House', 'Other'].includes(prop.type)) add('a JV seeker shown built stock', tag);
  }
  // A rate per sq ft against a sale property's rate is a fair comparison; anything else across kinds is not.
  if (req.budget && prop.priceLo != null && req.budget.mode !== prop.priceMode && !(req.budget.mode === 'psf' && prop.priceMode === 'sale') && row.breakdown.some(b => b.key === 'budget' && !b.unknown)) add('rent compared with a sale price', tag);
  const RESI = ['Apartment', 'Villa', 'House'];
  if (req.types && prop.type && prop.type !== 'Other') {
    const wantsResi = req.types.values.some(t => RESI.includes(t));
    if (wantsResi && !req.types.values.includes(prop.type) && (prop.type === 'Plot' || prop.type === 'Commercial')) add('a home buyer shown land / commercial', tag);
    if (!wantsResi && RESI.includes(prop.type)) add('a land / commercial seeker shown a home', tag);
  }
  const ex = req.localities && req.localities.exclude;
  if (ex && ex.length && (prop.localities || []).some(k => ex.includes(k))) add('a place they ruled out shown', tag);
  if (row.pct >= 85) {
    const loc = row.breakdown.find(b => b.key === 'locality');
    if (loc && !loc.unknown && loc.s < 0.8) add('"strong" though the area is off', tag + ' — ' + loc.why);
  }
  if (req.bhk && prop.bhk && prop.bhk.length && row.pct >= 85 && !prop.bhk.some(n => req.bhk.values.includes(n))) add('"strong" with the wrong BHK', tag);
}

// ── 1. Every open buyer → properties ──
const buyers = D.leads.filter(l => M.isBuyerLead(l) && stageKind(l.stageId) !== 'lost' && stageKind(l.stageId) !== 'won');
let fwdRows = 0, fwdLeads = 0, fwdEmpty = 0, fwdErr = 0, withUnon = 0;
for (const l of buyers) {
  let profs;
  try { profs = M.requirementProfiles(l, { inventory: U.raw }); } catch (e) { fwdErr++; add('reading a lead crashed', name(l) + ': ' + e.message); continue; }
  for (const req of profs) {
    if (!(req.budget || req.localities || req.bhk || req.types)) continue;
    fwdLeads++;
    let rows;
    try { rows = timed('properties for a lead', () => PS.findProperties(req, U, {})); } catch (e) { fwdErr++; add('properties for a lead crashed', name(l) + ': ' + e.message); continue; }
    if (!rows.length) fwdEmpty++;
    if (rows.some(r => r.source !== 'onboarded')) withUnon++;
    const seen = new Set();
    for (const r of rows) {
      fwdRows++;
      if (seen.has(r.id)) add('the same property listed twice', name(l) + ' → ' + r.name); seen.add(r.id);
      if (!r.sourceLabel || !r.status && r.source !== 'onboarded') add('a row without source / status', r.name);
      if (!r.next) add('a row without a next step', r.name);
      if (r.source !== 'onboarded' && r.verified) add('an un-onboarded row marked verified', r.name);
      if (/untitled|^seller enquiry —/i.test(r.name || '') && r.location) add('a weak name when the place is known', r.name);
      const prop = U.find(e => e.src && e.src.link.type + ':' + e.src.link.id === r.id);
      if (prop) checkPair(req, prop, r, name(l), r.name);
    }
  }
}

// ── 2. Every property opportunity → clients ──
let revRows = 0, revProps = 0, revErr = 0, revEmpty = 0;
const byId = new Map(D.leads.map(l => [String(l.id), l]));
for (const e of U) {
  revProps++;
  let rows;
  try { rows = timed('clients for a property', () => PS.findClients(e, D.leads, { inventory: U.raw, unified: U, stages: D.pl.stages })); } catch (err) { revErr++; add('clients for a property crashed', e.name + ': ' + err.message); continue; }
  if (!rows.length) revEmpty++;
  for (const r of rows) {
    revRows++;
    const l = byId.get(r.leadId);
    if (!l) { add('a client row for an unknown lead', r.name); continue; }
    if (['lost', 'won'].includes(stageKind(l.stageId))) add('a closed (won/lost) client offered', name(l) + ' for ' + e.name);
    if (PS.isSellerLead(l)) add('a seller offered as a buyer', name(l) + ' for ' + e.name);
    const req = M.requirementProfiles(l, { inventory: U.raw }).find(p => p.reqIndex === r.reqIndex) || M.requirementProfile(l, {});
    checkPair(req, e, r, name(l), e.name);
  }
}

// ── 3. Properties described in words, not in the records ──
const PLACES = ['Anna Nagar', 'Adyar', 'Velachery', 'Porur', 'T Nagar', 'Kilpauk', 'Mogappair', 'Perungudi', 'Tambaram', 'Nungambakkam', 'Medavakkam', 'Valasaravakkam', 'Thoraipakkam', 'Chromepet', 'Besant Nagar', 'Mylapore', 'Ambattur', 'Sholinganallur', 'Guindy', 'Pallikaranai'];
const typed = [];
let k = 0;
for (const place of PLACES) {
  const i = k++;
  typed.push({ text: `${2 + (i % 3)} BHK apartment in ${place}, ${1100 + 300 * (i % 4)} sqft, ${(0.9 + 0.35 * (i % 6)).toFixed(2)} Cr, ${i % 2 ? 'resale, east facing, covered parking' : 'new, ready to move, lift, gated community'}`,
    want: { type: 'Apartment', deal: 'sale', bhk: 2 + (i % 3), place } });
  typed.push({ text: `${2 + (i % 2)} BHK flat for rent in ${place}, ${18 + 6 * (i % 5)}k per month, semi furnished, ${i % 3 + 1}st floor`,
    want: { type: 'Apartment', deal: 'rent', bhk: 2 + (i % 2), place } });
  typed.push({ text: i % 2 ? `${1 + (i % 3)} grounds land for sale in ${place}, ${(1.5 + i % 5).toFixed(1)} Cr, DTCP approved` : `Commercial space for rent in ${place}, ${2000 + 500 * (i % 4)} sqft, ${(1.2 + 0.4 * (i % 4)).toFixed(1)} L per month, main road frontage`,
    want: i % 2 ? { type: 'Plot', deal: 'sale', place } : { type: 'Commercial', deal: 'rent', place } });
}
let typedRows = 0, typedEmpty = 0, typedMisread = 0;
for (const t of typed) {
  let prop, rows;
  try { prop = PS.propertyFromBrief(t.text); } catch (e) { add('reading a typed property crashed', t.text + ': ' + e.message); continue; }
  const got = { type: prop.type, deal: prop.deal, bhk: (prop.bhk || [])[0], place: (prop.localities || []).map(x => G.label(x)) };
  const mis = [];
  if (got.type !== t.want.type) mis.push(`type ${got.type}`);
  if ((got.deal || 'sale') !== t.want.deal) mis.push(`deal ${got.deal}`);
  if (t.want.bhk && got.bhk !== t.want.bhk) mis.push(`bhk ${got.bhk}`);
  if (!got.place.some(p => p.toLowerCase() === t.want.place.toLowerCase())) mis.push(`place ${got.place.join('/')}`);
  if (prop.priceLo == null) mis.push('no price');
  if (mis.length) { typedMisread++; add('a typed property read wrongly', `"${t.text}" → ${mis.join(', ')}`); }
  try { rows = timed('clients for a typed property', () => PS.findClients(prop, D.leads, { inventory: U.raw, unified: U, stages: D.pl.stages })); } catch (e) { add('clients for a typed property crashed', t.text + ': ' + e.message); continue; }
  if (!rows.length) typedEmpty++;
  for (const r of rows) {
    typedRows++;
    const l = byId.get(r.leadId);
    if (!l) continue;
    if (['lost', 'won'].includes(stageKind(l.stageId))) add('a closed (won/lost) client offered', name(l) + ' for typed ' + t.text.slice(0, 40));
    if (PS.isSellerLead(l)) add('a seller offered as a buyer', name(l) + ' for typed ' + t.text.slice(0, 40));
    const req = M.requirementProfiles(l, { inventory: U.raw }).find(p => p.reqIndex === r.reqIndex) || M.requirementProfile(l, {});
    checkPair(req, prop, r, name(l), 'typed: ' + t.text.slice(0, 40));
  }
}
// Extras said in words must reach the property: facing, parking, floor, furnishing, resale.
{
  const p = PS.propertyFromBrief('3 BHK apartment in Anna Nagar, 2000 sqft, 3.2 Cr, resale, east facing, covered parking, 5th floor, semi furnished, vastu, gated community with pool');
  const want = { facing: p.facing.includes('East'), parking: (p.parkingKind || []).includes('Covered'), floor: p.floorNo === 5, furnishing: /semi/i.test(p.furnishing), resale: p.saleType === 'Resale', vastu: p.vastu === true, gated: p.gated === true, pool: (p.amenityTags || []).includes('pool'), price: p.priceLo === 32000000, size: p.areaLo === 2000 };
  Object.entries(want).filter(([, ok]) => !ok).forEach(([kk]) => add('a detail said in words did not reach the property', kk));
}

// ── 4. Which way the search box reads ──
const ROUTES = [
  ['2 BHK in Anna Nagar under 2 Cr', 'properties'], ['3bhk anna nagr 3 cr not mogappair', 'properties'], ['villa in ECR with pool', 'properties'], ['land for sale in Porur', 'properties'],
  ['office space for rent OMR', 'properties'], ['2bhk for rent velachery 25k', 'properties'], ['Find all 2 BHK apartments in Anna Nagar under ₹2 Cr', 'properties'],
  ['Find 2 grounds of land for sale in Choolaimedu', 'properties'], ['Commercial spaces for rent in Valasaravakkam under ₹2.5 Lakhs per month', 'properties'],
  ['Find all buyers looking for 3 BHK apartments in Adyar', 'clients'], ['Show clients looking for properties above ₹3 Cr in Chennai', 'clients'], ['buyers for 3bhk anna nagar', 'clients'],
  ['who wants a villa in ECR', 'clients'], ['tenants looking for 2bhk in Perungudi', 'clients'], ['Find buyers looking for villas in ECR', 'clients'],
  ['Find unprocessed seller leads that match active buyer requirements', 'demand'], ['Find all active requirements matching properties currently in the Shoot stage', 'demand'],
  ['Show properties in the CRM that are not yet onboarded but have matching clients', 'demand'], ['seller leads with buyers', 'demand'],
  ['Find sellers with commercial properties in T. Nagar', 'properties'],
];
for (const [t, want] of ROUTES) {
  const q = PS.parseSmartQuery(t);
  if (q.direction !== want) add('the search box read the direction wrongly', `"${t}" → ${q.direction}, want ${want}`);
}
for (const t of ['3 BHK apartment in Anna Nagar 3 Cr resale', 'plot Tambaram 50 L', 'commercial space for rent T Nagar 4 L', 'around 2000 sqft apartment in anna nagar']) {
  const o = await api.runSearch({ db: null, user, body: { mode: 'smart', text: t, prefer: 'clients' }, viewer: staff, data });
  if (o.mode !== 'clients') add('on "Find clients" plain words did not find clients', `"${t}" → ${o.mode}`);
}

// ── 5. Name and number look-up ──
let nameTried = 0, nameMissed = 0;
for (const l of buyers.filter((x, i) => i % 15 === 0 && x.name && /[a-z]{3}/i.test(x.name))) {
  nameTried++;
  const o = await api.runSearch({ db: null, user, body: { mode: 'smart', text: l.name }, viewer: staff, data });
  if (o.mode !== 'pick' || !o.rows.some(r => r.leadId === String(l.id))) {
    // A name that also reads as a requirement ("Anna Nagar Ravi") goes to matching — fine, noted.
    if (o.mode === 'pick') { nameMissed++; add('a client not found by their own name', name(l)); }
  }
  const digits = String(l.phone || '').replace(/\D/g, '').slice(-5);
  if (digits.length === 5) {
    const o2 = await api.runSearch({ db: null, user, body: { mode: 'smart', text: digits }, viewer: staff, data });
    if (o2.mode !== 'pick' || !o2.rows.some(r => r.leadId === String(l.id))) add('a client not found by the last digits of their number', name(l));
  }
}

// ── 6. The agent's view never leaks ──
const agentEmail = (() => { const c = {}; D.leads.forEach(l => { if (l.assignedAgent) c[l.assignedAgent] = (c[l.assignedAgent] || 0) + 1; }); return Object.keys(c).sort((a, b) => c[b] - c[a])[0]; })();
if (agentEmail) {
  const agent = { me: String(agentEmail).toLowerCase(), agent: true, team: [], grants: [], agentSet: new Set([String(agentEmail).toLowerCase()]), cfg: { matchingLeadFields: ['requirement', 'stage'], otherPropertyFields: ['name', 'location', 'config'], tabs: ['properties', 'crm'] } };
  const phones = new Set(D.leads.map(l => String(l.phone || '').replace(/\D/g, '').slice(-10)).filter(x => x.length === 10));
  for (const e of U.filter((x, i) => i % 8 === 0)) {
    const body = e.src.kind === 'onboarded' ? { mode: 'clients', propertyId: e.src.link.id } : e.src.kind === 'listing' ? { mode: 'clients', listingId: e.src.ids.listingId } : { mode: 'clients', sellerLeadId: e.src.ids.leadId };
    const o = await api.runSearch({ db: null, user, body, viewer: agent, data });
    for (const r of o.rows || []) {
      if (r.access !== 'restricted') continue;
      const j = JSON.stringify(r);
      if (r.leadId || r.phone || r.email) add('a restricted row carries an id / phone / email', e.name);
      const digits = j.match(/\d{10}/g) || [];
      if (digits.some(x => phones.has(x))) add('a restricted row carries a client\'s phone number', e.name);
      const l = D.leads.find(x => x.name && x.name.length > 3 && j.includes(x.name) && !AA_visible(x, agent.me));
      if (l && r.name && r.name !== 'A matching client') add('a restricted row carries the client\'s name', e.name);
    }
  }
}
function AA_visible(l, me) { return String(l.assignedAgent || '').toLowerCase() === me || String(l.secondaryAgent || '').toLowerCase() === me || (Array.isArray(l.agentAccess) && l.agentAccess.map(x => String(x).toLowerCase()).includes(me)); }

// ── Report ──
const pctl = (list, p) => { const a = list.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0; };
const byLabel = {};
times.forEach(([lab, ms]) => (byLabel[lab] = byLabel[lab] || []).push(ms));
console.log(`\nData: ${D.leads.length} leads (${buyers.length} open buyers), ${D.props.length} properties, ${D.listings.length} Shoot cards → ${U.length} opportunities (${U.filter(e => e.src.kind !== 'onboarded').length} not onboarded)\n`);
console.log(`Buyers → properties: ${fwdLeads} requirements, ${fwdRows} rows, ${fwdEmpty} with nothing, ${withUnon} include un-onboarded stock, ${fwdErr} crashes`);
console.log(`Properties → clients: ${revProps} opportunities, ${revRows} rows, ${revEmpty} with nobody, ${revErr} crashes`);
console.log(`Typed properties (not in records) → clients: ${typed.length} descriptions, ${typedMisread} read wrongly, ${typedRows} rows, ${typedEmpty} with nobody`);
console.log(`Search box: ${ROUTES.length} sentences routed · name look-up: ${nameTried} tried`);
console.log('\nTime per call (ms):');
Object.entries(byLabel).forEach(([lab, l]) => console.log(`  ${lab.padEnd(30)} median ${pctl(l, 0.5).toFixed(0).padStart(4)} · 95% ${pctl(l, 0.95).toFixed(0).padStart(4)} · worst ${Math.max(...l).toFixed(0)}`));
const rules = Object.keys(problems);
console.log(rules.length ? `\n${rules.length} rule(s) broken:` : '\nNo rule broken.');
for (const r of rules) {
  console.log(`\n✗ ${r} — ${problems[r].length}`);
  [...new Set(problems[r])].slice(0, 6).forEach(x => console.log('   · ' + x));
}
process.exit(rules.length ? 1 : 0);
