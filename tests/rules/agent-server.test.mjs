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
// The agent opens a page: their copy is rebuilt when it is due (a property just given to them is).
const opens = async who => { await call(who, 'view'); return view(who); };

async function clear() {
  for (const c of ['properties', 'leads', 'grants', 'accessRequests', 'requestPrivate', 'agentViews', 'threads', 'visitAlerts', 'assignmentLog', 'propertySubmissions', 'agentConfigs', 'agentThrottle', 'propertyChanges']) {
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
  const L = (id, o) => db.collection('leads').doc(id).set({ tenantId: T, id, ...(o.phone ? { phoneKey: '91' + String(o.phone).replace(/\D/g, '').slice(-10) } : {}), ...o });
  await L('lead_1', { name: 'Ramesh Kumar', phone: '9111111111', propertyCodes: ['ADY002'], stageId: 'new', budget: '1 Cr', propertyInterest: '2 BHK Adyar' });
  await L('lead_2', { name: 'Divya Raman', phone: '9222222222', assignedAgent: 'swami@threepin.in', stageId: 'contacted',
    propertyInterest: '2 BHK apartment in Adyar', budget: '₹1 Cr', aiSummary: 'Divya Raman (9222222222) wants a 2 BHK in Adyar near the beach, budget around 1 Cr.' });
  await L('lead_3', { name: 'Own Client', phone: '9333333333', assignedAgent: 'rameez@threepin.in', stageId: 'new' });
  await L('lead_5', { name: 'Default Agent Enquiry', phone: '9555500005', assignedAgent: 'admin@threepin.in', propertyCodes: ['adr-m0002'.replace('adr-m0002', 'ady-002')] });
  await L('lead_6', { name: 'Kavya Own Buyer', phone: '9666600006', assignedAgent: 'kavya@threepin.in', propertyCodes: ['ADY002'], siteVisitProperty: 'ADY002', siteVisitAt: Date.now() + 86400000 });
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
  await opens('rameez');
  const lead = (await db.collection('leads').doc('lead_1').get()).data();
  assert.deepEqual(lead.agentAccess, ['kavya@threepin.in', 'rameez@threepin.in'], 'the enquiry on ADY002 now reaches its agents');
  assert.deepEqual((await db.collection('leads').doc('lead_5').get()).data().agentAccess, ['kavya@threepin.in', 'rameez@threepin.in'], 'so does one the default agent (staff) holds — codes compared loosely');
  assert.ok(!((await db.collection('leads').doc('lead_6').get()).data().agentAccess || []).includes('rameez@threepin.in'), 'Kavya’s own client, linked to and visiting ADY002, stays hers');
  assert.equal((await call('swami', 'assign', { propertyId: 'ADY002', primary: 'stranger@gmail.com' })).status, 400, 'only people on the team');
  // Reassigned away: the enquiry goes with the property.
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'swami@threepin.in', coAgents: [] });
  assert.deepEqual((await db.collection('leads').doc('lead_1').get()).data().agentAccess, ['swami@threepin.in']);
});

test('the agent’s copy: own in full, others as a summary with no street or owner, sold ones hidden', async () => {
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'rameez@threepin.in' });
  const v = await opens('rameez');
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
  await opens('rameez');
  let r = await call('rameez', 'request', { kind: 'property', targetId: 'ANR001', reason: 'Client wants Anna Nagar', clientLeadId: 'lead_3' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const req = (await db.collection('accessRequests').doc(r.id).get()).data();
  assert.deepEqual(req.approvers.sort(), ['swami@threepin.in', 'thirumal@threepin.in']);
  assert.equal(req.clientName, 'Own', 'the client’s first name only');
  assert.equal(req.clientLeadId, undefined, 'never the client’s lead id (it can carry their number) — approvers read the request');
  assert.ok(req.threadId, 'a thread is opened for it');
  const th = (await db.collection('threads').doc(req.threadId).get()).data();
  assert.ok(th.title.startsWith('Access: 3 BHK Apartment, Anna Nagar'));
  assert.ok(th.members.includes('rameez@threepin.in') && th.members.includes('swami@threepin.in'));
  assert.equal((await call('rameez', 'request', { kind: 'property', targetId: 'ANR001' })).status, 409, 'no second open request');
  assert.equal((await view('rameez')).props.find(p => p.id === 'ANR001')._pending, r.id, 'marked "asked" in his copy without a rebuild');
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
  assert.equal((await call('rameez', 'lead-save', { id: 'lead_2', pairs: [[['stageId'], 'won']] })).status, 404, 'not their lead: answered like a lead that does not exist');
  assert.equal((await call('rameez', 'lead-save', { id: 'lead_nope', pairs: [[['stageId'], 'won']] })).status, 404);
  r = await call('rameez', 'lead-save', { id: 'lead_3', pairs: [[['phone'], '9222222222'], [['followUpBy'], 'swami@threepin.in'], [['name'], 'Own <img src=x onerror=alert(1)>']] });
  assert.ok(r.refused.includes('phone'), 'the number is an admin’s to change (it would dodge the duplicate check)');
  const l2 = (await db.collection('leads').doc('lead_3').get()).data();
  assert.equal(l2.followUpBy, 'rameez@threepin.in', '“who did it” is always the person asking');
  assert.ok(!/[<>]/.test(l2.name), 'no markup from an agent reaches a colleague’s screen: ' + l2.name);
  // A history line: escaped except <b>, never someone else's line, the server's time.
  await db.collection('leads').doc('lead_3').collection('history').doc('h_admin').set({ id: 'h_admin', text: 'Stage set by admin', by: 'swami@threepin.in', at: 1 });
  assert.equal((await call('rameez', 'lead-history', { id: 'lead_3', event: { id: 'h_admin', text: 'forged' } })).status, 403);
  await call('rameez', 'lead-history', { id: 'lead_3', event: { id: 'h_mine', type: 'stage', text: 'Moved to <b>Contacted</b><img src=x onerror=alert(1)>', at: 5 } });
  const h = (await db.collection('leads').doc('lead_3').collection('history').doc('h_mine').get()).data();
  assert.equal(h.text, 'Moved to <b>Contacted</b>&lt;img src=x onerror=alert(1)&gt;');
  assert.ok(h.at > 1000, 'the server’s time, not the page’s');
  assert.equal((await call('rameez', 'lead-save', { id: 'lead_3', mode: 'delete' })).status, 403);
  assert.equal((await call('rameez', 'lead-note', { id: 'lead_3', note: { id: 'n1', text: 'Called', createdAt: 1, by: 'swami@threepin.in' } })).ok, true);
  assert.equal((await db.collection('leads').doc('lead_3').collection('notes').doc('n1').get()).data().by, 'rameez@threepin.in', 'a note is always from its writer');
  assert.equal((await call('rameez', 'lead-note', { id: 'lead_2', note: { id: 'n1', text: 'x' } })).status, 404);
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
  const v = await opens('rameez');
  const m = v.matches.find(x => x.propertyId === 'ADY002');
  assert.ok(m, 'Divya’s 2 BHK Adyar requirement matches: ' + JSON.stringify(v.matches));
  assert.ok(W.REF_RE.test(m.ref), 'named by a reference, never the lead id');
  assert.equal(W.leadIdOfRef('t_other', m.ref), null, 'a reference made for one business does not open in another');
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
  const lg = (await db.collection('grants').doc(`${T}__l__lead_2__rameez_threepin_in`).get()).data();
  assert.equal(lg.active, true, 'approved: a grant opens the lead to him (the rules check it)');
  assert.ok(!((await db.collection('leads').doc('lead_2').get()).data().agentAccess || []).includes('rameez@threepin.in'), 'never written into agentAccess (that would outlive the grant)');
  assert.equal((await call('rameez', 'lead-save', { id: 'lead_2', pairs: [[['stageId'], 'closed_lost']] })).status, 403, '…to read, not to change: it is still Swami’s client');
  assert.equal((await call('rameez', 'lead-note', { id: 'lead_2', note: { id: 'n9', text: 'bought elsewhere' } })).status, 403, 'no notes either: they feed the lead’s AI reading');
  assert.equal((await call('rameez', 'thread-open', { type: 'lead', linkedId: 'lead_2' })).ok, true, 'he can talk to its agent about it');
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
  await opens('rameez');
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
  assert.equal((await opens('rameez')).props.find(x => x.id === d.propertyId)._access, 'own');
  const log = await db.collection('propertyChanges').where('propertyId', '==', d.propertyId).get();
  assert.equal(log.docs[0].data().kind, 'create', 'approval puts it on “Changes to apply” for the inventory sheet');
  const s2 = await call('rameez', 'property-submit', { fields: { name: 'Another listing', contactNumber: '98400 99999' } });
  assert.equal(s2.possibleDuplicate, true, 'the same owner’s number as ADY002: may be a duplicate (never says which)');
  assert.deepEqual((await db.collection('propertySubmissions').doc(s2.id).get()).data().duplicateOf, ['ADY002'], 'the admin sees which');
  assert.equal((await call('rameez', 'property-submit', { fields: { name: 'X', photosLink: 'javascript:alert(1)' } })).status, 400);
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
  assert.equal((await call('rameez', 'thread-open', { type: 'lead', linkedId: 'lead_2' })).status, 404, 'not his lead');
  // His own lead, with nobody else on it: the admins are in the conversation, not an error.
  const own = await call('rameez', 'thread-open', { type: 'lead', linkedId: 'lead_3' });
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.deepEqual((await db.collection('threads').doc(own.id).get()).data().members, ['rameez@threepin.in', 'swami@threepin.in', 'thirumal@threepin.in']);
  // Two general conversations with the same people but different titles stay two.
  const g2 = await call('rameez', 'thread-open', { type: 'general', title: 'Sunday plan', members: ['swami@threepin.in'] });
  assert.notEqual(g2.id, r.id);
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


test('approvers are worked out when deciding, not when asking; the owner’s number always has a timer', async () => {
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'kavya@threepin.in' });
  const r = await call('rameez', 'request', { kind: 'property', targetId: 'ADY002', reason: 'x' });
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'swami@threepin.in' });   // Kavya is no longer its agent
  assert.equal((await call('kavya', 'decide', { id: r.id, decision: 'approve' })).status, 403, 'the old primary agent cannot approve any more');
  const d = await call('swami', 'decide', { id: r.id, decision: 'approve', shareContact: true });
  assert.equal(d.ok, true, JSON.stringify(d));
  const g = (await db.collection('grants').doc(d.grantId).get()).data();
  assert.ok(g.contactExpiresAt > Date.now() + 23 * 3600000 && g.contactExpiresAt < Date.now() + 25 * 3600000, 'no hours sent: the settings’ default (24 h), never “for ever”');
});

test('more time, the owner’s number again, extend, take back — the request says what happened', async () => {
  const r = await call('rameez', 'request', { kind: 'property', targetId: 'ANR001' });
  await call('swami', 'decide', { id: r.id, decision: 'approve', days: 1 });
  assert.equal((await call('rameez', 'request', { kind: 'property', targetId: 'ANR001' })).status, 400, 'already has the details');
  const n = await call('rameez', 'request', { kind: 'property', targetId: 'ANR001', need: 'number', reason: 'Client ready to meet the owner' });
  assert.equal(n.ok, true, JSON.stringify(n));
  await call('swami', 'decide', { id: n.id, decision: 'approve', hours: 2 });
  let g = (await db.collection('grants').where('agentEmail', '==', 'rameez@threepin.in').get()).docs[0];
  assert.equal(g.data().includeContact, true);
  assert.ok(g.data().expiresAt < Date.now() + 1.1 * 86400000, 'the details timer is untouched by a number request');
  assert.equal(g.data().history.length, 2, 'history kept, not overwritten');
  const t = await call('rameez', 'request', { kind: 'property', targetId: 'ANR001', need: 'time' });
  await call('swami', 'decide', { id: t.id, decision: 'approve', days: 7 });
  g = (await db.collection('grants').doc(g.id).get());
  assert.ok(g.data().expiresAt > Date.now() + 6.9 * 86400000, 'more time approved');
  assert.equal(g.data().includeContact, true, '…the number stays as it was');
  assert.equal((await call('rameez', 'grant-extend', { grantId: g.id, days: 3 })).status, 403, 'extending is an admin’s');
  await call('swami', 'grant-extend', { grantId: g.id, days: 3 });
  assert.ok((await db.collection('grants').doc(g.id).get()).data().expiresAt < Date.now() + 3.1 * 86400000);
  await call('swami', 'revoke', { grantId: g.id, reason: 'deal closed' });
  const req = (await db.collection('accessRequests').doc(r.id).get()).data();
  assert.equal(req.grantState, 'revoked', 'the request no longer reads as plain “approved”');
  assert.equal((await call('rameez', 'request', { kind: 'property', targetId: 'ANR001' })).ok, true, 'taken back: he can ask again');
});

test('the daily tidy-up ends expired access and old requests; an expired lead grant stops opening the lead', async () => {
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'rameez@threepin.in' });
  const v = await opens('rameez');
  const m = v.matches.find(x => x.propertyId === 'ADY002');
  const lr = await call('rameez', 'request', { kind: 'lead', ref: m.ref, reason: 'fits' });
  await call('swami', 'decide', { id: lr.id, decision: 'approve', days: 1 });
  const g = (await db.collection('grants').where('kind', '==', 'lead').get()).docs[0];
  assert.equal(g.data().active, true);
  await g.ref.update({ expiresAt: Date.now() - 1000 });
  const old = await call('kavya', 'request', { kind: 'property', targetId: 'ANR001', reason: 'old' });
  await db.collection('accessRequests').doc(old.id).update({ createdAt: Date.now() - 8 * 86400000 });
  const n = await W.sweepExpired(db, T);
  assert.ok(n >= 2, 'tidied ' + n);
  assert.equal((await g.ref.get()).data().active, false, 'the grant is switched off (the rules already stopped at its time)');
  assert.equal((await db.collection('accessRequests').doc(old.id).get()).data().status, 'expired');
  assert.equal((await call('swami', 'decide', { id: old.id, decision: 'approve' })).status, 409, 'an expired request cannot be approved');
});

test('campaigns for agents: no opt-out lists, only their own leads, to the lead’s own number, never “messages back on”', async () => {
  const gate = await W.agentCampaignGate(db, U.rameez, { op: 'settings' });
  const out = gate.filter({ ok: true, settings: { optOut: ['919999999999'], marketingOptOut: ['918888888888'], testNumber: '919941880088', quietStart: 21, quietEnd: 9, lists: [{ n: 1 }] }, quietNow: false });
  assert.deepEqual(out.settings.optOut, []); assert.deepEqual(out.settings.marketingOptOut, []); assert.equal(out.settings.testNumber, '');
  assert.equal(out.settings.quietStart, 21);
  const body = { op: 'create', recipients: [{ leadId: 'lead_3', contact: '919999999999', name: 'Someone else' }] };
  const g2 = await W.agentCampaignGate(db, U.rameez, body);
  assert.equal(g2.refuse, undefined, JSON.stringify(g2));
  assert.deepEqual(body.recipients, [{ leadId: 'lead_3', contact: '9333333333', name: 'Own Client' }], 'the typed number and name are replaced by the lead’s own');
  assert.ok((await W.agentCampaignGate(db, U.rameez, { op: 'create', recipients: [{ leadId: 'lead_2' }] })).refuse, 'not his lead');
  assert.ok((await W.agentCampaignGate(db, U.rameez, { op: 'optout', leadId: 'lead_3', on: false })).refuse, 'turning messages back on is the team’s');
  assert.equal((await W.agentCampaignGate(db, U.rameez, { op: 'optout', leadId: 'lead_3', on: true })).refuse, undefined);
  assert.ok((await W.agentCampaignGate(db, U.rameez, { op: 'save-template' })).refuse);
});

test('things an agent cannot see answer like things that do not exist', async () => {
  assert.equal((await call('rameez', 'request', { kind: 'property', targetId: 'OLD003' })).status, 404, 'a sold property he has no part in');
  assert.equal((await call('rameez', 'thread-open', { type: 'property', linkedId: 'OLD003' })).status, 404);
  const p = await W.visitPropertyFor(db, U.rameez, 'ANR001');
  assert.equal(p.location, undefined, 'a summary-only property: no street in the invitation');
  assert.equal(p.contactNumber, undefined);
});

test('“asked” marks: the most telling request wins; after a no he can ask again', async () => {
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'rameez@threepin.in' });
  const m = (await opens('rameez')).matches.find(x => x.propertyId === 'ADY002');
  const a = await call('rameez', 'request', { kind: 'lead', ref: m.ref, reason: '1' });
  await call('rameez', 'cancel', { id: a.id });
  assert.equal((await view('rameez')).matches.find(x => x.ref === m.ref).requested, 'cancelled');
  const b = await call('rameez', 'request', { kind: 'lead', ref: m.ref, reason: '2' });
  assert.equal((await view('rameez')).matches.find(x => x.ref === m.ref).requested, 'pending');
  await call('swami', 'decide', { id: b.id, decision: 'reject', note: 'not now' });
  assert.equal((await view('rameez')).matches.find(x => x.ref === m.ref).requested, 'rejected');
  assert.equal((await call('rameez', 'request', { kind: 'lead', ref: m.ref, reason: '3' })).ok, true, 'asked again after a no');
});


test('round 2: codes only — a title that reads like a code captures nothing; short ids work; links on others’ enquiries locked', async () => {
  await db.collection('properties').doc('17').set({ tenantId: T, id: '17', name: 'Old row flat', availability: 'Available' });
  await db.collection('leads').doc('lead_17').set({ tenantId: T, id: 'lead_17', name: 'Old Link', phone: '9777700017', phoneKey: '919777700017', propertyCodes: ['17'] });
  await db.collection('properties').doc('AGX1').set({ tenantId: T, id: 'AGX1', propertyCode: 'AGX1', name: 'A-D.Y-002', assignedAgent: 'kavya@threepin.in', availability: 'Available' });
  await call('swami', 'assign', { propertyId: '17', primary: 'rameez@threepin.in' });
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'rameez@threepin.in' });
  await opens('rameez');
  assert.deepEqual((await db.collection('leads').doc('lead_17').get()).data().agentAccess, ['rameez@threepin.in'], 'an enquiry on old property "17" reaches its agent');
  assert.ok(!((await db.collection('leads').doc('lead_1').get()).data().agentAccess || []).includes('kavya@threepin.in'), 'a property titled like ADY002’s code captures nothing');
  const r = await call('rameez', 'lead-save', { id: 'lead_1', pairs: [[['propertyCodes'], []], [['stageId'], 'contacted']] });
  assert.ok(r.refused.includes('propertyCodes'), 'which properties an unassigned enquiry is about is not his to change');
  assert.equal((await db.collection('leads').doc('lead_1').get()).data().stageId, 'contacted', 'he still works it');
});

test('round 2: mentions are always from the writer; campaigns go to the lead’s own number', async () => {
  await call('rameez', 'lead-save', { id: 'lead_3', data: { 'mentions.thirumal_threepin_in': { by: 'thirumal@threepin.in', text: 'call him', at: 1 } } });
  assert.equal((await db.collection('leads').doc('lead_3').get()).data().mentions.thirumal_threepin_in.by, 'rameez@threepin.in');
  const body = { op: 'create', recipients: [{ leadId: 'lead_3', contact: '919999999999', name: 'x' }] };
  await W.agentCampaignGate(db, U.rameez, body);
  assert.equal(body.recipients[0].contact, '9333333333', 'the number is the lead’s, read on the server');
  assert.equal(body.recipients[0].name, 'Own Client');
});

test('round 2: more time or the number only on access still running; take back ends those asks; the primary agent can end what he gave', async () => {
  await call('swami', 'assign', { propertyId: 'ANR001', primary: 'swami@threepin.in' });
  const r = await call('rameez', 'request', { kind: 'property', targetId: 'ANR001' });
  await call('swami', 'decide', { id: r.id, decision: 'approve', days: 1 });
  const gid = `${T}__p__ANR001__rameez_threepin_in`;
  const n = await call('rameez', 'request', { kind: 'property', targetId: 'ANR001', need: 'number', reason: 'x' });
  await db.collection('grants').doc(gid).update({ expiresAt: Date.now() - 1000 });   // ran out meanwhile
  const d = await call('swami', 'decide', { id: n.id, decision: 'approve', hours: 2 });
  assert.equal(d.status, 409, 'not brought back by a number request');
  assert.equal((await db.collection('accessRequests').doc(n.id).get()).data().status, 'expired');
  assert.equal((await db.collection('grants').doc(gid).get()).data().expiresAt < Date.now(), true, 'the grant was not widened');
  // A running grant, a waiting "more time", then an admin takes it back: the ask ends with it.
  const r2 = await call('rameez', 'request', { kind: 'property', targetId: 'ANR001' });
  await call('swami', 'decide', { id: r2.id, decision: 'approve', days: 3 });
  const t = await call('rameez', 'request', { kind: 'property', targetId: 'ANR001', need: 'time', reason: 'x' });
  await call('swami', 'revoke', { grantId: gid });
  assert.equal((await db.collection('accessRequests').doc(t.id).get()).data().status, 'cancelled');
  // The property's primary agent (not an admin) can end access; another agent cannot.
  const r3 = await call('kavya', 'request', { kind: 'property', targetId: 'ANR001' });
  await call('swami', 'decide', { id: r3.id, decision: 'approve' });
  const kg = `${T}__p__ANR001__kavya_threepin_in`;
  assert.equal((await call('rameez', 'revoke', { grantId: kg })).status, 403);
  await call('swami', 'assign', { propertyId: 'ANR001', primary: 'rameez@threepin.in' });
  assert.equal((await call('rameez', 'revoke', { grantId: kg })).ok, true, 'now its primary agent: he can end it');
});

test('round 2: after a reassignment, waiting requests go to the new primary agent', async () => {
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'kavya@threepin.in' });
  const r = await call('rameez', 'request', { kind: 'property', targetId: 'ADY002', reason: 'x' });
  assert.ok((await db.collection('accessRequests').doc(r.id).get()).data().approvers.includes('kavya@threepin.in'));
  await call('swami', 'assign', { propertyId: 'ADY002', primary: 'rajesh@threepin.in' });
  const req = (await db.collection('accessRequests').doc(r.id).get()).data();
  assert.ok(req.approvers.includes('rajesh@threepin.in') && !req.approvers.includes('kavya@threepin.in'), JSON.stringify(req.approvers));
  assert.ok((await db.collection('threads').doc(req.threadId).get()).data().members.includes('rajesh@threepin.in'), 'and he is in its conversation');
});

test('round 2: the rate limit holds under a burst', async () => {
  const results = await Promise.all(Array.from({ length: 30 }, () => W.throttle(db, U.kavya, 'burst', 5, 3600000)));
  assert.ok(results.filter(Boolean).length <= 5, 'at most 5 got through: ' + results.filter(Boolean).length);
});
