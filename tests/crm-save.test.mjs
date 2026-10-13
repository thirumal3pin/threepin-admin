// The CRM's lead saves, end to end — the real crm-assets/firebase-sync.js over the in-memory
// Firestore (tests/fake-firestore.mjs) with the lead views built: a save sends ONLY what the person
// changed, so an older copy on the page can never take back a newer value; server-owned parts are
// never sent; a new lead is written whole; a lead deleted elsewhere is never re-created by a save;
// and every save keeps the lead's row in the views equal to the lead.
//   node tests/crm-save.test.mjs
import { register } from 'node:module';
import { makeStore, adminDb } from './fake-firestore.mjs';
import { rebuildLeadViews, readLeads, writeLead } from '../api/_lead-views.js';

register('./_gstatic-loader.mjs', import.meta.url);

let failed = 0, passed = 0;
const check = (label, cond, detail) => { if (cond) passed++; else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : '')); } };
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));
const T = 't_test';
console.log('3 PIN Realty — CRM lead saves\n');

// The page around the module: what crm.html provides.
globalThis.window = globalThis;
let leads = [], toasts = [], snapshots = 0;
window.applyLeadsSnapshot = list => { leads = list; snapshots++; };
window.showToast = t => toasts.push(t);
window.phoneKey = raw => String(raw || '').replace(/\D/g, '').slice(-10);
globalThis.location = { reload() {} };
globalThis.confirm = () => true;
globalThis.alert = () => {};

const store = makeStore(), db = adminDb(store);
globalThis.__fakeStore = store;
store.set('leads/A', { id: 'A', tenantId: T, name: 'Arun', email: '', stageId: 'new', phone: '98400 11111', phoneKey: '9840011111', reached: { new: 1 }, tt: { lastEventAt: 5 }, ai: { verdict: 'warm' }, ttHold: {}, budget: '1 Cr', updatedAt: 1 });
store.set('leads/B', { id: 'B', tenantId: T, name: 'Bala', stageId: 'new', updatedAt: 1 });
await rebuildLeadViews(db, T, ['A', 'B'].map(id => ({ ...store.get('leads/' + id), id })), Date.now());

globalThis.__fakeUser = { email: 'agent@example.com', tenantId: T };
await import('../crm-assets/firebase-sync.js');
for (let i = 0; i < 50 && !leads.length; i++) await tick(40);
await tick(150);
const F = window.crmFirebase;
check('The page receives every lead from the views', leads.length === 2 && leads.some(l => l.id === 'A'));

const writes = [];
const realUpdate = store.update.bind(store), realSet = store.set.bind(store);
store.update = (p, patch, browser) => { if (p.startsWith('leads/')) writes.push({ op: 'update', p, patch: JSON.parse(JSON.stringify(patch)) }); return realUpdate(p, patch, browser); };
store.set = (p, d, o) => { if (p.startsWith('leads/')) writes.push({ op: 'set', p, d: JSON.parse(JSON.stringify(d)), o }); return realSet(p, d, o); };

// 1. Someone else moves A to "won" — this page has not heard yet. Here, only the email is changed.
//    (Not the name: on a TailorTalk lead that is TailorTalk's until the team takes it over.)
const pageA = leads.find(l => l.id === 'A');
realUpdate('leads/A', { stageId: 'won', 'reached.won': 9 });
pageA.email = 'arun@example.com'; pageA.updatedAt = 2;
writes.length = 0;
await F.saveLead(pageA); await tick();
const a = store.get('leads/A');
check('A save from an older copy keeps the newer stage it did not touch', a.stageId === 'won' && a.reached.won === 9, JSON.stringify(a));
check('…and writes the change it made', a.email === 'arun@example.com' && a.updatedAt === 2);
const sent = writes.find(w => w.p === 'leads/A');
const paths = sent && sent.op === 'update' ? sent.patch.map(([seg]) => seg.join('.')).sort() : [];
check('…sending only the changed fields, as an update', sent && sent.op === 'update' && JSON.stringify(paths) === JSON.stringify(['email', 'updatedAt']), JSON.stringify(sent));
check('…never the server-owned parts (tt, ai)', !paths.some(p => /^(tt|ai)\b/.test(p)));
let row = (await readLeads(db, T)).find(l => l.id === 'A');
check('…and its row in the views carries the change', row && row.email === 'arun@example.com');
// The stage was changed behind the views' back (a direct write), so the row is behind on it until
// the lead is opened — which re-checks the row against the lead and puts it right.
const r = await F.healLead('A', leads.find(l => l.id === 'A'));
row = (await readLeads(db, T)).find(l => l.id === 'A');
check('Opening the lead puts a row that fell behind right', r === 'healed' && row.stageId === 'won' && row.email === 'arun@example.com', r);

// 2. A TailorTalk lead's followed field (budget) is TailorTalk's until the team holds it.
pageA.budget = '2 Cr';
writes.length = 0;
await F.saveLead(pageA); await tick();
check('A TailorTalk-followed field the team does not hold is not sent', store.get('leads/A').budget === '1 Cr' && !writes.some(w => JSON.stringify(w).includes('2 Cr')));
pageA.name = 'Arun Kumar'; pageA.ttHold = { name: true };
await F.saveLead(pageA); await tick();
check('…and is sent once the team holds it', store.get('leads/A').name === 'Arun Kumar' && store.get('leads/A').ttHold.name === true);

// 3. Nothing changed: nothing written.
writes.length = 0;
await F.saveLead(leads.find(l => l.id === 'B')); await tick();
check('A save with nothing changed writes nothing', writes.length === 0, JSON.stringify(writes));

// 4. A new lead (not yet in any snapshot) is written whole.
await F.saveLead({ id: 'C', name: 'Chitra', stageId: 'new', phone: '98400 33333', createdAt: 3, updatedAt: 3 });
await tick();
const c = store.get('leads/C');
check('A new lead is written whole, with its tenant and phone key', c && c.name === 'Chitra' && c.tenantId === T && c.phoneKey === '9840033333');
check('…and appears in the views', (await readLeads(db, T)).some(l => l.id === 'C'));

// 5. A lead deleted elsewhere: an edit from this page is refused, not a re-created fragment.
const pageB = leads.find(l => l.id === 'B');
store.delete('leads/B');
pageB.name = 'edit of a deleted lead';
toasts.length = 0;
await F.saveLead(pageB); await tick(200);
check('Editing a lead deleted elsewhere does not re-create it', store.get('leads/B') === undefined);
check('…and says it was not saved', toasts.some(t => /Not saved/.test(t)), JSON.stringify(toasts));
check('…and its row is cleared from the views', !(await readLeads(db, T)).some(l => l.id === 'B'));

// 6. An edit undone before the save's echo came back: the undo is saved too (the baseline moves
//    with every save, not only with snapshots).
await F.saveLead({ id: 'D', name: 'Divya', stageId: 'new', email: 'one@example.com', createdAt: 4, updatedAt: 4 }); await tick();
let pageD = leads.find(l => l.id === 'D');
pageD.email = 'two@example.com'; F.saveLead(pageD);           // no wait: the echo has not come back
pageD.email = 'one@example.com'; await F.saveLead(pageD); await tick();
check('An edit undone before its echo came back: the undo is saved', store.get('leads/D').email === 'one@example.com', store.get('leads/D').email);

// 7. A screen that held a lead across a wait while someone else changed it: saving the held object
//    sends only what this screen changed — the other person's change stays.
const held = leads.find(l => l.id === 'D');
await writeLead(db, T, db.collection('leads').doc('D'), { stageId: 'negotiation', followUpAt: 99 }, 'update');   // another user, through the views
await tick();
check('…(the page has meanwhile received the other change)', leads.find(l => l.id === 'D').stageId === 'negotiation');
held.notesSummary = 'held edit';
await F.saveLead(held); await tick();
const d = store.get('leads/D');
check('Saving an object held across a wait keeps the change made meanwhile', d.stageId === 'negotiation' && d.followUpAt === 99 && d.notesSummary === 'held edit', JSON.stringify(d));

// 8. Deleted elsewhere through the views (its row gone, so it leaves the page's list): a held copy
//    saved later is refused — the lead is not brought back.
const heldC = leads.find(l => l.id === 'C');
await writeLead(db, T, db.collection('leads').doc('C'), null, 'delete'); await tick();
check('…(the page no longer lists it)', !leads.some(l => l.id === 'C'));
heldC.name = 'edit of a lead deleted through the views';
toasts.length = 0;
await F.saveLead(heldC); await tick(200);
check('A held copy of a lead deleted elsewhere is not brought back by a save', store.get('leads/C') === undefined && !(await readLeads(db, T)).some(l => l.id === 'C'));

// 9. One redraw per save of this page's own (not one for the save and another for its stamp).
const pageD2 = leads.find(l => l.id === 'D');
snapshots = 0;
pageD2.notesSummary = 'one redraw'; await F.saveLead(pageD2); await tick(250);
check('A save redraws the page once', snapshots === 1, snapshots);

console.log(failed ? `\n${failed} failed, ${passed} passed.` : `\nAll good (${passed} checks).`);
process.exit(failed ? 1 : 0);
