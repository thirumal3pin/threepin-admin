// ═══════ MATCH PAGE AGAINST A SNAPSHOT OF THE LIVE DATA — local only ═══════
//
// Brings up tests/_agent-stack.mjs (Firestore emulator with the real rules, the real server code
// incl. /api/match), loads a PRIVATE snapshot of the live data into the emulator, and drives
// match.html as an admin (1280×900) and an agent (390×844).
//
// The snapshot never enters the repo: pass its path in MATCH_SNAPSHOT (JSON { leads, props, listings,
// tp, pl }). Nothing touches the live database.
//
//   JAVA_HOME=… MATCH_SNAPSHOT=/path/live.json node tests/match-live-e2e.mjs            run every scenario in tests/match-live/
//   … node tests/match-live-e2e.mjs --serve 8799                                       keep the stack up; POST a scenario file path to
//                                                                                     http://127.0.0.1:8799/ to run it (fast iteration)
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startStack, T } from './_agent-stack.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'tests/out/match-live');
mkdirSync(OUT, { recursive: true });
const SNAP = process.env.MATCH_SNAPSHOT;
if (!SNAP) { console.error('Set MATCH_SNAPSHOT to the snapshot JSON'); process.exit(2); }
const live = JSON.parse(readFileSync(SNAP, 'utf8'));

const S = await startStack({ emuPort: Number(process.env.E2E_EMU_PORT) || 8691, webPort: Number(process.env.E2E_WEB_PORT) || 8692, rich: false });
const { db } = S;

// ── Seed: the live snapshot, minus the stack's own made-up records ──
async function seed() {
  for (const id of ['ANR001', 'ADY002', 'VEL003', 'ECR004']) await db.collection('properties').doc(id).delete();
  for (const id of ['lead_1', 'lead_2', 'lead_3', 'lead_4']) await db.collection('leads').doc(id).delete();
  const put = async (col, rows) => {
    for (let i = 0; i < rows.length; i += 400) {
      const b = db.batch();
      rows.slice(i, i + 400).forEach(r => b.set(db.collection(col).doc(String(r.id)), { ...r, tenantId: T }));
      await b.commit();
    }
  };
  // Some agents of our own: Rameez works a few real buyers and one real property; Kavya a couple.
  const leads = live.leads.map(l => ({ ...l }));
  const buyers = leads.filter(l => l.stageId !== 'closed_lost' && !/seller|vendor/i.test(l.enquiryType || '') && /anna nagar|adyar|velachery|porur/i.test(String(l.propertyInterest || '') + ' ' + String(l.budget || '')));
  const rameezLeads = buyers.slice(0, 3), kavyaLeads = buyers.slice(3, 5);
  rameezLeads.forEach(l => { l.assignedAgent = 'rameez@threepin.in'; });
  kavyaLeads.forEach(l => { l.assignedAgent = 'kavya@threepin.in'; });
  const props = live.props.map(p => ({ ...p }));
  const rameezProp = props.find(p => /anna nagar/i.test(p.location || '') && !p.soldOut) || props[0];
  rameezProp.assignedAgent = 'rameez@threepin.in';
  await put('properties', props);
  await put('listings', live.listings);
  await put('leads', leads);
  await db.collection('trackPipelines').doc(T).set({ ...live.tp, tenantId: T });
  await db.collection('pipelines').doc(T).set({ ...live.pl, tenantId: T });
  const { rebuildLeadViews } = await import('../api/_lead-views.js');
  await rebuildLeadViews(db, T, leads.map(l => ({ ...l, tenantId: T })), Date.now());
  return { rameezLeads: rameezLeads.map(l => l.id), kavyaLeads: kavyaLeads.map(l => l.id), rameezProp: rameezProp.id };
}
const t0 = Date.now();
const seeded = await seed();
console.log('seeded in', Date.now() - t0, 'ms', JSON.stringify({ rameezLeads: seeded.rameezLeads.length, kavyaLeads: seeded.kavyaLeads.length }));

// ── Pages and helpers the scenarios share ──
async function open(who, viewport) {
  const { ctx, page } = await S.as(who, { viewport });
  page.__net = [];
  page.on('requestfailed', r => page.__net.push('FAILED ' + r.method() + ' ' + r.url().slice(0, 140) + ' ' + (r.failure() || {}).errorText));
  page.on('response', r => { if (r.status() >= 400 && !/favicon|gstatic|googleapis\.com\/.*Listen|webmanifest/.test(r.url())) page.__net.push(r.status() + ' ' + r.url().slice(0, 140)); });
  return { ctx, page };
}
const admin = await open('thirumal', { width: 1280, height: 900 });
const agent = await open('rameez', { width: 390, height: 844 });
const ctx = { S, live, seeded, admin, agent, OUT, open, T };

async function runScenario(file) {
  const logs = [];
  const log = (...a) => { const s = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); logs.push(s); console.log(s); };
  try {
    const mod = await import(pathToFileURL(file).href + '?t=' + Date.now());
    await mod.default({ ...ctx, log });
  } catch (e) { log('SCENARIO ERROR', e && e.stack || String(e)); }
  return logs.join('\n');
}

const serveAt = process.argv.indexOf('--serve');
if (serveAt > -1) {
  const port = Number(process.argv[serveAt + 1]) || 8799;
  http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const file = Buffer.concat(chunks).toString().trim();
    if (file === 'STOP') { res.end('bye'); await S.stop(); process.exit(0); }
    const out = await runScenario(file);
    res.end(out);
  }).listen(port, '127.0.0.1', () => console.log('READY on', port, S.BASE));
} else {
  const dir = join(ROOT, 'tests/match-live');
  for (const f of readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort()) { console.log('\n══ ' + f); await runScenario(join(dir, f)); }
  await S.stop();
}
