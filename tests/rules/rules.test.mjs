// Firestore rules — the agent layer, phase 1. Runs against the LOCAL emulator only:
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

test('agent cannot read leads, lead notes or the packed lead views', async () => {
  const d = db('agent');
  await assertFails(getDoc(doc(d, 'leads/lead_1')));
  await assertFails(getDocs(query(collection(d, 'leads'), where('tenantId', '==', T))));
  await assertFails(getDoc(doc(d, 'leads/lead_1/notes/n1')));
  await assertFails(getDoc(doc(d, `leadViews/${T}__v1_0`)));
  await assertFails(getDoc(doc(d, 'conversations/c1')));
  await assertFails(setDoc(doc(d, 'leads/lead_2'), { tenantId: T, name: 'x' }));
});

test('agent cannot open finance, shoots, settings or the pipeline', async () => {
  const d = db('agent');
  await assertFails(getDoc(doc(d, `finance/${T}`)));
  await assertFails(getDoc(doc(d, `finance/${T}/invoices/i1`)));
  await assertFails(getDoc(doc(d, 'listings/L1')));
  await assertFails(getDoc(doc(d, `settings/${T}`)));
  await assertFails(setDoc(doc(d, `settings/${T}`), { team: { me: { email: 'rameez@threepin.in' } } }));
  await assertFails(getDoc(doc(d, `pipelines/${T}`)));
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
