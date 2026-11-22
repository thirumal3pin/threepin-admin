// Firestore rules — the agent layer, phases 1–6. Runs against the LOCAL emulator only:
//   cd tests/rules && npm test        (needs Java: the emulator is a Java program)
//
// Three kinds of login, as firestore.rules describes them:
//   staff  — tenant claim, no role: everyone on the team before the agent layer (must be unchanged)
//   admin  — role 'admin'
//   agent  — role 'agent': shut out of everything except their own tasks, their own Daily task
//            record and the agent settings
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs,
} from 'firebase/firestore';

const T = 't_3pinrealty';
let env;

const who = {
  staff: { uid: 'u_rajesh', tok: { tenantId: T, email: 'rajesh@threepin.in', email_verified: true } },
  admin: { uid: 'u_swami', tok: { tenantId: T, role: 'admin', email: 'swami@threepin.in', email_verified: true } },
  adminUnverified: { uid: 'u_fake', tok: { tenantId: T, role: 'admin', email: 'swami@threepin.in', email_verified: false } },
  agent: { uid: 'u_rameez', tok: { tenantId: T, role: 'agent', email: 'rameez@threepin.in', email_verified: true } },
  typo: { uid: 'u_typo', tok: { tenantId: T, role: 'Agent', email: 'typo@threepin.in', email_verified: true } },
  future: { uid: 'u_partner', tok: { tenantId: T, role: 'partner', email: 'p@threepin.in', email_verified: true } },
  noTenant: { uid: 'u_stranger', tok: { email: 'stranger@gmail.com', email_verified: false } },
  other: { uid: 'u_x', tok: { tenantId: 't_other', email: 'x@other.in', email_verified: true } },
};
const db = k => env.authenticatedContext(who[k].uid, who[k].tok).firestore();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-threepin',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8181 },
  });
});
after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'properties/ADRM0002'), { tenantId: T, name: '3 BHK, Anna Nagar', contactNumber: '9000000000', assignedAgent: 'rameez@threepin.in' });
    await setDoc(doc(d, 'properties/ADRM0002/internalNotes/n1'), { text: 'owner floor 1.2 Cr' });
    await setDoc(doc(d, 'leads/lead_1'), { tenantId: T, name: 'Ramesh', phone: '9111111111', assignedAgent: 'rameez@threepin.in' });
    await setDoc(doc(d, 'leads/lead_1/notes/n1'), { text: 'called' });
    await setDoc(doc(d, 'leads/lead_2'), { tenantId: T, name: 'Kumar', phone: '9222222222', assignedAgent: 'swami@threepin.in' });
    await setDoc(doc(d, 'leads/lead_2/notes/n1'), { text: 'private' });
    await setDoc(doc(d, 'leads/lead_3'), { tenantId: T, name: 'Divya', phone: '9333333333', assignedAgent: 'swami@threepin.in', agentAccess: ['rameez@threepin.in'] });
    await setDoc(doc(d, 'leads/lead_4'), { tenantId: T, name: 'Arun', phone: '9444444444', secondaryAgent: 'rameez@threepin.in' });
    await setDoc(doc(d, 'leads/lead_x'), { tenantId: 't_other', name: 'Other', assignedAgent: 'rameez@threepin.in' });
    await setDoc(doc(d, `agentViews/${T}__u_rameez`), { tenantId: T, uid: 'u_rameez', expiresAt: Date.now() + 3600000, props: [] });
    await setDoc(doc(d, `agentViews/${T}__u_other`), { tenantId: T, uid: 'u_other', expiresAt: Date.now() + 3600000, props: [] });
    await setDoc(doc(d, `agentViews/${T}__u_old`), { tenantId: T, uid: 'u_old', expiresAt: Date.now() - 1000, props: [] });
    await setDoc(doc(d, 'accessRequests/r1'), { tenantId: T, requesterEmail: 'rameez@threepin.in', approvers: ['swami@threepin.in'], status: 'pending' });
    await setDoc(doc(d, 'accessRequests/r2'), { tenantId: T, requesterEmail: 'swami@threepin.in', approvers: ['rameez@threepin.in'], status: 'pending' });
    await setDoc(doc(d, 'accessRequests/r3'), { tenantId: T, requesterEmail: 'pradeep@threepin.in', approvers: ['swami@threepin.in'], status: 'pending' });
    await setDoc(doc(d, 'requestPrivate/r1'), { tenantId: T, approvers: ['swami@threepin.in'], leadId: 'lead_2' });
    await setDoc(doc(d, 'requestPrivate/r2'), { tenantId: T, approvers: ['rameez@threepin.in'], leadId: 'lead_1' });
    await setDoc(doc(d, 'grants/g1'), { tenantId: T, agentEmail: 'rameez@threepin.in', active: true });
    await setDoc(doc(d, 'grants/g2'), { tenantId: T, agentEmail: 'pradeep@threepin.in', active: true });
    await setDoc(doc(d, 'visitAlerts/v1'), { tenantId: T, to: ['rameez@threepin.in'] });
    await setDoc(doc(d, 'visitAlerts/v2'), { tenantId: T, to: ['swami@threepin.in'] });
    await setDoc(doc(d, 'assignmentLog/a1'), { tenantId: T, propertyId: 'ADRM0002' });
    await setDoc(doc(d, 'propertySubmissions/s1'), { tenantId: T, byEmail: 'rameez@threepin.in' });
    await setDoc(doc(d, 'threads/th1'), { tenantId: T, title: 'Access: 3 BHK', members: ['rameez@threepin.in', 'swami@threepin.in'], lastAt: 1, lastText: '', unread: {}, reads: {} });
    await setDoc(doc(d, 'threads/th1/messages/m1'), { kind: 'text', text: 'hi', at: 1, by: 'swami@threepin.in' });
    await setDoc(doc(d, 'threads/th2'), { tenantId: T, title: 'Private', members: ['pradeep@threepin.in', 'thirumal@threepin.in'], lastAt: 1, lastText: '', unread: {}, reads: {} });
    await setDoc(doc(d, 'threads/th2/messages/m1'), { kind: 'text', text: 'secret', at: 1, by: 'swami@threepin.in' });
    await setDoc(doc(d, 'threads/th3'), { tenantId: T, title: 'Weekend visits', members: ['rameez@threepin.in', 'swami@threepin.in'], lastAt: 1, lastText: '', reads: {} });
    await setDoc(doc(d, 'threads/th3/messages/x3'), { kind: 'text', text: 'Only in th3', at: 1, by: 'swami@threepin.in' });
    await setDoc(doc(d, 'threads/th1/messages/s1'), { kind: 'system', text: 'Rameez asked for the details of 3 BHK', at: 1, by: 'rameez@threepin.in' });
    await setDoc(doc(d, `leadViews/${T}__v1_0`), { tenantId: T, rows: {} });
    await setDoc(doc(d, `settings/${T}`), { team: {} });
    await setDoc(doc(d, `pipelines/${T}`), { stages: [] });
    await setDoc(doc(d, `finance/${T}`), { booksStartDate: '2026-04-01' });
    await setDoc(doc(d, `finance/${T}/invoices/i1`), { total: 100 });
    await setDoc(doc(d, 'listings/L1'), { tenantId: T });
    await setDoc(doc(d, 'propertyChanges/c1'), { tenantId: T, from: '9000000000' });
    await setDoc(doc(d, 'conversations/c1'), { tenantId: T });
    await setDoc(doc(d, `taskConfigs/${T}`), { tenantId: T, managers: ['swami@threepin.in'] });
    await setDoc(doc(d, 'tasks/t1'), {
      tenantId: T, title: 'Call owner', description: '', status: 'todo', history: [],
      assignees: ['rameez@threepin.in'], visibleTo: [`${T}|rameez@threepin.in`, `${T}|swami@threepin.in`],
    });
    await setDoc(doc(d, 'tasks/t2'), {
      tenantId: T, title: 'Not his', description: '', status: 'todo', history: [],
      assignees: ['pradeep@threepin.in'], visibleTo: [`${T}|pradeep@threepin.in`],
    });
    // A manager once let Rameez see Pradeep's tasks (before he became an agent).
    await setDoc(doc(d, 'tasks/t4'), {
      tenantId: T, title: 'Pradeep’s, Rameez a viewer', description: '', status: 'todo', history: [],
      assignees: ['pradeep@threepin.in'], visibleTo: [`${T}|pradeep@threepin.in`, `${T}|rameez@threepin.in`],
    });
    await setDoc(doc(d, 'config/whatsappBot'), { token: 'legacy' });
    await setDoc(doc(d, `agentConfigs/${T}`), { tenantId: T, tabs: ['properties'], otherPropertyFields: ['title'], overrides: {} });
    await setDoc(doc(d, 'users/u_rameez'), { tenantId: T, role: 'agent' });
  });
});

// ── Staff: nothing changed for the team as it was ──
test('staff (no role) still read and write properties, leads, settings and finance as before', async () => {
  const d = db('staff');
  await assertSucceeds(getDoc(doc(d, 'properties/ADRM0002')));
  await assertSucceeds(getDocs(query(collection(d, 'properties'), where('tenantId', '==', T))));
  await assertSucceeds(updateDoc(doc(d, 'properties/ADRM0002'), { name: 'x', tenantId: T }));
  await assertSucceeds(getDoc(doc(d, 'properties/ADRM0002/internalNotes/n1')));
  await assertSucceeds(getDoc(doc(d, 'leads/lead_1')));
  await assertSucceeds(getDoc(doc(d, 'leads/lead_1/notes/n1')));
  await assertSucceeds(getDoc(doc(d, `leadViews/${T}__v1_0`)));
  await assertSucceeds(getDoc(doc(d, `settings/${T}`)));
  await assertSucceeds(getDoc(doc(d, `finance/${T}/invoices/i1`)));
  await assertSucceeds(getDoc(doc(d, 'listings/L1')));
});

test('another tenant still sees nothing', async () => {
  const d = db('other');
  await assertFails(getDoc(doc(d, 'properties/ADRM0002')));
  await assertFails(getDoc(doc(d, 'leads/lead_1')));
  await assertFails(getDoc(doc(d, `agentConfigs/${T}`)));
});

// ── Agent: shut out of everything that is not theirs ──
test('agent cannot read or write properties, even one assigned to them (copies come from the server)', async () => {
  const d = db('agent');
  await assertFails(getDoc(doc(d, 'properties/ADRM0002')));
  await assertFails(getDocs(query(collection(d, 'properties'), where('tenantId', '==', T))));
  await assertFails(getDoc(doc(d, 'properties/ADRM0002/internalNotes/n1')));
  await assertFails(updateDoc(doc(d, 'properties/ADRM0002'), { assignedAgent: 'rameez@threepin.in', tenantId: T }));
  await assertFails(setDoc(doc(d, 'properties/NEW1'), { tenantId: T, name: 'x' }));
  await assertFails(getDoc(doc(d, 'propertyChanges/c1')));
});

test('agent reads only their own leads (assigned, secondary, or reached through agentAccess), never the packed views', async () => {
  const d = db('agent');
  await assertSucceeds(getDoc(doc(d, 'leads/lead_1')));
  await assertSucceeds(getDoc(doc(d, 'leads/lead_3')));
  await assertSucceeds(getDoc(doc(d, 'leads/lead_4')));
  await assertFails(getDoc(doc(d, 'leads/lead_2')));
  await assertFails(getDoc(doc(d, 'leads/lead_x')));
  await assertFails(getDoc(doc(d, 'leads/lead_none')));
  await assertFails(getDocs(query(collection(d, 'leads'), where('tenantId', '==', T))));
  const mine = await assertSucceeds(getDocs(query(collection(d, 'leads'), where('tenantId', '==', T), where('assignedAgent', '==', 'rameez@threepin.in'))));
  if (mine.size !== 1) throw new Error('expected 1 assigned lead, got ' + mine.size);
  await assertSucceeds(getDocs(query(collection(d, 'leads'), where('tenantId', '==', T), where('secondaryAgent', '==', 'rameez@threepin.in'))));
  await assertSucceeds(getDocs(query(collection(d, 'leads'), where('tenantId', '==', T), where('agentAccess', 'array-contains', 'rameez@threepin.in'))));
  await assertFails(getDocs(query(collection(d, 'leads'), where('tenantId', '==', T), where('assignedAgent', '==', 'swami@threepin.in'))));
  await assertSucceeds(getDoc(doc(d, 'leads/lead_1/notes/n1')));
  await assertFails(getDoc(doc(d, 'leads/lead_2/notes/n1')));
  await assertFails(setDoc(doc(d, 'leads/lead_1/notes/n2'), { text: 'direct write' }));
  await assertFails(updateDoc(doc(d, 'leads/lead_1'), { stageId: 'won', tenantId: T }));
  await assertFails(updateDoc(doc(d, 'leads/lead_2'), { assignedAgent: 'rameez@threepin.in', tenantId: T }));
  await assertFails(setDoc(doc(d, 'leads/lead_9'), { tenantId: T, name: 'x', assignedAgent: 'rameez@threepin.in' }));
  await assertFails(getDoc(doc(d, `leadViews/${T}__v1_0`)));
  await assertFails(getDoc(doc(d, 'conversations/c1')));
});

test('a lead opened by an approved request: read-only, one at a time, and only while the grant runs', async () => {
  const d = db('agent');
  const g = `${T}__l__lead_2__rameez_threepin_in`;
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'grants/' + g), { tenantId: T, kind: 'lead', targetId: 'lead_2', agentEmail: 'rameez@threepin.in', active: true, expiresAt: Date.now() + 3600000 });
  });
  await assertSucceeds(getDoc(doc(d, 'leads/lead_2')));
  await assertSucceeds(getDoc(doc(d, 'leads/lead_2/notes/n1')));
  await assertFails(updateDoc(doc(d, 'leads/lead_2'), { stageId: 'won', tenantId: T }));
  await assertFails(getDocs(query(collection(d, 'leads'), where('tenantId', '==', T), where('assignedAgent', '==', 'swami@threepin.in'))));
  await env.withSecurityRulesDisabled(async ctx => { await updateDoc(doc(ctx.firestore(), 'grants/' + g), { expiresAt: Date.now() - 1000 }); });
  await assertFails(getDoc(doc(d, 'leads/lead_2')), 'its timer ran out: closed at once, no tidy-up needed');
  await assertFails(getDoc(doc(d, 'leads/lead_2/notes/n1')));
  await env.withSecurityRulesDisabled(async ctx => { await updateDoc(doc(ctx.firestore(), 'grants/' + g), { expiresAt: null, active: false }); });
  await assertFails(getDoc(doc(d, 'leads/lead_2')), 'taken back');
  // Someone else's grant on the same lead opens nothing for him.
  await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), `grants/${T}__l__lead_2__kavya_threepin_in`), { tenantId: T, kind: 'lead', targetId: 'lead_2', agentEmail: 'kavya@threepin.in', active: true, expiresAt: null }); });
  await assertFails(getDoc(doc(d, 'leads/lead_2')));
});

test('an agent whose email is not confirmed reads no lead at all', async () => {
  const d = env.authenticatedContext('u_rameez', { tenantId: T, role: 'agent', email: 'rameez@threepin.in', email_verified: false }).firestore();
  await assertFails(getDoc(doc(d, 'leads/lead_1')));
});

test('agent cannot open finance, shoots or settings; reads the stage names only', async () => {
  const d = db('agent');
  await assertFails(getDoc(doc(d, `finance/${T}`)));
  await assertFails(getDoc(doc(d, `finance/${T}/invoices/i1`)));
  await assertFails(getDoc(doc(d, 'listings/L1')));
  await assertFails(getDoc(doc(d, `settings/${T}`)));
  await assertFails(setDoc(doc(d, `settings/${T}`), { team: { me: { email: 'rameez@threepin.in' } } }));
  await assertSucceeds(getDoc(doc(d, `pipelines/${T}`)));
  await assertFails(setDoc(doc(d, `pipelines/${T}`), { stages: [] }));
});

test('agent reads their own copy of the properties, only while it has not run out, and nobody else’s', async () => {
  const d = db('agent');
  await assertSucceeds(getDoc(doc(d, `agentViews/${T}__u_rameez`)));
  await assertFails(getDoc(doc(d, `agentViews/${T}__u_other`)));
  await assertFails(setDoc(doc(d, `agentViews/${T}__u_rameez`), { tenantId: T, expiresAt: 9e15, props: [{ id: 'X' }] }));
  const old = env.authenticatedContext('u_old', { tenantId: T, role: 'agent', email: 'old@threepin.in', email_verified: true }).firestore();
  await assertFails(getDoc(doc(old, `agentViews/${T}__u_old`)));
  await assertFails(getDoc(doc(db('staff'), `agentViews/${T}__u_rameez`)));
});

test('requests: the asker and the approvers read them; the lead behind a lead request is for approvers only; nobody writes them', async () => {
  const d = db('agent');
  await assertSucceeds(getDoc(doc(d, 'accessRequests/r1')));
  await assertSucceeds(getDoc(doc(d, 'accessRequests/r2')));
  await assertFails(getDoc(doc(d, 'accessRequests/r3')));
  await assertSucceeds(getDocs(query(collection(d, 'accessRequests'), where('tenantId', '==', T), where('requesterEmail', '==', 'rameez@threepin.in'))));
  await assertSucceeds(getDocs(query(collection(d, 'accessRequests'), where('tenantId', '==', T), where('approvers', 'array-contains', 'rameez@threepin.in'))));
  await assertFails(getDocs(query(collection(d, 'accessRequests'), where('tenantId', '==', T))));
  await assertFails(getDoc(doc(d, 'requestPrivate/r1')));
  await assertSucceeds(getDoc(doc(d, 'requestPrivate/r2')));
  await assertFails(updateDoc(doc(d, 'accessRequests/r2'), { status: 'approved' }));
  await assertFails(setDoc(doc(d, 'accessRequests/new'), { tenantId: T, requesterEmail: 'rameez@threepin.in', approvers: [], status: 'approved' }));
  await assertSucceeds(getDocs(query(collection(db('staff'), 'accessRequests'), where('tenantId', '==', T))));
  await assertFails(updateDoc(doc(db('admin'), 'accessRequests/r1'), { status: 'approved' }));
});

test('grants, visit alerts and submissions: the agent sees their own only; nobody creates a grant from the page', async () => {
  const d = db('agent');
  await assertSucceeds(getDoc(doc(d, 'grants/g1')));
  await assertFails(getDoc(doc(d, 'grants/g2')));
  await assertFails(setDoc(doc(d, 'grants/g3'), { tenantId: T, agentEmail: 'rameez@threepin.in', active: true }));
  await assertFails(updateDoc(doc(d, 'grants/g1'), { expiresAt: null }));
  await assertFails(setDoc(doc(db('admin'), 'grants/g4'), { tenantId: T, agentEmail: 'rameez@threepin.in', active: true }));
  await assertSucceeds(getDoc(doc(d, 'visitAlerts/v1')));
  await assertFails(getDoc(doc(d, 'visitAlerts/v2')));
  await assertSucceeds(getDocs(query(collection(d, 'visitAlerts'), where('tenantId', '==', T), where('to', 'array-contains', 'rameez@threepin.in'))));
  await assertFails(getDoc(doc(d, 'assignmentLog/a1')));
  await assertSucceeds(getDoc(doc(db('staff'), 'assignmentLog/a1')));
  await assertSucceeds(getDoc(doc(d, 'propertySubmissions/s1')));
  await assertFails(setDoc(doc(d, 'propertySubmissions/s2'), { tenantId: T, byEmail: 'rameez@threepin.in' }));
});

test('a reply names a message in the same conversation by id — never a made-up quote, never another thread', async () => {
  const d = db('agent');
  const msg = extra => ({ kind: 'text', text: 'Sunday works', at: Date.now(), by: 'rameez@threepin.in', ...extra });
  await assertSucceeds(setDoc(doc(d, 'threads/th1/messages/r1'), msg({ replyTo: 'm1' })));
  await assertSucceeds(setDoc(doc(d, 'threads/th1/messages/r2'), msg({ replyTo: 's1' })));            // the request's own line
  await assertSucceeds(setDoc(doc(d, 'threads/th1/messages/r3'), msg({ replyTo: 'r1' })));            // a reply to a reply
  await assertFails(setDoc(doc(d, 'threads/th1/messages/r4'), msg({ replyTo: 'gone' })));             // no such message
  await assertFails(setDoc(doc(d, 'threads/th1/messages/r5'), msg({ replyTo: 'x3' })));               // it is in another thread (one they can read)
  await assertFails(setDoc(doc(d, 'threads/th1/messages/r6'), msg({ replyTo: '../../th3/messages/x3' })));
  await assertFails(setDoc(doc(d, 'threads/th1/messages/r7'), msg({ replyTo: { id: 'm1', text: 'I never said this' } })));
  await assertFails(setDoc(doc(d, 'threads/th1/messages/r8'), msg({ replyTo: 42 })));
  await assertFails(setDoc(doc(d, 'threads/th1/messages/r9'), msg({ replyTo: 'm1', quote: 'I never said this' })));
  await assertFails(setDoc(doc(d, 'threads/th2/messages/r10'), msg({ replyTo: 'm1' })));             // not their conversation
});

test('messages: members read and write; others do not; admins read every thread; a message is always from its writer', async () => {
  const d = db('agent');
  await assertSucceeds(getDoc(doc(d, 'threads/th1')));
  await assertFails(getDoc(doc(d, 'threads/th2')));
  await assertSucceeds(getDocs(query(collection(d, 'threads'), where('tenantId', '==', T), where('members', 'array-contains', 'rameez@threepin.in'))));
  await assertFails(getDocs(query(collection(d, 'threads'), where('tenantId', '==', T))));
  await assertSucceeds(getDocs(collection(d, 'threads/th1/messages')));
  await assertFails(getDocs(collection(d, 'threads/th2/messages')));
  await assertSucceeds(setDoc(doc(d, 'threads/th1/messages/m2'), { kind: 'text', text: 'On my way', at: Date.now(), by: 'rameez@threepin.in' }));
  await assertFails(setDoc(doc(d, 'threads/th1/messages/m3'), { kind: 'text', text: 'fake', at: Date.now(), by: 'swami@threepin.in' }));
  await assertFails(setDoc(doc(d, 'threads/th1/messages/m4'), { kind: 'system', text: 'Approved by Swami', at: Date.now(), by: 'rameez@threepin.in' }));
  await assertFails(setDoc(doc(d, 'threads/th2/messages/m5'), { kind: 'text', text: 'hi', at: Date.now(), by: 'rameez@threepin.in' }));
  await assertSucceeds(updateDoc(doc(d, 'threads/th1'), { lastAt: Date.now(), lastText: 'On my way', lastBy: 'rameez@threepin.in', 'reads.rameez_threepin_in': Date.now() }));
  await assertSucceeds(updateDoc(doc(d, 'threads/th1'), { 'reads.rameez_threepin_in': Date.now() }));
  // Nobody writes anyone else's counter or read mark, or posts the last line as someone else (the
  // stored-script hole an earlier version had: any value in anyone's unread count).
  await assertFails(updateDoc(doc(d, 'threads/th1'), { 'unread.swami_threepin_in': '<img src=x onerror=alert(1)>' }));
  await assertFails(updateDoc(doc(d, 'threads/th1'), { 'reads.swami_threepin_in': Date.now() }));
  await assertFails(updateDoc(doc(d, 'threads/th1'), { lastAt: Date.now(), lastText: 'Approved', lastBy: 'swami@threepin.in' }));
  await assertFails(updateDoc(doc(d, 'threads/th1'), { lastAt: Date.now() - 86400000, lastText: 'x', lastBy: 'rameez@threepin.in' }));
  await assertFails(updateDoc(doc(d, 'threads/th1'), { 'reads.rameez_threepin_in': 'soon' }));
  await assertFails(setDoc(doc(d, 'threads/th1/messages/m6'), { kind: 'text', text: 'backdated', at: Date.now() - 86400000, by: 'rameez@threepin.in' }));
  await assertFails(updateDoc(doc(d, 'threads/th1'), { members: ['rameez@threepin.in', 'swami@threepin.in', 'pradeep@threepin.in'] }));
  await assertFails(updateDoc(doc(d, 'threads/th1'), { title: 'renamed' }));
  await assertFails(setDoc(doc(d, 'threads/th9'), { tenantId: T, title: 'x', members: ['rameez@threepin.in'] }));
  await assertSucceeds(getDoc(doc(db('admin'), 'threads/th2')));
  await assertSucceeds(getDocs(collection(db('admin'), 'threads/th2/messages')));
  await assertFails(getDoc(doc(db('staff'), 'threads/th2')));
  await assertFails(updateDoc(doc(db('admin'), 'threads/th2'), { lastText: 'x' }));
});

test('agent cannot change their own role, nor anyone’s', async () => {
  const d = db('agent');
  await assertFails(setDoc(doc(d, 'users/u_rameez'), { tenantId: T, role: 'admin' }));
  await assertFails(updateDoc(doc(d, 'users/u_rameez'), { role: 'admin' }));
  await assertFails(getDoc(doc(d, 'accessLog/x')));
});

test('agent reads and works the tasks assigned to them, not others’ — not even as a viewer — and cannot reassign one', async () => {
  const d = db('agent');
  await assertSucceeds(getDoc(doc(d, 'tasks/t1')));
  await assertFails(getDoc(doc(d, 'tasks/t2')));
  await assertFails(getDoc(doc(d, 'tasks/t4')));
  await assertSucceeds(getDocs(query(collection(d, 'tasks'), where('tenantId', '==', T), where('assignees', 'array-contains', 'rameez@threepin.in'))));
  await assertFails(getDocs(query(collection(d, 'tasks'), where('visibleTo', 'array-contains', `${T}|rameez@threepin.in`))));
  await assertSucceeds(updateDoc(doc(d, 'tasks/t1'), { status: 'doing', tenantId: T }));
  await assertFails(updateDoc(doc(d, 'tasks/t1'), { assignees: ['pradeep@threepin.in'] }));
  await assertFails(setDoc(doc(d, 'tasks/t3'), { tenantId: T, title: 'x', description: '', status: 'todo', history: [], assignees: [], visibleTo: [] }));
  await assertSucceeds(getDoc(doc(d, `taskConfigs/${T}`)));
});

test('agent keeps their own Daily task record only', async () => {
  const d = db('agent');
  await assertSucceeds(setDoc(doc(d, `todayOpens/${T}__u_rameez`), { tenantId: T, email: 'rameez@threepin.in', opens: {}, updatedAt: 1 }));
  await assertFails(setDoc(doc(d, `todayOpens/${T}__u_swami`), { tenantId: T, email: 'rameez@threepin.in', opens: {}, updatedAt: 1 }));
});

test('staff can now save their Daily task record too (the rule that was never published)', async () => {
  await assertSucceeds(setDoc(doc(db('staff'), `todayOpens/${T}__u_rajesh`), { tenantId: T, email: 'rajesh@threepin.in', opens: {}, updatedAt: 1 }));
});

// ── Agent settings: read by all, written by admins ──
const goodCfg = {
  tenantId: T, tabs: ['properties', 'crm'], otherPropertyFields: ['title', 'config', 'budget'],
  ownPropertyFields: ['title'], grantedPropertyFields: ['title'], matchingLeadFields: ['requirement'],
  adsScope: 'own', campaignsScope: 'own', actions: { addLeads: true }, approvals: {}, overrides: {}, updatedAt: 1, updatedBy: 'swami@threepin.in',
};

test('the team reads the agent settings; agents do not (they hold every agent’s overrides — the server hands each agent their own)', async () => {
  await assertFails(getDoc(doc(db('agent'), `agentConfigs/${T}`)));
  await assertSucceeds(getDoc(doc(db('staff'), `agentConfigs/${T}`)));
  await assertSucceeds(getDoc(doc(db('admin'), `agentConfigs/${T}`)));
});

test('a viewer of someone’s tasks who is NOT an agent still sees them (unchanged for the team)', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'tasks/t5'), { tenantId: T, title: 'x', description: '', status: 'todo', history: [],
      assignees: ['pradeep@threepin.in'], visibleTo: [`${T}|rajesh@threepin.in`] });
  });
  await assertSucceeds(getDoc(doc(db('staff'), 'tasks/t5')));
});

test('a role nobody defined (a typo, a future role) gets nothing — never full access', async () => {
  for (const k of ['typo', 'future']) {
    const d = db(k);
    await assertFails(getDoc(doc(d, 'leads/lead_1')));
    await assertFails(getDoc(doc(d, 'properties/ADRM0002')));
    await assertFails(getDoc(doc(d, `finance/${T}/invoices/i1`)));
    await assertFails(getDoc(doc(d, `settings/${T}`)));
    await assertFails(getDoc(doc(d, `taskConfigs/${T}`)));
    await assertFails(setDoc(doc(d, `todayOpens/${T}__${who[k].uid}`), { tenantId: T, email: 'x', opens: {}, updatedAt: 1 }));
  }
  // even as an assignee or a viewer of a task
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'tasks/t6'), { tenantId: T, title: 'x', description: '', status: 'todo', history: [],
      assignees: ['typo@threepin.in'], visibleTo: [`${T}|typo@threepin.in`] });
  });
  await assertFails(getDoc(doc(db('typo'), 'tasks/t6')));
  await assertFails(updateDoc(doc(db('typo'), 'tasks/t6'), { status: 'done', tenantId: T }));
});

test('the legacy config collection: the team only — not agents, not accounts without a tenant', async () => {
  await assertSucceeds(getDoc(doc(db('staff'), 'config/whatsappBot')));
  await assertFails(getDoc(doc(db('agent'), 'config/whatsappBot')));
  await assertFails(getDoc(doc(db('noTenant'), 'config/whatsappBot')));
});

test('an account that signed itself up (no tenant) sees nothing', async () => {
  const d = db('noTenant');
  await assertFails(getDoc(doc(d, 'leads/lead_1')));
  await assertFails(getDoc(doc(d, 'properties/ADRM0002')));
  await assertFails(getDoc(doc(d, `agentConfigs/${T}`)));
  await assertFails(getDoc(doc(d, 'tasks/t1')));
});

test('only an admin (confirmed email) writes the agent settings', async () => {
  await assertSucceeds(setDoc(doc(db('admin'), `agentConfigs/${T}`), goodCfg));
  await assertFails(setDoc(doc(db('adminUnverified'), `agentConfigs/${T}`), goodCfg));
  await assertFails(setDoc(doc(db('staff'), `agentConfigs/${T}`), goodCfg));
  await assertFails(setDoc(doc(db('agent'), `agentConfigs/${T}`), goodCfg));
  await assertFails(setDoc(doc(db('admin'), `agentConfigs/t_other`), { ...goodCfg, tenantId: 't_other' }));
  await assertFails(setDoc(doc(db('admin'), `agentConfigs/${T}`), { ...goodCfg, sneaky: true }));
  await assertFails(deleteDoc(doc(db('admin'), `agentConfigs/${T}`)));
});

test('admins keep everything staff has', async () => {
  const d = db('admin');
  await assertSucceeds(getDoc(doc(d, 'properties/ADRM0002')));
  await assertSucceeds(getDoc(doc(d, 'leads/lead_1')));
  await assertSucceeds(getDoc(doc(d, `finance/${T}/invoices/i1`)));
  await assertSucceeds(getDoc(doc(d, 'tasks/t2')));
});

test('attendance records are server-only: no login reads or writes them directly', async () => {
  const id = `${T}__u_rajesh__2026-11-22`;
  for (const k of ['staff', 'admin', 'agent']) {
    const d = db(k);
    await assertFails(getDoc(doc(d, `attendance/${id}`)));
    await assertFails(setDoc(doc(d, `attendance/${id}`), { tenantId: T, uid: who[k].uid, events: [] }));
    await assertFails(getDoc(doc(d, `attendanceConfig/${T}`)));
    await assertFails(setDoc(doc(d, `attendanceConfig/${T}`), { admins: [who[k].tok.email] }));
    await assertFails(getDoc(doc(d, `attendanceSeen/${T}__${who[k].uid}`)));
  }
});
