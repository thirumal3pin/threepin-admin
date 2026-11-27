// ═══════ THE AGENT LAYER — server side ═══════
//
//   POST /api/agent   (vercel.json rewrites it to bot-test-message?op=agent: the Hobby plan allows
//                     12 functions and all 12 are taken)
//   body { action, ... }, Authorization: Bearer <Firebase ID token>
//
// Actions
//   me              anyone on the team (agents included): { role, email, config, cfgAt } — config is
//                   the caller's own effective agent settings (shared-assets/agent-config.js), sent to
//                   agents only; agents never read agentConfigs directly (it holds everyone's overrides)
//   team            admin: every login on the tenant (role, active, team list, name, WhatsApp, last
//                   sign-in) and the accounts waiting for approval (signed up, no tenant yet)
//   set-role        admin: { uid, role: 'admin' | 'agent' | 'none' }
//   set-active      admin: { uid, active: true | false }
//   set-profile     admin: { uid, name, phone } — the name everyone sees, the WhatsApp number
//   reset-password  admin: { uid } — a new one-time password; signs them out everywhere
//   add-user        admin: { email, role, name, phone, teamList } — a NEW person. Someone already on the
//                   team is refused (change them from their row); an account that signed itself up
//                   gets a fresh password, so nobody who pre-registered an address can keep it
//   approve         admin of the home tenant: { uid, role, teamList } — let in an account waiting for
//                   approval, as agent or full access (never straight to admin). A Google sign-in is
//                   kept; a password the account chose itself is replaced with a one-time one the admin
//                   sends to the person, since nothing proves who registered the address
//   dismiss         admin of the home tenant: { uid } — delete an account waiting for approval
//   team-list       admin: { email, on } — on/off the team lists (mentions, calendar, site visits)
//
// Roles are custom claims, so only this file and scripts/set-roles.mjs can change them; the rules
// (firestore.rules, "Who is asking") read them. Claims are MERGED, never replaced: the tenantId
// claim that every login needs must survive a role change. Every change is written to accessLog.
//
// Guard rails: an admin cannot change their own role, disable or reset themselves; nothing may leave
// the tenant without an enabled, confirmed admin. Admin actions check the caller's token against the
// live account (checkRevoked), so an admin who was demoted, disabled or signed out everywhere loses
// these powers at once — not when their token runs out an hour later.
import { randomBytes } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb, verifyCrmUser } from './_bot-shared.js';
import { effectiveConfig } from '../shared-assets/agent-config.js';
import { teamKey } from '../crm-assets/mentions.js';
import { workPost, isWorkAction, isAdminWork } from './_agent-work.js';
import { hasAssignedAdLeads } from './_meta-leads.js';
import { relabel, usageFromPage, usageRead } from './_usage.js';

const ROLES = ['admin', 'agent', 'none'];
// Accounts that signed themselves up belong to no tenant, so they are the whole Firebase project's,
// not one business's. Only the admins of the business that owns the project see, let in or remove
// them (today the only tenant).
const HOME_TENANT = process.env.HOME_TENANT_ID || 't_3pinrealty';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const isEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''));
const newPassword = () => randomBytes(9).toString('base64url');

export function isAdminToken(u) {
  return !!(u && u.tenantId && u.role === 'admin' && u.email_verified === true);
}

// A WhatsApp number as stored: digits only, India's 91 added to a bare 10-digit mobile. '' = none.
export function cleanPhone(s) {
  const d = String(s || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return '';
  if (d.length === 10 && /^[6-9]/.test(d)) return '91' + d;
  return d.length >= 11 && d.length <= 13 ? d : null;
}
const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);

async function allUsers() {
  const auth = getAuth();
  const out = [];
  let token;
  do {
    const page = await auth.listUsers(1000, token);
    out.push(...page.users);
    token = page.pageToken;
  } while (token);
  return out;
}
const tenantOf = u => (u.customClaims || {}).tenantId || null;
const roleOf = u => (u.customClaims || {}).role || 'none';

async function log(db, tenantId, by, what) {
  await db.collection('accessLog').add({ tenantId, by: by.email || by.uid, at: Date.now(), ...what });
}

async function teamListEmails(db, tenantId) {
  const s = await db.collection('settings').doc(tenantId).get();
  const team = (s.exists && s.data().team) || {};
  return new Set(Object.values(team).map(m => String((m && m.email) || '').toLowerCase()).filter(Boolean));
}

async function setClaims(uid, patch) {
  const auth = getAuth();
  const u = await auth.getUser(uid);
  const claims = { ...(u.customClaims || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete claims[k]; else claims[k] = v;
  }
  await auth.setCustomUserClaims(uid, claims);
  return claims;
}

// Refuse anything that would leave the tenant without an enabled admin whose email is confirmed
// (an unconfirmed "admin" cannot act: the rules and isAdminToken both require it).
export function leavesNoAdmin(users, uid, next) {
  return !users.some(u => {
    const n = u.uid === uid ? next : {};
    const role = n.role !== undefined ? n.role : roleOf(u);
    const active = n.active !== undefined ? n.active : !u.disabled;
    return role === 'admin' && active && u.emailVerified;
  });
}

async function me(user) {
  const role = user.role || 'none';
  const out = { role, email: user.email || '' };
  if (role === 'agent') {
    const db = getDb();
    const [snap, adLeads] = await Promise.all([db.collection('agentConfigs').doc(user.tenantId).get(), hasAssignedAdLeads(db, user.tenantId, user.email)]);
    const stored = snap.exists ? snap.data() : null;
    out.config = effectiveConfig(stored, user.email);
    // An admin gave them an ad lead: Meta Ads Leads is in their menu, showing only their leads
    // (api/_meta-leads.js reads only the rows assigned to them unless they also have the Ads tab).
    if (adLeads && !out.config.tabs.includes('ads')) out.config = { ...out.config, tabs: [...out.config.tabs, 'ads'], adsScope: 'assigned' };
    out.cfgAt = (stored && stored.updatedAt) || 0;
  }
  return json(out);
}

async function team(user) {
  const db = getDb();
  const [users, listed] = await Promise.all([allUsers(), teamListEmails(db, user.tenantId)]);
  const mine = users.filter(u => tenantOf(u) === user.tenantId);
  const profiles = mine.length ? await db.getAll(...mine.map(u => db.collection('users').doc(u.uid))) : [];
  // Name and number as an admin set them (users/{uid}); the account's own displayName is only a
  // fallback — anyone can change their own, so it must never be how an admin recognises them.
  const phoneOf = {}, nameOf = {};
  profiles.forEach(d => { if (d.exists) { phoneOf[d.id] = d.data().phone || ''; nameOf[d.id] = d.data().name || ''; } });
  const rows = mine.map(u => ({
    uid: u.uid,
    email: u.email || '',
    name: nameOf[u.uid] || '',
    phone: phoneOf[u.uid] || '',
    role: roleOf(u),
    active: !u.disabled,
    verified: !!u.emailVerified,
    teamList: listed.has(String(u.email || '').toLowerCase()),
    lastLogin: u.metadata.lastSignInTime ? Date.parse(u.metadata.lastSignInTime) : null,
    created: u.metadata.creationTime ? Date.parse(u.metadata.creationTime) : null,
    self: u.uid === user.uid,
  })).sort((a, b) => a.email.localeCompare(b.email));
  // Accounts that signed themselves up (the sign-in page allows it) and belong to nobody yet: they
  // see nothing until an admin lets them in here.
  const pending = user.tenantId !== HOME_TENANT ? [] : users.filter(u => !tenantOf(u) && u.email).map(u => ({
    uid: u.uid,
    email: u.email,
    nameGiven: u.displayName || '',      // chosen by whoever signed up: shown as such, never trusted
    via: (u.providerData || []).map(p => p.providerId === 'google.com' ? 'Google' : p.providerId === 'password' ? 'password' : p.providerId),
    verified: !!u.emailVerified,
    created: u.metadata.creationTime ? Date.parse(u.metadata.creationTime) : null,
  })).sort((a, b) => (b.created || 0) - (a.created || 0));
  const withLogin = new Set(rows.map(r => r.email.toLowerCase()));
  const listOnly = [...listed].filter(e => !withLogin.has(e)).sort();
  return json({ users: rows, pending, listOnly });
}

// The target, checked to be a login on the caller's tenant.
async function teammate(user, uid) {
  if (!uid) return { error: json({ error: 'Missing person' }, 400) };
  const users = (await allUsers()).filter(u => tenantOf(u) === user.tenantId);
  const target = users.find(u => u.uid === uid);
  if (!target) return { error: json({ error: 'No such login on this team' }, 404) };
  return { users, target };
}

async function setRole(user, body) {
  const { uid, role } = body || {};
  if (!ROLES.includes(role)) return json({ error: 'Pick a role: admin, agent or full access' }, 400);
  if (uid === user.uid) return json({ error: 'You cannot change your own role' }, 400);
  const { error, users, target } = await teammate(user, uid);
  if (error) return error;
  if (leavesNoAdmin(users, uid, { role })) return json({ error: 'That would leave the team with no admin' }, 400);
  const from = roleOf(target);
  if (from === role) return json({ ok: true, uid, role, unchanged: true });
  if (role === 'admin' && !target.emailVerified) await getAuth().updateUser(uid, { emailVerified: true });
  await setClaims(uid, { role: role === 'none' ? null : role });
  const db = getDb();
  // An agent is always on the team lists: a site visit is booked in the diary of someone on them,
  // and only people on them can be picked as a lead's or a property's agent.
  if (role === 'agent' && target.email) await setTeamList(db, user.tenantId, target.email, true);
  await db.collection('users').doc(uid).set({
    tenantId: user.tenantId, email: target.email || '', access: role,
    accessSetBy: user.email || user.uid, accessSetAt: Date.now(),
  }, { merge: true });
  // Taking power away: signed out everywhere, so their next page load asks for a fresh sign-in that
  // carries the new role. (The database honours an issued token for up to an hour; the server's
  // admin actions do not — see checkRevoked above.)
  if (from === 'admin' || role === 'agent') await getAuth().revokeRefreshTokens(uid);
  await log(db, user.tenantId, user, { action: 'set-role', uid, email: target.email || '', from, to: role });
  return json({ ok: true, uid, role });
}

async function setActive(user, body) {
  const uid = body && body.uid;
  if (!body || typeof body.active !== 'boolean') return json({ error: 'Say whether the account is active' }, 400);
  const active = body.active;
  if (uid === user.uid && !active) return json({ error: 'You cannot turn off your own account' }, 400);
  const { error, users, target } = await teammate(user, uid);
  if (error) return error;
  if (!active && leavesNoAdmin(users, uid, { active: false })) return json({ error: 'That would leave the team with no admin' }, 400);
  await getAuth().updateUser(uid, { disabled: !active });
  if (!active) await getAuth().revokeRefreshTokens(uid);
  await log(getDb(), user.tenantId, user, { action: active ? 'enable' : 'disable', uid, email: target.email || '' });
  return json({ ok: true, uid, active });
}

async function setProfile(user, body) {
  const { error, target } = await teammate(user, body && body.uid);
  if (error) return error;
  const name = cleanName(body.name);
  const phone = cleanPhone(body.phone);
  if (phone === null) return json({ error: 'Enter a 10-digit mobile number' }, 400);
  await getAuth().updateUser(target.uid, { displayName: name || null });
  await getDb().collection('users').doc(target.uid).set({ name, phone }, { merge: true });
  await log(getDb(), user.tenantId, user, { action: 'set-profile', uid: target.uid, email: target.email || '' });
  return json({ ok: true, uid: target.uid, name, phone });
}

async function resetPassword(user, body) {
  const uid = body && body.uid;
  if (uid === user.uid) return json({ error: 'Sign in with “Continue with Google” — no password needed' }, 400);
  const { error, target } = await teammate(user, uid);
  if (error) return error;
  // One admin may not take over another's account. Admins are threepin.in Google Workspace accounts:
  // a forgotten password does not matter, "Continue with Google" signs them in.
  if (roleOf(target) === 'admin') return json({ error: 'Admins sign in with “Continue with Google” — no password reset needed' }, 403);
  const hadPassword = (target.providerData || []).some(p => p.providerId === 'password');
  const password = newPassword();
  await getAuth().updateUser(uid, { password, emailVerified: true });
  await getAuth().revokeRefreshTokens(uid);
  await log(getDb(), user.tenantId, user, { action: hadPassword ? 'reset-password' : 'password-login-added', uid, email: target.email || '' });
  return json({ ok: true, uid, email: target.email || '', password });
}

async function setTeamList(db, tenantId, email, on) {
  const key = teamKey(email);
  await db.collection('settings').doc(tenantId).set(
    { team: { [key]: on ? { email: email.toLowerCase() } : FieldValue.delete() } }, { merge: true });
}

async function attach(user, rec, { role, name, phone, teamList, action }) {
  await setClaims(rec.uid, { tenantId: user.tenantId, role: role === 'none' ? null : role });
  const db = getDb();
  const ref = db.collection('users').doc(rec.uid);
  const had = await ref.get();
  await ref.set({
    tenantId: user.tenantId, email: rec.email, access: role, name, phone,
    ...(had.exists && had.data().role ? {} : { role: 'member' }),
    accessSetBy: user.email || user.uid, accessSetAt: Date.now(),
    ...(had.exists ? {} : { createdAt: Date.now() }),
  }, { merge: true });
  if (teamList || role === 'agent') await setTeamList(db, user.tenantId, rec.email, true);
  await log(db, user.tenantId, user, { action, uid: rec.uid, email: rec.email, to: role });
}

async function addUser(user, body) {
  const email = String((body && body.email) || '').trim().toLowerCase();
  const role = (body && body.role) || 'none';
  const name = cleanName(body && body.name);
  const phone = cleanPhone(body && body.phone);
  if (!isEmail(email)) return json({ error: 'Enter an email address' }, 400);
  if (!ROLES.includes(role)) return json({ error: 'Pick a role: admin, agent or full access' }, 400);
  if (phone === null) return json({ error: 'Enter a 10-digit mobile number' }, 400);
  const auth = getAuth();
  let rec = null;
  try { rec = await auth.getUserByEmail(email); } catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
  if (rec) {
    const t = tenantOf(rec);
    if (t && t !== user.tenantId) return json({ error: 'That email belongs to another business' }, 400);
    if (t === user.tenantId) return json({ error: 'Already on the team — change their role from their row in People' }, 409);
  }
  let password = null;
  if (!rec) {
    password = newPassword();
    rec = await auth.createUser({ email, password, emailVerified: true, displayName: name || undefined });
  } else {
    // An account that signed itself up with this address. Whoever chose its password may not be
    // the person being added, so the password is replaced and every session ended. A Google sign-in
    // proves the address belongs to its holder and is left as it is.
    const hasPassword = (rec.providerData || []).some(p => p.providerId === 'password');
    const patch = { emailVerified: true, disabled: false };
    if (name) patch.displayName = name;
    if (hasPassword || !(rec.providerData || []).length) { password = newPassword(); patch.password = password; }
    rec = await auth.updateUser(rec.uid, patch);
    await auth.revokeRefreshTokens(rec.uid);
  }
  await attach(user, rec, { role, name, phone, teamList: !!(body && body.teamList), action: 'add-user' });
  return json({ ok: true, uid: rec.uid, email, role, name, phone, password });
}

// Let in an account that signed itself up, keeping the sign-in it chose: the admin is vouching for
// this person (team.html says so before they press Approve).
async function approve(user, body) {
  if (user.tenantId !== HOME_TENANT) return json({ error: 'Admins only' }, 403);
  const { uid } = body || {};
  const role = (body && body.role) || 'agent';
  if (role !== 'agent' && role !== 'none') return json({ error: 'Let them in as an agent or full access; make them an admin afterwards if needed' }, 400);
  let rec;
  try { rec = await getAuth().getUser(uid); } catch (e) { return json({ error: 'That request is gone' }, 404); }
  if (tenantOf(rec)) return json({ error: 'Already let in' }, 409);
  // Google proves the address belongs to whoever signed in. A password chosen at sign-up proves
  // nothing — it may be someone else's who registered this address first — so it is replaced with a
  // one-time password the admin sends to the person, and every session is ended.
  const google = (rec.providerData || []).some(p => p.providerId === 'google.com');
  const hasPassword = (rec.providerData || []).some(p => p.providerId === 'password');
  let password = null;
  if (hasPassword || !google) {
    password = newPassword();
    rec = await getAuth().updateUser(uid, { password, emailVerified: true });
    await getAuth().revokeRefreshTokens(uid);
  }
  await attach(user, rec, { role, name: '', phone: '', teamList: !!(body && body.teamList), action: 'approve' });
  return json({ ok: true, uid, email: rec.email, role, password });
}

async function dismiss(user, body) {
  if (user.tenantId !== HOME_TENANT) return json({ error: 'Admins only' }, 403);
  const { uid } = body || {};
  let rec;
  try { rec = await getAuth().getUser(uid); } catch (e) { return json({ ok: true, uid, gone: true }); }
  if (tenantOf(rec)) return json({ error: 'That person is on a team; turn their account off instead' }, 409);
  await getAuth().deleteUser(uid);
  await log(getDb(), user.tenantId, user, { action: 'dismiss', uid, email: rec.email || '' });
  return json({ ok: true, uid });
}

async function teamList(user, body) {
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!isEmail(email)) return json({ error: 'Enter an email address' }, 400);
  const on = body.on === true;
  const db = getDb();
  await setTeamList(db, user.tenantId, email, on);
  await log(db, user.tenantId, user, { action: on ? 'team-list-add' : 'team-list-remove', email });
  return json({ ok: true, email, on });
}

const ADMIN_ACTIONS = {
  team, 'set-role': setRole, 'set-active': setActive, 'set-profile': setProfile, 'reset-password': resetPassword,
  'add-user': addUser, approve, dismiss, 'team-list': teamList,
};

export async function agentPost(request) {
  let body;
  try { body = await request.clone().json(); } catch { return json({ error: 'Bad request' }, 400); }
  const action = body && body.action;
  const isAdminAction = Object.prototype.hasOwnProperty.call(ADMIN_ACTIONS, action) || isAdminWork(action);
  // Admin actions re-check the token against the live account: revoked or disabled = refused now.
  // So does every decision on a request and every change to a grant (an approver demoted or switched
  // off must not decide, extend or take back).
  const user = await verifyCrmUser(request, { allowAgent: true, checkRevoked: isAdminAction || ['decide', 'decide-many', 'revoke', 'hide-contact', 'grant-extend'].includes(action) });
  if (!user || !user.tenantId) return json({ error: 'Unauthorized' }, 401);
  try {
    relabel('agent:' + action);
    if (action === 'me') return await me(user);
    // The database usage log (api/_usage.js): a page's own counts, and the admins' view of them.
    if (action === 'usage-log') return json(await usageFromPage(getDb(), user, body));
    if (action === 'usage-read') { if (!isAdminToken(user)) return json({ error: 'Admins only' }, 403); return json(await usageRead(getDb(), user, body)); }
    // Phases 2–6: properties, leads, requests, messages (api/_agent-work.js).
    if (isWorkAction(action)) return await workPost(user, action, body, isAdminToken(user));
    if (!isAdminAction) return json({ error: 'Unknown action' }, 400);
    if (!isAdminToken(user)) return json({ error: 'Admins only' }, 403);
    return await ADMIN_ACTIONS[action](user, body);
  } catch (e) {
    console.error('agent action failed:', action, e);
    return json({ error: 'Something went wrong — try again' }, 500);
  }
}
