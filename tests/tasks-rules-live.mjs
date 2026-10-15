// ═══════ TASKS — the LIVE Firestore rules, proven with real sign-ins ═══════
//
// Runs against the real project, but never touches the real business: it makes a throwaway tenant
// (t_rulestest_<time>) with four temporary accounts — a manager, an assignee, a viewer and an
// outsider — signs each one in for real (custom token → ID token), and has each try what it should
// and should not be able to do, through Firestore's REST API (the same rules the pages meet).
// Everything it made is deleted at the end, pass or fail.
//
//   node tests/tasks-rules-live.mjs          (needs api/pin-realty-firebase-adminsdk-*.json)
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

const API_KEY = 'AIzaSyCO5782HKI_ka5zx0tSBzohlvNB5rY_ZF0';
const PROJECT = 'pin-realty';
const sa = JSON.parse(readFileSync(new URL('../api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', import.meta.url), 'utf8'));
initializeApp({ credential: cert(sa) });
const auth = getAuth(), db = getFirestore();

const RUN = Date.now().toString(36);
const TEN = 't_rulestest_' + RUN;
const mail = r => `rules-${r}-${RUN}@test.threepin.invalid`;
const P = { mgr: mail('mgr'), asg: mail('asg'), view: mail('view'), out: mail('out') };
const uids = {};
let failed = 0, passed = 0;
const ok = (label, cond, detail) => { if (cond) { passed++; console.log('  ok    ' + label); } else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : '')); } };

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const val = v => Array.isArray(v) ? { arrayValue: { values: v.map(val) } }
  : v === null ? { nullValue: null }
  : typeof v === 'number' ? { integerValue: String(v) }
  : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'object' ? { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, val(x)])) } }
  : { stringValue: String(v) };
const fields = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, val(v)]));
async function token(email) {
  const ct = await auth.createCustomToken(uids[email]);
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: ct, returnSecureToken: true }) });
  const j = await r.json();
  if (!j.idToken) throw new Error('sign-in failed: ' + JSON.stringify(j));
  return j.idToken;
}
const H = t => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });
const get = (t, path) => fetch(`${BASE}/${path}`, { headers: H(t) });
const create = (t, coll, id, data) => fetch(`${BASE}/${coll}?documentId=${id}`, { method: 'POST', headers: H(t), body: JSON.stringify({ fields: fields(data) }) });
const patch = (t, path, data) => fetch(`${BASE}/${path}?${Object.keys(data).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&')}`,
  { method: 'PATCH', headers: H(t), body: JSON.stringify({ fields: fields(data) }) });
const del = (t, path) => fetch(`${BASE}/${path}`, { method: 'DELETE', headers: H(t) });
async function query(t, field, op, value) {
  const r = await fetch(`${BASE}:runQuery`, { method: 'POST', headers: H(t), body: JSON.stringify({ structuredQuery: {
    from: [{ collectionId: 'tasks' }], where: { fieldFilter: { field: { fieldPath: field }, op, value: val(value) } } } }) });
  const j = await r.json().catch(() => null);
  return { status: r.status, docs: Array.isArray(j) ? j.filter(x => x.document).map(x => x.document.name.split('/').pop()) : [] };
}

const TASK = id => ({
  tenantId: TEN, title: '[rules test] ' + id, description: '', status: 'todo', due: '', link: null,
  primary: P.asg, secondary: [], assignees: [P.asg], visibleTo: [TEN + '|' + P.asg, TEN + '|' + P.view],
  createdAt: Date.now(), createdBy: P.mgr, updatedAt: Date.now(), updatedBy: P.mgr, statusAt: Date.now(), completedAt: null, history: []
});

try {
  console.log(`Tenant ${TEN} — setting up four temporary accounts`);
  for (const [role, email] of Object.entries(P)) {
    const u = await auth.createUser({ email, emailVerified: true, password: 'x' + Math.random().toString(36).slice(2) + 'A1!' });
    await auth.setCustomUserClaims(u.uid, { tenantId: TEN });
    uids[email] = u.uid;
  }
  await db.collection('taskConfigs').doc(TEN).set({ tenantId: TEN, managers: [P.mgr], viewers: { [P.view]: [P.asg] } });
  const T = {}; for (const e of Object.values(P)) T[e] = await token(e);

  console.log('\nCreating');
  ok('the manager creates a task', (await create(T[P.mgr], 'tasks', 't1', TASK('t1'))).status === 200);
  ok('the assignee cannot create one', (await create(T[P.asg], 'tasks', 't2', TASK('t2'))).status === 403);
  ok('an outsider cannot create one', (await create(T[P.out], 'tasks', 't3', TASK('t3'))).status === 403);

  console.log('\nReading');
  let q = await query(T[P.mgr], 'tenantId', 'EQUAL', TEN);
  ok('the manager lists every task of the tenant', q.status === 200 && q.docs.includes('t1'), JSON.stringify(q));
  q = await query(T[P.asg], 'visibleTo', 'ARRAY_CONTAINS', TEN + '|' + P.asg);
  ok('the assignee lists their own tasks (visibleTo query)', q.status === 200 && q.docs.join() === 't1', JSON.stringify(q));
  q = await query(T[P.view], 'visibleTo', 'ARRAY_CONTAINS', TEN + '|' + P.view);
  ok('the viewer lists the tasks they were given to see', q.status === 200 && q.docs.join() === 't1', JSON.stringify(q));
  q = await query(T[P.out], 'visibleTo', 'ARRAY_CONTAINS', TEN + '|' + P.out);
  ok('the outsider lists nothing', q.status === 200 && q.docs.length === 0, JSON.stringify(q));
  q = await query(T[P.asg], 'tenantId', 'EQUAL', TEN);
  ok('the assignee cannot list the whole tenant', q.status === 403, JSON.stringify(q));
  q = await query(T[P.out], 'visibleTo', 'ARRAY_CONTAINS', TEN + '|' + P.asg);
  ok('the outsider cannot list someone else’s by asking for their key', q.status === 403, JSON.stringify(q));
  ok('the outsider cannot read the task directly', (await get(T[P.out], 'tasks/t1')).status === 403);
  ok('the viewer can read it directly', (await get(T[P.view], 'tasks/t1')).status === 200);
  q = await query(T[P.mgr], 'tenantId', 'EQUAL', 't_3pinrealty');
  ok('a manager of another tenant cannot list the real business’s tasks', q.status === 403, JSON.stringify(q));

  console.log('\nChanging');
  ok('the assignee changes the status', (await patch(T[P.asg], 'tasks/t1', { status: 'doing', statusAt: Date.now(), updatedAt: Date.now(), updatedBy: P.asg })).status === 200);
  ok('the assignee changes the title and due date', (await patch(T[P.asg], 'tasks/t1', { title: '[rules test] edited', due: '2026-12-01', tenantId: TEN })).status === 200);
  ok('a status that is not one of the three is refused', (await patch(T[P.asg], 'tasks/t1', { status: 'constructor' })).status === 403);
  ok('an empty title is refused', (await patch(T[P.asg], 'tasks/t1', { title: '' })).status === 403);
  ok('the assignee cannot reassign it', (await patch(T[P.asg], 'tasks/t1', { primary: P.out, assignees: [P.out] })).status === 403);
  ok('the assignee cannot widen who sees it', (await patch(T[P.asg], 'tasks/t1', { visibleTo: [TEN + '|' + P.asg, TEN + '|' + P.out] })).status === 403);
  ok('the assignee cannot move it to another tenant', (await patch(T[P.asg], 'tasks/t1', { tenantId: 't_3pinrealty' })).status === 403);
  ok('the viewer cannot change it', (await patch(T[P.view], 'tasks/t1', { status: 'done' })).status === 403);
  ok('the outsider cannot change it', (await patch(T[P.out], 'tasks/t1', { status: 'done' })).status === 403);
  ok('the manager reassigns it', (await patch(T[P.mgr], 'tasks/t1', { primary: P.view, assignees: [P.view], visibleTo: [TEN + '|' + P.view] })).status === 200);
  ok('the assignee no longer on it cannot read it now', (await get(T[P.asg], 'tasks/t1')).status === 403);

  console.log('\nWho sees whose');
  ok('a non-manager cannot change the configuration', (await patch(T[P.asg], 'taskConfigs/' + TEN, { managers: [P.asg], tenantId: TEN })).status === 403);
  ok('the manager cannot empty the manager list', (await patch(T[P.mgr], 'taskConfigs/' + TEN, { managers: [], tenantId: TEN })).status === 403);
  ok('the manager can change who sees whose', (await patch(T[P.mgr], 'taskConfigs/' + TEN, { viewers: { [P.out]: [P.asg] }, tenantId: TEN })).status === 200);
  ok('nobody creates a configuration from a page', (await create(T[P.mgr], 'taskConfigs', 'x_' + RUN, { tenantId: TEN, managers: [P.mgr] })).status === 403);
  ok('everyone on the tenant reads the configuration', (await get(T[P.out], 'taskConfigs/' + TEN)).status === 200);

  console.log('\nDeleting');
  ok('the assignee cannot delete it', (await del(T[P.view], 'tasks/t1')).status === 403);
  ok('the manager deletes it', (await del(T[P.mgr], 'tasks/t1')).status === 200);
} catch (e) {
  failed++;
  console.log('  ERROR ' + (e && e.stack || e));
} finally {
  console.log('\nCleaning up');
  for (const id of ['t1', 't2', 't3']) await db.collection('tasks').doc(id).get().then(s => s.exists && s.data().tenantId === TEN ? s.ref.delete() : null).catch(() => {});
  await db.collection('taskConfigs').doc(TEN).delete().catch(() => {});
  await db.collection('taskConfigs').doc('x_' + RUN).delete().catch(() => {});
  for (const uid of Object.values(uids)) await auth.deleteUser(uid).catch(() => {});
  console.log('  temporary accounts, tasks and configuration removed');
}
console.log(failed ? `\n${failed} failed, ${passed} passed.` : `\nAll good (${passed} checks).`);
process.exit(failed ? 1 : 0);
