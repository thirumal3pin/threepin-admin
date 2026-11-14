// The agent layer's server (api/_agent-work.js), phases 2–6, against the LOCAL Firestore emulator.
// Run with the rule tests: cd tests/rules && npm test. Never touches the live database.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run through run.mjs: the emulator must be up');
if (!getApps().length) initializeApp({ projectId: 'demo-threepin' });
const db = getFirestore();
const W = await import('../../api/_agent-work.js');
const AA = await import('../../shared-assets/agent-access.js');

const T = 't_3pinrealty';
const TEAM = [
  { uid: 'u_swami', email: 'swami@threepin.in', role: 'admin', active: true, verified: true, name: 'Swami' },
  { uid: 'u_thiru', email: 'thirumal@threepin.in', role: 'admin', active: true, verified: true, name: 'Thirumal' },
  { uid: 'u_rameez', email: 'rameez@threepin.in', role: 'agent', active: true, verified: true, name: 'Rameez' },
  { uid: 'u_kavya', email: 'kavya@threepin.in', role: 'agent', active: true, verified: true, name: 'Kavya' },
  { uid: 'u_rajesh', email: 'rajesh@threepin.in', role: 'none', active: true, verified: true, name: 'Rajesh' },
];
W.__setTeamSource(() => TEAM);
const U = {
  swami: { uid: 'u_swami', email: 'swami@threepin.in', role: 'admin', email_verified: true, tenantId: T },
  rameez: { uid: 'u_rameez', email: 'rameez@threepin.in', role: 'agent', email_verified: true, tenantId: T },
  kavya: { uid: 'u_kavya', email: 'kavya@threepin.in', role: 'agent', email_verified: true, tenantId: T },
  rajesh: { uid: 'u_rajesh', email: 'rajesh@threepin.in', email_verified: true, tenantId: T },
};
const call = async (who, action, body = {}) => {
  const u = U[who];
  const r = await W.workPost(u, action, body, u.role === 'admin');
  return { status: r.status, ...(await r.json()) };
};
const view = async who => (await db.collection('agentViews').doc(`${T}__${U[who].uid}`).get()).data();

async function clear() {
  for (const c of ['properties', 'leads', 'grants', 'accessRequests', 'requestPrivate', 'agentViews', 'threads', 'visitAlerts', 'assignmentLog', 'propertySubmissions', 'agentConfigs']) {
    const s = await db.collection(c).get();
    for (const d of s.docs) {
      for (const sub of ['messages', 'notes', 'history']) { const ss = await d.ref.collection(sub).get(); for (const x of ss.docs) await x.ref.delete(); }
      await d.ref.delete();
    }
  }
}

beforeEach(async () => {
  await clear();
  const P = (id, o) => db.collection('properties').doc(id).set({ tenantId: T, id, propertyCode: id, ...o });
  await P('ANR001', { name: '3 BHK Apartment, Anna Nagar', config: '3 BHK', startingPrice: '₹1.8 Cr', type: 'Apartment', zone: 'Anna Nagar',
    location: '12, 6th Avenue, Anna Nagar', contactName: 'Mr Owner', contactNumber: '9840012345', availability: 'Available',
    detailsText: 'Call owner on 98400 12345', assignedAgent: 'swami@threepin.in' });
  await P('ADY002', { name: '2 BHK Flat, Adyar', config: '2 BHK', startingPrice: '₹95 L', type: 'Apartment', zone: 'Adyar',
    location: '4, LB Road', contactName: 'Mrs Seller', contactNumber: '9840099999', availability: 'Available' });
  await P('OLD003', { name: 'Sold Villa, ECR', config: '4 BHK', startingPrice: '₹4 Cr', zone: 'ECR', soldOut: true });
  const L = (id, o) => db.collection('leads').doc(id).set({ tenantId: T, id, ...o });
  await L('lead_1', { name: 'Ramesh Kumar', phone: '9111111111', propertyCodes: ['ADY002'], stageId: 'new', budget: '1 Cr', propertyInterest: '2 BHK Adyar' });
  await L('lead_2', { name: 'Divya Raman', phone: '9222222222', assignedAgent: 'swami@threepin.in', stageId: 'contacted',
    propertyInterest: '2 BHK apartment in Adyar', budget: '₹1 Cr', aiSummary: 'Divya Raman (9222222222) wants a 2 BHK in Adyar near the beach, budget around 1 Cr.' });
  await L('lead_3', { name: 'Own Client', phone: '9333333333', assignedAgent: 'rameez@threepin.in', stageId: 'new' });
});

test('an admin assigns one primary and co-agents; the history is kept; enquiries follow the property', async () => {
  let r = await call('rameez', 'assign', { propertyId: 'ADY002', primary: 'rameez@threepin.in' });
  assert.equal(r.status, 403, 'an agent cannot assign');
  r = await call('swami', 'assign', { propertyId: 'ADY002', primary: 'rameez@threepin.in', coAgents: ['kavya@threepin.in', 'rameez@threepin.in'] });
  assert.equal(r.ok, true);
  const p = (await db.collection('properties').doc('ADY002').get()).data();
  assert.equal(p.assignedAgent, 'rameez@threepin.in');
  assert.deepEqual(p.secondaryAgents, ['kavya@threepin.in'], 'primary never also a co-agent');
  assert.equal(p.secondaryAgent, 'kavya@threepin.in', 'old single field kept as the first co-agent');
  const log = await db.collection('assignmentLog').where('propertyId', '==', 'ADY002').get();
  assert.equal(log.size, 1);
  const lead = (await db.collection('leads').doc('lead_1').get()).data();
  assert.deepEqual(lead.agentAccess, ['kavya@threepin.in', 'rameez@threepin.in'], 'the enquiry on ADY002 now reaches its agents');
  assert.equal((await call('swami', 'assign', { propertyId: 'ADY002', primary: 'stranger@gmail.com' })).status, 400, 'only people on the team');
  // Reassigned away: the enquiry goes with the property.
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'swami@threepin.in', coAgents: [] });
  assert.deepEqual((await db.collection('leads').doc('lead_1').get()).data().agentAccess, ['swami@threepin.in']);
});

test('the agent’s copy: own in full, others as a summary with no street or owner, sold ones hidden', async () => {
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'rameez@threepin.in' });
  const v = await view('rameez');
  assert.ok(v.expiresAt > Date.now());
  const own = v.props.find(p => p.id === 'ADY002');
  const other = v.props.find(p => p.id === 'ANR001');
  assert.equal(own._access, 'own');
  assert.equal(own.contactNumber, '9840099999', 'own property: the owner’s number (default settings)');
  assert.equal(other._access, 'summary');
  assert.deepEqual(Object.keys(other).filter(k => !k.startsWith('_')).sort(), ['assignedAgent', 'availability', 'config', 'id', 'name', 'startingPrice', 'type', 'zone'].sort());
  assert.equal(other._primaryName, 'Swami');
  assert.ok(!JSON.stringify(other).includes('6th Avenue') && !JSON.stringify(other).includes('98400'), 'no street, no number');
  assert.ok(!v.props.some(p => p.id === 'OLD003'), 'a sold property is not offered');
  assert.equal(v.props[0]._access, 'own', 'mine first');
});

test('a request goes to the primary agent and admins; first decision wins; the grant opens the details, the owner’s number only with its own timer', async () => {
  let r = await call('rameez', 'request', { kind: 'property', targetId: 'ANR001', reason: 'Client wants Anna Nagar', clientLeadId: 'lead_3' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const req = (await db.collection('accessRequests').doc(r.id).get()).data();
  assert.deepEqual(req.approvers.sort(), ['swami@threepin.in', 'thirumal@threepin.in']);
  assert.equal(req.clientName, 'Own Client');
  assert.ok(req.threadId, 'a thread is opened for it');
  const th = (await db.collection('threads').doc(req.threadId).get()).data();
  assert.ok(th.title.startsWith('Access: 3 BHK Apartment, Anna Nagar'));
  assert.ok(th.members.includes('rameez@threepin.in') && th.members.includes('swami@threepin.in'));
  assert.equal((await call('rameez', 'request', { kind: 'property', targetId: 'ANR001' })).status, 409, 'no second open request');
  assert.equal((await view('rameez')).props.find(p => p.id === 'ANR001')._pending, r.id);
  // Not an approver: refused. Reject needs a reason.
  assert.equal((await call('kavya', 'decide', { id: r.id, decision: 'approve' })).status, 403);
  assert.equal((await call('rameez', 'decide', { id: r.id, decision: 'approve' })).status, 403, 'never your own');
  assert.equal((await call('swami', 'decide', { id: r.id, decision: 'reject' })).status, 400);
  // Two approvers at once: one wins.
  const [a, b] = await Promise.all([
    call('swami', 'decide', { id: r.id, decision: 'approve', days: 3, shareContact: true, hours: 24 }),
    W.workPost({ ...U.swami, uid: 'u_thiru', email: 'thirumal@threepin.in' }, 'decide', { id: r.id, decision: 'reject', note: 'no' }, true).then(async x => ({ status: x.status, ...(await x.json()) })),
  ]);
  assert.equal([a, b].filter(x => x.ok).length, 1, 'exactly one decision lands: ' + JSON.stringify([a, b]));
  const loser = [a, b].find(x => !x.ok);
  assert.equal(loser.status, 409);
  const done = (await db.collection('accessRequests').doc(r.id).get()).data();
  if (done.status === 'approved') {
    const g = (await db.collection('grants').doc(done.grantId).get()).data();
    assert.ok(g.expiresAt > Date.now() + 2.9 * 86400000 && g.expiresAt < Date.now() + 3.1 * 86400000);
    assert.equal(g.includeContact, true);
    const v = await view('rameez');
    const p = v.props.find(x => x.id === 'ANR001');
    assert.equal(p._access, 'granted');
    assert.equal(p.location, '12, 6th Avenue, Anna Nagar', 'details open');
    assert.equal(p.contactNumber, '9840012345', 'owner’s number shared');
    assert.ok(v.expiresAt <= g.contactExpiresAt, 'the copy stops opening when the number’s timer ends');
    // An admin hides the number, then takes the access back.
    await call('swami', 'hide-contact', { grantId: done.grantId });
    let p2 = (await view('rameez')).props.find(x => x.id === 'ANR001');
    assert.equal(p2._access, 'granted');
    assert.equal(p2.contactNumber, undefined);
    assert.ok(!JSON.stringify(p2).includes('98400 12345') && !JSON.stringify(p2).includes('9840012345'), 'numbers in text masked too');
    await call('swami', 'revoke', { grantId: done.grantId, reason: 'deal closed' });
    p2 = (await view('rameez')).props.find(x => x.id === 'ANR001');
    assert.equal(p2._access, 'summary');
    const msgs = await db.collection('threads').doc(req.threadId).collection('messages').get();
    assert.ok(msgs.docs.some(m => /took back access/.test(m.data().text)));
  }
});

test('details shared with no owner’s number by default; an expired grant stops counting', async () => {
  const r = await call('rameez', 'request', { kind: 'property', targetId: 'ANR001' });
  await call('swami', 'decide', { id: r.id, decision: 'approve' });
  let p = (await view('rameez')).props.find(x => x.id === 'ANR001');
  assert.equal(p._access, 'granted');
  assert.equal(p.contactNumber, undefined);
  const g = (await db.collection('grants').where('agentEmail', '==', 'rameez@threepin.in').get()).docs[0];
  assert.equal(g.data().expiresAt, null, 'no time limit by default');
  await g.ref.update({ expiresAt: Date.now() - 1000 });
  await call('swami', 'rebuild', { email: 'rameez@threepin.in' });
  p = (await view('rameez')).props.find(x => x.id === 'ANR001');
  assert.equal(p._access, 'summary');
  assert.equal((await call('swami', 'decide', { id: r.id, decision: 'approve' })).status, 409, 'already decided');
});

test('the primary agent approves as a co-agent; a co-agent may not add others', async () => {
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'kavya@threepin.in' });
  const r = await call('rameez', 'request', { kind: 'property', targetId: 'ADY002', reason: 'joint deal' });
  const req = (await db.collection('accessRequests').doc(r.id).get()).data();
  assert.ok(req.approvers.includes('kavya@threepin.in'), 'the primary agent approves');
  const d = await call('kavya', 'decide', { id: r.id, decision: 'approve', coAgent: true });
  assert.equal(d.ok, true, JSON.stringify(d));
  const p = (await db.collection('properties').doc('ADY002').get()).data();
  assert.deepEqual(p.secondaryAgents, ['rameez@threepin.in']);
  assert.equal((await view('rameez')).props.find(x => x.id === 'ADY002')._access, 'co');
});

test('agents change only what is theirs on a lead, through the server', async () => {
  let r = await call('rameez', 'lead-save', { id: 'lead_3', pairs: [[['stageId'], 'contacted'], [['followUpAt'], 123], [['assignedAgent'], 'kavya@threepin.in'], [['ai', 'verdict'], 'x'], [['ai', 'suggestion'], null]] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.refused.sort(), ['ai.verdict', 'assignedAgent']);
  const l = (await db.collection('leads').doc('lead_3').get()).data();
  assert.equal(l.stageId, 'contacted');
  assert.equal(l.assignedAgent, 'rameez@threepin.in');
  assert.equal((await call('rameez', 'lead-save', { id: 'lead_2', pairs: [[['stageId'], 'won']] })).status, 403, 'not their lead');
  assert.equal((await call('rameez', 'lead-save', { id: 'lead_3', mode: 'delete' })).status, 403);
  assert.equal((await call('rameez', 'lead-note', { id: 'lead_3', note: { id: 'n1', text: 'Called', createdAt: 1, by: 'swami@threepin.in' } })).ok, true);
  assert.equal((await db.collection('leads').doc('lead_3').collection('notes').doc('n1').get()).data().by, 'rameez@threepin.in', 'a note is always from its writer');
  assert.equal((await call('rameez', 'lead-note', { id: 'lead_2', note: { id: 'n1', text: 'x' } })).status, 403);
});

test('adding a lead: a number already with the team is refused without saying whose', async () => {
  let r = await call('rameez', 'lead-add', { lead: { id: 'lead_1730000000000', name: 'New', phone: '92222 22222' } });
  assert.equal(r.status, 409);
  assert.equal(r.mine, false);
  assert.ok(!/swami|divya/i.test(r.error));
  r = await call('rameez', 'lead-add', { lead: { id: 'lead_1730000000001', name: 'Fresh', phone: '9555555555', assignedAgent: 'swami@threepin.in' } });
  assert.equal(r.ok, true);
  const l = (await db.collection('leads').doc('lead_1730000000001').get()).data();
  assert.equal(l.assignedAgent, 'rameez@threepin.in', 'a lead an agent adds is theirs');
  assert.equal(l.phoneKey, '919555555555');
});

test('matching leads: requirement and AI summary without name or number; the number comes after approval', async () => {
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'rameez@threepin.in' });
  const v = await view('rameez');
  const m = v.matches.find(x => x.propertyId === 'ADY002');
  assert.ok(m, 'Divya’s 2 BHK Adyar requirement matches: ' + JSON.stringify(v.matches));
  assert.ok(/^m[0-9a-f]{20}$/.test(m.ref), 'named by a reference, never the lead id');
  assert.ok(!JSON.stringify(v.matches).includes('Divya') && !JSON.stringify(v.matches).includes('9222222222') && !JSON.stringify(v.matches).includes('lead_2'));
  assert.equal(m.phone, undefined);
  assert.ok(m.aiSummary.includes('2 BHK in Adyar'));
  const r = await call('rameez', 'request', { kind: 'lead', ref: m.ref, reason: 'fits ADY002' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const req = (await db.collection('accessRequests').doc(r.id).get()).data();
  assert.ok(!JSON.stringify(req).includes('lead_2') && !JSON.stringify(req).includes('Divya'), 'the request the agent can read names nobody');
  assert.ok(req.approvers.includes('swami@threepin.in'), 'the lead’s agent approves');
  assert.equal((await db.collection('requestPrivate').doc(r.id).get()).data().leadId, 'lead_2');
  assert.equal((await view('rameez')).matches.find(x => x.ref === m.ref).requested, 'pending');
  await call('swami', 'decide', { id: r.id, decision: 'approve' });
  const l = (await db.collection('leads').doc('lead_2').get()).data();
  assert.ok(l.agentAccess.includes('rameez@threepin.in'), 'approved: the lead is his to read');
  assert.ok(!(await view('rameez')).matches.some(x => x.ref === m.ref), 'no longer a "matching" lead');
});

test('a visit booked on a colleague’s property alerts its agents with the client’s first name only', async () => {
  const r = await call('rameez', 'request', { kind: 'property', targetId: 'ANR001' });
  await call('swami', 'decide', { id: r.id, decision: 'approve' });
  const before = { id: 'lead_3', name: 'Own Client', phone: '9333333333', assignedAgent: 'rameez@threepin.in' };
  const after = { ...before, siteVisitAt: Date.now() + 86400000, siteVisitStatus: 'scheduled', siteVisitProperty: 'ANR001' };
  const id = await W.visitAlert(db, U.rameez, before, after);
  assert.ok(id);
  const a = (await db.collection('visitAlerts').doc(id).get()).data();
  assert.deepEqual(a.to, ['swami@threepin.in']);
  assert.equal(a.kind, 'booked');
  assert.equal(a.clientName, 'Own');
  assert.ok(!JSON.stringify(a).includes('9333333333'));
  const msgs = await db.collection('threads').doc((await db.collection('accessRequests').doc(r.id).get()).data().threadId).collection('messages').get();
  assert.ok(msgs.docs.some(m => /booked a site visit/.test(m.data().text)));
  const moved = await W.visitAlert(db, U.rameez, after, { ...after, siteVisitAt: after.siteVisitAt + 3600000 });
  assert.equal((await db.collection('visitAlerts').doc(moved).get()).data().kind, 'moved');
  assert.equal(await W.visitAlert(db, U.rameez, after, after), null, 'the same visit is announced once (the invitation call after the save says nothing new)');
  assert.equal(await W.visitAlert(db, U.rameez, before, after), null, '…in whichever order the two calls come');
  const off = await W.visitAlert(db, U.rameez, after, { ...after, siteVisitStatus: 'cancelled' });
  assert.equal((await db.collection('visitAlerts').doc(off).get()).data().kind, 'cancelled');
  const quiet = { ...before, siteVisitAt: Date.now() + 5 * 86400000, siteVisitStatus: 'scheduled', siteVisitProperty: 'ANR001' };
  assert.ok(await W.visitAlert(db, U.rameez, quiet, quiet), 'saved before the invitation call: still announced');
  // An agent's invitation never carries the owner's number they were not given.
  const prop = await W.visitPropertyFor(db, U.rameez, 'ANR001');
  assert.equal(prop.contactNumber, undefined);
});

test('own property: notes and availability; a submitted property waits for an admin', async () => {
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'rameez@threepin.in' });
  assert.equal((await call('rameez', 'property-note', { id: 'ADY002', text: 'Owner flexible on price' })).ok, true);
  assert.equal((await call('rameez', 'property-note', { id: 'ANR001', text: 'x' })).status, 403);
  assert.equal((await call('rameez', 'property-availability', { id: 'ADY002', availability: 'Booked' })).ok, true);
  assert.equal((await db.collection('properties').doc('ADY002').get()).data().availability, 'Booked');
  assert.equal((await call('rameez', 'property-notes', { id: 'ADY002' })).notes.length, 2);
  assert.equal((await call('rameez', 'property-notes', { id: 'ANR001' })).status, 403, 'a summary does not open notes');
  const s = await call('rameez', 'property-submit', { fields: { name: '1 BHK, Velachery', config: '1 BHK', contactNumber: '9000000001' } });
  assert.equal(s.ok, true);
  assert.equal((await call('rameez', 'submission-decide', { id: s.id, decision: 'approve' })).status, 403);
  const d = await call('swami', 'submission-decide', { id: s.id, decision: 'approve' });
  const p = (await db.collection('properties').doc(d.propertyId).get()).data();
  assert.equal(p.assignedAgent, 'rameez@threepin.in');
  assert.equal(p.tenantId, T);
  assert.equal((await view('rameez')).props.find(x => x.id === d.propertyId)._access, 'own');
});

test('settings an admin changes reach the copy; switching off actions refuses them', async () => {
  await db.collection('agentConfigs').doc(T).set({ tenantId: T, otherPropertyFields: ['title'], actions: { addLeads: false }, updatedAt: 5 });
  await call('rameez', 'view');
  const other = (await view('rameez')).props.find(p => p.id === 'ANR001');
  assert.deepEqual(Object.keys(other).filter(k => !k.startsWith('_')).sort(), ['id', 'name']);
  assert.equal((await call('rameez', 'lead-add', { lead: { id: 'lead_1730000000002', name: 'X', phone: '9666666666' } })).status, 403);
  const again = await call('rameez', 'view');
  assert.equal(again.fresh, false, 'nothing changed: not rebuilt');
});

test('messages: a property thread goes to its agents; a general one needs a title and people on the team', async () => {
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'kavya@threepin.in' });
  let r = await call('rameez', 'thread-open', { type: 'property', linkedId: 'ADY002' });
  assert.equal(r.ok, true);
  const t = (await db.collection('threads').doc(r.id).get()).data();
  assert.deepEqual(t.members, ['kavya@threepin.in', 'rameez@threepin.in']);
  assert.equal((await call('rameez', 'thread-open', { type: 'property', linkedId: 'ADY002' })).id, r.id, 'the same thread again');
  assert.equal((await call('rameez', 'thread-open', { type: 'general', members: ['swami@threepin.in'] })).status, 400, 'title required');
  r = await call('rameez', 'thread-open', { type: 'general', title: 'Weekend plan', members: ['swami@threepin.in', 'nobody@gmail.com'] });
  assert.deepEqual((await db.collection('threads').doc(r.id).get()).data().members, ['rameez@threepin.in', 'swami@threepin.in']);
  assert.equal((await call('rameez', 'thread-open', { type: 'lead', linkedId: 'lead_2' })).status, 403, 'not his lead');
});

test('the pure rules: agents of a property, timers, approvers', () => {
  assert.deepEqual(AA.agentsOf({ assignedAgent: 'A@x.in', secondaryAgents: ['b@x.in', 'a@x.in'], secondaryAgent: 'c@x.in' }), ['a@x.in', 'b@x.in', 'c@x.in']);
  assert.equal(AA.timerEnd({ days: 400 }), undefined);
  assert.equal(AA.timerEnd({}), null);
  assert.equal(AA.timerEnd({ until: Date.now() - 5 }), undefined);
  assert.deepEqual(AA.approversFor({ kind: 'property', property: { assignedAgent: 'p@x.in', secondaryAgents: ['c@x.in'] }, approvers: 'all', admins: ['a@x.in'], requester: 'c@x.in' }).sort(), ['a@x.in', 'p@x.in']);
  assert.deepEqual(AA.approversFor({ kind: 'property', property: { assignedAgent: 'p@x.in' }, approvers: 'admins', admins: ['a@x.in'] }), ['a@x.in']);
  assert.equal(AA.isActiveProperty({ availability: 'Sold out' }), false);
  assert.equal(AA.isActiveProperty({ availability: 'Available' }), true);
  assert.equal(AA.scrubText('Call Divya Raman on 98400 12345', ['Divya Raman']), 'Call the client on •••');
});
