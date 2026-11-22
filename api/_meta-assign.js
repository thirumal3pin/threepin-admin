// ═══════ META ADS LEADS — who gets a lead ═══════
//
// Used by api/_meta-leads.js. Three things the owner asked for (22 Nov 2026):
//
//  1. Only an admin hands a lead to an AGENT (an outside broker, role 'agent'). Agents never change
//     "Assigned to"; office staff may still assign among themselves and Take a lead, but not give one
//     to (or take one from) an agent.
//  2. An agent sees the ad leads assigned to them — in any connected sheet, not only their own
//     properties' — and the lead's property is approved to them automatically: a property grant
//     (details, not the owner's number) for 30 days, renewed whenever another lead for it is assigned.
//  3. A default person per sheet or per property (optional): a lead that arrives AFTER it was set, with
//     "Assigned to" still empty, is assigned to that person when the sheet is next read (any page open
//     or refresh). Removing it stops it for the next leads; nothing already assigned changes.
//
// Every assignment the app makes (by hand or by default) e-mails the person, with the lead's name,
// number, property and form answers, so a 9 pm lead is not waiting for someone to open the page.
//
// Records:
//   metaLeadConfigs/{tenant}.autoAssign  { sheets: { sourceId: rule }, props: { CODE: rule } }
//                                        rule = { email, since, by, at }
//   metaLeadAssign/{tenant}              { pairs: { "email|CODE": { until, at } }, agents: { emailKey: at } }
//                                        — which agent was given which property (so a grant is written
//                                        once, not on every read), and which agents have ad leads (the
//                                        menu shows them Meta Ads Leads even without the Ads tab)
//   grants/{tenant}__p__{propertyId}__{emailKey}   the agent layer's property access (via: 'meta-lead')
import { getAuth } from 'firebase-admin/auth';
import { readTab, matchAgent } from '../crm-assets/metaLeadsModel.js';
import { displayName } from '../crm-assets/mentions.js';
import * as AA from '../shared-assets/agent-access.js';

export const GRANT_DAYS = 30;
const DAY = 86400000;
const lc = s => String(s || '').trim().toLowerCase();
export const ASSIGN_DOC = 'metaLeadAssign';

// Everyone with a login on the tenant: { email, uid, role, name }. Auth, not Firestore (no reads).
export async function teamPeople(tenantId, deps = {}) {
  if (deps.team) return (await deps.team()).filter(p => p.email);
  const out = [];
  let token;
  do {
    const page = await getAuth().listUsers(1000, token);
    for (const u of page.users) {
      const c = u.customClaims || {};
      if (c.tenantId === tenantId && u.email && !u.disabled) out.push({ email: lc(u.email), uid: u.uid, role: c.role || 'none', name: u.displayName || '' });
    }
    token = page.pageToken;
  } while (token);
  return out;
}
export const isAdminUser = u => !!(u && u.role === 'admin' && u.email_verified === true);
// The name written into "Assigned to" — the same the page writes (crm-assets/mentions.js displayName),
// so matchAgent reads it back to the same person.
export const assignLabel = email => displayName(lc(email));

// Who a written "Assigned to" means, or null — the loose reading the page uses for lists and counts.
export const whoIs = (raw, people) => matchAgent(raw, people.map(p => p.email));
// The STRICT reading, for what an agent may see and the property access an assignment brings: the
// cell must say exactly the name the app writes for them (or their address), and no one else on the
// team may share that name. A first name typed by hand that happens to fit an outside broker never
// opens a lead or a property to them.
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
export function isExactlyFor(raw, email, people) {
  const v = norm(raw);
  if (!v) return false;
  if (v === lc(email)) return true;
  if (v !== norm(assignLabel(email))) return false;
  return !people.some(p => p.email !== lc(email) && norm(assignLabel(p.email)) === v);
}
// The one person a cell says exactly, or null.
export const exactlyWho = (raw, people) => (people.find(p => isExactlyFor(raw, p.email, people)) || {}).email || null;

// The default for one tab: the sheet's own, else its property's. → { email, since, scope } | null
export function ruleFor(autoAssign, sourceId, code) {
  const a = autoAssign || {};
  const s = a.sheets && a.sheets[sourceId];
  if (s && s.email) return { ...s, scope: 'sheet' };
  const p = code && a.props && a.props[String(code).toUpperCase()];
  if (p && p.email) return { ...p, scope: 'property' };
  return null;
}

// Checks every "assigned" edit of a write. → { ok } | { error, status }
//   agents: never; anyone but an admin: not to, or away from, an agent.
export function checkAssignEdits(user, edits, people) {
  const assigning = (edits || []).filter(e => e && e.field === 'assigned');
  if (!assigning.length) return { ok: true };
  if (user.role === 'agent') return { error: 'Only an admin can assign leads', status: 403 };
  if (isAdminUser(user)) return { ok: true };
  const agents = people.filter(p => p.role === 'agent');
  const meansAgent = v => { const w = whoIs(v, people); return (w && agents.some(a => a.email === w)) || agents.some(a => isExactlyFor(v, a.email, people)); };
  for (const e of assigning) {
    if (e.from === undefined) return { error: 'Reload the leads and try again', status: 409 };   // never a blind overwrite of who has a lead
    if (meansAgent(e.value) || meansAgent(e.from)) return { error: 'Only an admin can give a lead to an agent, or take one from an agent', status: 403 };
  }
  return { ok: true };
}

// The enquiries of a tab as the page reads them (readTab), keyed by Meta lead id.
export function enquiriesById(tab) {
  const r = readTab(tab);
  const by = new Map();
  for (const e of r.enquiries) if (e.metaId) by.set(e.metaId, e);
  return { cols: r.cols, by };
}

// An agent's view of a tab: the rows they may see. Their own properties' tabs: every row. Any other
// tab: only the rows assigned to them; the rest are blanked (not removed — row numbers stay right).
export function rowsForAgent(tab, agentEmail, people, ownCodes) {
  const code = String(tab.propertyCode || '').toUpperCase();
  if (ownCodes && ownCodes.has(code)) return { ...tab, values: tab.values, own: true };
  const values = Array.isArray(tab.values) ? tab.values : [];
  if (!values.length) return null;
  const { cols } = readTab({ ...tab, values: values.slice(0, 1) });
  const aCol = (cols.find(c => c.role === 'assigned') || {}).index;
  if (aCol == null) return null;
  let any = false;
  const out = [values[0], ...values.slice(1).map(row => {
    const mine = isExactlyFor((row || [])[aCol], agentEmail, people);
    if (mine) any = true;
    return mine ? row : [];
  })];
  return any ? { ...tab, values: out, own: false } : null;
}

// The default-person edits a freshly read tab needs: rows with a Meta id, created at or after the
// rule was set, and nobody in "Assigned to". → [{ metaId, field: 'assigned', value, from: '' }]
export function autoAssignEdits(tab, rule, now = Date.now()) {
  if (!rule || !rule.email) return [];
  const { by } = enquiriesById(tab);
  const label = assignLabel(rule.email);
  const out = [];
  for (const e of by.values()) {
    if (e.team && String(e.team.assigned || '').trim()) continue;
    if (!(e.at && e.at >= (rule.since || now))) continue;
    out.push({ metaId: e.metaId, field: 'assigned', value: label, from: '' });
  }
  return out;
}

// After assignments were written: property grants for the agents among the people, e-mails to everyone
// assigned. assigned: [{ email, propertyCode, enquiry }]. Failures are logged, never thrown — the sheet
// is already written and that is what counts.
export async function afterAssigned(db, tenantId, by, assigned, people, deps = {}) {
  if (!assigned.length) return { granted: [], mailed: 0 };
  const now = (deps.now || Date.now)();
  const agents = new Map(people.filter(p => p.role === 'agent').map(p => [p.email, p]));
  const granted = [];
  // ── grants (agents only) ──
  const pairs = [...new Set(assigned.filter(a => agents.has(a.email) && a.propertyCode).map(a => a.email + '|' + String(a.propertyCode).toUpperCase()))];
  if (pairs.length) {
    try {
      const ref = db.collection(ASSIGN_DOC).doc(tenantId);
      const cur = (await ref.get()).data() || {};
      const known = cur.pairs || {};
      const todo = pairs.filter(k => !(known[k] && known[k].until > now + (GRANT_DAYS - 7) * DAY));
      const patch = { tenantId, pairs: { ...known }, agents: { ...(cur.agents || {}) } };
      for (const k of pairs) { const email = k.split('|')[0]; patch.agents[AA.emailKey(email)] = now; }
      const rebuild = new Set();
      for (const k of todo) {
        const [email, code] = k.split('|');
        const p = await propertyByCode(db, tenantId, code);
        if (!p) { patch.pairs[k] = { at: now, until: now + GRANT_DAYS * DAY, missing: true }; continue; }
        const gRef = db.collection('grants').doc(AA.grantId(tenantId, 'property', p.id, email));
        const until = now + GRANT_DAYS * DAY;
        await db.runTransaction(async t => {
          const g = await t.get(gRef);
          const old = g.exists ? g.data() : null;
          // Never shorten or narrow access someone approved by hand (no limit, or a longer one).
          if (old && old.active && (old.expiresAt == null || old.expiresAt >= until) && old.via !== 'meta-lead') return;
          const line = { at: now, by, what: old && old.active ? 'extended' : 'granted', note: 'ad lead assigned' };
          t.set(gRef, {
            tenantId, kind: 'property', targetId: p.id, targetRef: null, title: p.name || p.propertyCode || p.id,
            agentUid: agents.get(email).uid || null, agentEmail: email, agentName: agents.get(email).name || assignLabel(email),
            requestId: null, grantedBy: by, grantedByName: assignLabel(by), grantedAt: now, active: true,
            expiresAt: until, includeContact: !!(old && old.active && old.includeContact), contactExpiresAt: old && old.active ? old.contactExpiresAt || null : null,
            revokedBy: null, revokedAt: null, revokeReason: null, via: 'meta-lead',
            history: [...((old && old.history) || []), line].slice(-50),
          });
        });
        patch.pairs[k] = { at: now, until, propertyId: p.id };
        granted.push({ email, propertyId: p.id, code });
        rebuild.add(email);
      }
      await ref.set(patch, { merge: true });
      if (rebuild.size && deps.rebuildAgents) await deps.rebuildAgents(db, tenantId, [...rebuild]).catch(e => console.error('meta-assign rebuild:', e.message));
    } catch (e) { console.error('meta-assign grants:', e && e.message); }
  }
  // ── e-mails (everyone assigned, one message per person) ──
  let mailed = 0;
  if (deps.mail) {
    const byPerson = new Map();
    for (const a of assigned) { if (!byPerson.has(a.email)) byPerson.set(a.email, []); byPerson.get(a.email).push(a); }
    for (const [email, list] of byPerson) {
      if (email === lc(by) && !list.some(a => a.auto)) continue;   // took it themselves: no e-mail to self
      try { const r = await deps.mail(email, assignEmail(list, deps.appUrl)); if (r && r.ok) mailed++; else console.error('meta-assign mail failed', email, r && r.error); }
      catch (e) { console.error('meta-assign mail:', e && e.message); }
    }
  }
  return { granted, mailed };
}

async function propertyByCode(db, tenantId, code) {
  const c = String(code || '').trim();
  if (!c) return null;
  const d = await db.collection('properties').doc(c).get();
  if (d.exists && d.data().tenantId === tenantId) return { id: d.id, ...d.data() };
  const q = await db.collection('properties').where('tenantId', '==', tenantId).where('propertyCode', '==', c).limit(1).get();
  return q.empty ? null : { id: q.docs[0].id, ...q.docs[0].data() };
}

// The "new lead for you" e-mail: every lead in the list, with what the agent needs to call.
export function assignEmail(list, appUrl = 'https://admin.threepin.in') {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = list.length;
  const first = list[0].enquiry || {};
  const subject = n === 1 ? `New ad lead for you: ${first.name || 'a new enquiry'} · ${list[0].propertyCode || ''}`.trim() : `${n} new ad leads for you`;
  const card = a => {
    const e = a.enquiry || {};
    const answers = (e.answers || []).slice(0, 6).map(x => `<tr><td style="padding:3px 0;color:#666;font-size:13px">${esc(x.label)}</td><td style="padding:3px 0 3px 10px;font-size:13px">${esc(x.value)}</td></tr>`).join('');
    const tel = String(e.phone || '').replace(/[^\d+]/g, '');
    return `<div style="border:1px solid #E5E5E5;border-radius:10px;padding:14px 16px;margin:0 0 12px">
      <div style="font-size:16px;font-weight:bold">${esc(e.name || 'No name')}</div>
      <div style="font-size:13px;color:#666;margin:2px 0 8px">${esc(a.propertyCode || '')}${e.ad ? ' · ' + esc(e.ad) : ''}${a.auto ? ' · assigned automatically' : ''}</div>
      ${tel ? `<a href="tel:${esc(tel)}" style="display:inline-block;background:#1E8E3E;color:#fff;text-decoration:none;font-weight:bold;font-size:14px;padding:8px 14px;border-radius:8px;margin-right:6px">Call ${esc(e.phone)}</a><a href="https://wa.me/${esc(tel.replace(/^\+/, '').replace(/^(\d{10})$/, '91$1'))}" style="display:inline-block;background:#fff;border:1px solid #1E8E3E;color:#1E8E3E;text-decoration:none;font-weight:bold;font-size:14px;padding:7px 13px;border-radius:8px">WhatsApp</a>` : '<span style="color:#C5221F;font-size:13px">No phone number on this lead</span>'}
      ${answers ? `<table role="presentation" style="margin-top:10px">${answers}</table>` : ''}
    </div>`;
  };
  const text = list.map(a => { const e = a.enquiry || {}; return `${e.name || 'No name'} — ${e.phone || 'no number'} — ${a.propertyCode || ''}`; }).join('\n') + `\n\nOpen: ${appUrl}/ads`;
  const html = `<!doctype html><html><body style="margin:0;padding:20px 12px;background:#F4F4F4;font-family:Arial,Helvetica,sans-serif;color:#212121">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #E0E0E0;overflow:hidden">
  <div style="background:#FF8A00;height:6px"></div>
  <div style="padding:20px 20px 8px"><div style="font-size:12px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;color:#A35A00">Meta ad lead${n > 1 ? 's' : ''} assigned to you</div>
  <h1 style="font-size:19px;margin:8px 0 14px">${n === 1 ? 'Call them while the enquiry is fresh' : n + ' new leads — call them while they are fresh'}</h1>
  ${list.slice(0, 20).map(card).join('')}
  <a href="${esc(appUrl)}/ads" style="display:inline-block;background:#212121;color:#fff;text-decoration:none;font-weight:bold;font-size:14px;padding:10px 16px;border-radius:8px;margin:4px 0 16px">Open in Meta Ads Leads</a>
  </div><div style="padding:10px 20px;background:#FAFAFA;border-top:1px solid #EEE;font-size:12px;color:#888">3 PIN Realty · write your notes and rating in the app so the office sees them.</div></div></body></html>`;
  return { subject, text, html };
}
