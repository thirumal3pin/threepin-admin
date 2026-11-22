// Who gets a Meta ad lead (api/_meta-assign.js through api/_meta-leads.js) and the 9 am round
// (api/_meta-digest.js) — stand-in sheets and database, no network.   node tests/meta-assign.test.mjs
import { createFakeDb } from './_fake-firestore.mjs';
import { SHEETS, SOURCES, NOW, fakeSheetsFetch } from './_meta-leads-fixtures.mjs';
import { metaLeadsAction } from '../api/_meta-leads.js';
import * as MA from '../api/_meta-assign.js';
import { buckets, metaMorning } from '../api/_meta-digest.js';

let n = 0, bad = 0;
const ok = (name, cond, extra) => { n++; if (!cond) { bad++; console.error('✗ ' + name, extra !== undefined ? JSON.stringify(extra) : ''); } };
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const T = 't_3pin';
const TEAM = [
  { email: 'thirumal@threepin.in', uid: 'u_t', role: 'admin', name: 'Thirumal' },
  { email: 'swami@threepin.in', uid: 'u_s', role: 'none', name: 'Swami' },
  { email: 'rameez@threepin.in', uid: 'u_r', role: 'agent', name: 'Rameez' },
  { email: 'ramesh@threepin.in', uid: 'u_m', role: 'agent', name: 'Ramesh' },
];
const U = {
  admin: { tenantId: T, email: 'thirumal@threepin.in', role: 'admin', email_verified: true },
  staff: { tenantId: T, email: 'swami@threepin.in', email_verified: true },
  rameez: { tenantId: T, email: 'rameez@threepin.in', role: 'agent', email_verified: true },
  ramesh: { tenantId: T, email: 'ramesh@threepin.in', role: 'agent', email_verified: true },
};

async function setup() {
  const db = createFakeDb();
  await db.collection('taskConfigs').doc(T).set({ managers: ['thirumal@threepin.in'] });
  await db.collection('properties').doc('KDBMC001').set({ tenantId: T, propertyCode: 'KDBMC001', name: 'Commercial Building for Rent' });
  const sheets = fakeSheetsFetch();
  const mails = [], rebuilt = [];
  let clock = NOW;
  const deps = { db, fetch: sheets.fetch, serviceAccount: { client_email: 'sa@x' }, token: async () => 'tok', now: () => clock,
    team: async () => TEAM, mail: async (to, m) => { mails.push({ to, ...m }); return { ok: true }; },
    rebuildAgents: async (d, t, emails) => { rebuilt.push(...emails); }, appUrl: 'https://admin.example' };
  const act = (who, body, extra = {}) => metaLeadsAction(U[who], body, { ...deps, ...extra });
  await act('admin', { action: 'save', sources: SOURCES });
  return { db, sheets, mails, rebuilt, act, deps, setNow: t => { clock = t; } };
}
const kdb3 = s => s.data.KDB.tabs[1].values;   // Sheet3: Assigned to is column T (19)

// ── The rules ──
eq('The name written is the page\'s own', MA.assignLabel('raj.m@threepin.in'), 'Raj M');
ok('Strict match: exactly the written name, or the address', MA.isExactlyFor('Rameez', 'rameez@threepin.in', TEAM) && MA.isExactlyFor('rameez@threepin.in', 'rameez@threepin.in', TEAM) && !MA.isExactlyFor('Ram', 'rameez@threepin.in', TEAM));
ok('…two people with the same written name: nobody', !MA.isExactlyFor('Raj', 'raj@threepin.in', [{ email: 'raj@threepin.in' }, { email: 'raj@gmail.com' }]));
eq('An agent never assigns', MA.checkAssignEdits(U.rameez, [{ field: 'assigned', value: 'Rameez', from: '' }], TEAM).status, 403);
eq('Staff to an agent: refused', MA.checkAssignEdits(U.staff, [{ field: 'assigned', value: 'Rameez', from: '' }], TEAM).status, 403);
eq('Staff taking a lead from an agent: refused', MA.checkAssignEdits(U.staff, [{ field: 'assigned', value: 'Swami', from: 'Ramesh' }], TEAM).status, 403);
eq('Staff among staff: fine', MA.checkAssignEdits(U.staff, [{ field: 'assigned', value: 'Thirumal', from: '' }], TEAM).ok, true);
eq('An admin to an agent: fine', MA.checkAssignEdits(U.admin, [{ field: 'assigned', value: 'Rameez', from: '' }], TEAM).ok, true);
eq('A blind overwrite of who has a lead (no "from"): refused', MA.checkAssignEdits(U.staff, [{ field: 'assigned', value: 'Thirumal' }], TEAM).status, 409);
eq('Default rule: the sheet\'s own beats the property\'s', MA.ruleFor({ sheets: { S1: { email: 'a@x' } }, props: { KDBMC001: { email: 'b@x' } } }, 'S1', 'KDBMC001').email, 'a@x');
eq('…else the property\'s', MA.ruleFor({ sheets: {}, props: { KDBMC001: { email: 'b@x' } } }, 'S2', 'kdbmc001').scope, 'property');

// ── An admin gives a lead to an agent ──
{
  const { db, sheets, mails, rebuilt, act } = await setup();
  let [r, s] = await act('staff', { action: 'write', spreadsheetId: SHEETS.KDB.id, gid: 222, edits: [{ metaId: 'l:3004', field: 'assigned', value: 'Rameez', from: '' }] });
  eq('Staff cannot give a lead to an agent (server)', s, 403);
  [r, s] = await act('staff', { action: 'write', spreadsheetId: SHEETS.KDB.id, gid: 222, edits: [{ metaId: 'l:3004', col: 19, header: 'Assigned to ', value: 'Rameez', from: '' }] });
  eq('…nor by writing the Assigned to column directly (Edit this row)', s, 403);
  [r, s] = await act('admin', { action: 'write', spreadsheetId: SHEETS.KDB.id, gid: 222, edits: [{ metaId: 'l:3004', field: 'assigned', value: 'Rameez', from: '' }] });
  eq('The admin can: written in the sheet', [s, kdb3(sheets)[4][19]], [200, 'Rameez']);
  const g = (await db.collection('grants').doc(`${T}__p__KDBMC001__rameez_threepin_in`).get()).data();
  ok('…the property is approved to the agent (details, 30 days, not the owner\'s number)', g && g.active && g.via === 'meta-lead' && !g.includeContact && g.expiresAt === NOW + 30 * 86400000, g);
  eq('…their copy is rebuilt so it shows at once', rebuilt, ['rameez@threepin.in']);
  ok('…and they are e-mailed the lead: name, number, property', mails.length === 1 && mails[0].to === 'rameez@threepin.in' && /Saravana/.test(mails[0].subject) && /tel:\+?919042700008|p:\+919042700008/.test(mails[0].html), mails[0] && mails[0].subject);
  const asg = (await db.collection('metaLeadAssign').doc(T).get()).data();
  ok('…and the menu will show them Meta Ads Leads', asg.agents.rameez_threepin_in === NOW);
  // A second lead for the same property: no second grant write.
  await act('admin', { action: 'write', spreadsheetId: SHEETS.KDB.id, gid: 0, edits: [{ metaId: 'l:1005', field: 'assigned', value: 'Rameez', from: '' }] });
  eq('Another lead, same property: the grant is not written again', rebuilt.length, 1);
  // ── What the agent sees ──
  [r, s] = await act('rameez', { action: 'read' }, { agentCodes: new Set() });
  const ids = r.tabs.flatMap(t => t.values.slice(1).filter(x => x.length).map(x => x[0]));
  eq('The agent reads only the leads assigned to them, from any sheet', ids.sort(), ['l:1005', 'l:3004']);
  const t3 = r.tabs.find(t => t.gid === 222);
  ok('…the other rows are blanked, not removed (row numbers stay right)', t3.values.length === SHEETS.KDB.tabs[1].values.length && t3.values[1].length === 0);
  [r] = await act('ramesh', { action: 'read' }, { agentCodes: new Set() });
  eq('Ramesh (written by hand as "Ramesh") sees his one', r.tabs.flatMap(t => t.values.slice(1).filter(x => x.length).map(x => x[0])), ['l:3003']);
  [r] = await act('ramesh', { action: 'read' }, { agentCodes: new Set(['SHR0001']) });
  ok('An agent with the Ads tab still sees every lead of their own property', r.tabs.some(t => t.propertyCode === 'SHR0001' && t.values.length === SHEETS.KOY.tabs[0].values.length));
  // ── What the agent may write ──
  [r, s] = await act('rameez', { action: 'write', spreadsheetId: SHEETS.KDB.id, gid: 222, edits: [{ metaId: 'l:3004', field: 'log', value: 'Called, visiting Sat' }] }, { agentCodes: new Set() });
  eq('The agent writes a note on their own lead', [s, r.applied && r.applied.length], [200, 1]);
  [r, s] = await act('rameez', { action: 'write', spreadsheetId: SHEETS.KDB.id, gid: 222, edits: [{ metaId: 'l:3002', field: 'log', value: 'x' }] }, { agentCodes: new Set() });
  eq('…not on anyone else\'s', s, 403);
  [r, s] = await act('rameez', { action: 'write', spreadsheetId: SHEETS.KDB.id, gid: 222, edits: [{ metaId: 'l:3004', field: 'assigned', value: '', from: 'Rameez' }] }, { agentCodes: new Set() });
  eq('…and never who has it', s, 403);
  [r] = await act('rameez', { action: 'config' }, { agentCodes: new Set() });
  ok('The agent\'s setup says what the page may offer', r.isAgent === true && r.isAdmin === false && r.autoAssign === null && r.agents.includes('ramesh@threepin.in'));
}

// ── A default person for new leads ──
{
  const { db, sheets, mails, act, setNow } = await setup();
  let [r, s] = await act('staff', { action: 'set-auto-assign', scope: 'property', key: 'KDBMC001', email: 'swami@threepin.in' });
  eq('Only an admin sets who gets new leads', s, 403);
  [r, s] = await act('admin', { action: 'set-auto-assign', scope: 'property', key: 'KDBMC001', email: 'nobody@x.in' });
  eq('…and only someone on the team', s, 400);
  // Set on 21 Oct, before Saravana's enquiry (l:3004, unassigned) and after the others.
  setNow(Date.parse('2026-10-21T00:00:00-05:00'));
  [r, s] = await act('admin', { action: 'set-auto-assign', scope: 'property', key: 'KDBMC001', email: 'swami@threepin.in' });
  eq('Set: KDBMC001\'s new leads go to Swami', [s, r.autoAssign.props.KDBMC001.email], [200, 'swami@threepin.in']);
  setNow(NOW);
  [r] = await act('staff', { action: 'read' });
  eq('The next read gives the new, unassigned lead to Swami — in the sheet', kdb3(sheets)[4][19], 'Swami');
  ok('…older leads nobody has stay as they are (it applies from when it was set)', !SHEETS.KDB.tabs[0].values[0].some(h => /assigned/i.test(h)) && !sheets.data.KDB.tabs[0].values[0].some(h => /assigned/i.test(h)));
  ok('…the page gets the rows with the name already in', r.tabs.find(t => t.gid === 222 && t.sourceId === SHEETS.KDB.id).values[4][19] === 'Swami');
  ok('…and Swami is e-mailed (assigned automatically)', mails.length === 1 && mails[0].to === 'swami@threepin.in' && /assigned automatically/.test(mails[0].html));
  await act('staff', { action: 'read' });
  eq('Read again: nothing written or sent twice', mails.length, 1);
  // A sheet's own default beats the property's; removing it changes only what comes next.
  [r, s] = await act('admin', { action: 'set-auto-assign', scope: 'sheet', key: SHEETS.KDO.id, email: 'thirumal@threepin.in' });
  eq('A sheet default is kept', !!r.autoAssign.sheets[SHEETS.KDO.id], true);
  [r] = await act('admin', { action: 'set-auto-assign', scope: 'property', key: 'KDBMC001', email: null });
  ok('Removed: gone from the setup', !r.autoAssign.props.KDBMC001);
  eq('…and Swami keeps the lead already given', kdb3(sheets)[4][19], 'Swami');
  const log = await db.collection('metaLeadEdits').where('tenantId', '==', T).get();
  ok('The automatic assignment is in the edit log', log.docs.some(d => d.data().by === 'auto:property'));
}

// ── The 9 am round ──
{
  const { db, sheets, mails, deps, act } = await setup();
  await act('admin', { action: 'write', spreadsheetId: SHEETS.KDB.id, gid: 222, edits: [{ metaId: 'l:3004', field: 'assigned', value: 'Rameez', from: '' }] });
  mails.length = 0;
  const later = NOW + 2 * 86400000;
  const r = await metaMorning(db, T, { ...deps, now: () => later, anyTenant: true });
  ok('It reads every sheet', r.read >= 4 && !r.error, r);
  const toRameez = mails.find(m => m.to === 'rameez@threepin.in');
  ok('Each person gets their own list — Rameez: Saravana, untouched for over a day', toRameez && /Saravana/.test(toRameez.html) && /untouched for over a day/i.test(toRameez.html), toRameez && toRameez.subject);
  const toMgr = mails.find(m => m.to === 'thirumal@threepin.in' && /nobody|Waiting/i.test(m.html));
  ok('The manager gets the unassigned leads and who is sitting on untouched ones', !!toMgr && /Nobody assigned/.test(toMgr.html));
  ok('Nobody with nothing waiting is e-mailed', !mails.some(m => m.to === 'ramesh@threepin.in' && !/Mari Vel/.test(m.html)));
  const b = buckets([{ sheetTitle: 'X', title: 'S', propertyCode: 'P1', values: [SHEETS.KDB.tabs[1].values[0], ['l:9', new Date(later - 3600000).toISOString(), ...Array(17).fill(''), 'Rameez', '', '']] }], TEAM, later);
  eq('A lead from last night, not called yet: "new" for its person', b.byPerson.get('rameez@threepin.in').fresh.length, 1);
}

console.log(bad ? `${bad} of ${n} checks FAILED` : `All good (${n} checks).`);
if (bad) process.exit(1);
