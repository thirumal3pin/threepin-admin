// ═══════ THE AGENT LAYER — server side ═══════
//
//   POST /api/agent   (vercel.json rewrites it to bot-test-message?op=agent: the Hobby plan allows
//                     12 functions and all 12 are taken)
//   body { action, ... }, Authorization: Bearer <Firebase ID token>
//
// Actions
//   me          anyone on the team (agents included): { role, email, config } — config is the agent
//               settings that apply to the caller (shared-assets/agent-config.js), sent to agents only
//   team        admin: every login on the tenant with its role, whether it is enabled and on the
//               team list, and when it last signed in
//   set-role    admin: { uid, role: 'admin' | 'agent' | 'none' }
//   set-active  admin: { uid, active } — disable or re-enable a login
//   add-user    admin: { email, role, teamList } — a new login (or an existing account attached),
//               returns a one-time password when it created one
//   team-list   admin: { email, on } — on/off the team list (mentions, calendar, site visits)
//
// Roles are custom claims, so only this file and scripts/set-roles.mjs can change them; the rules
// (firestore.rules, "Who is asking") read them. Claims are MERGED, never replaced: the tenantId
// claim that every login needs must survive a role change. Every change is written to accessLog.
//
// Guard rails: an admin cannot change their own role or disable themselves, and the last admin
// cannot be demoted or disabled — so the tenant can never be left with nobody to run it.
import { randomBytes } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb, verifyCrmUser } from './_bot-shared.js';
import { effectiveConfig } from '../shared-assets/agent-config.js';
import { teamKey } from '../crm-assets/mentions.js';

const ROLES = ['admin', 'agent', 'none'];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const isEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''));

export function isAdminToken(u) {
  return !!(u && u.tenantId && u.role === 'admin' && u.email_verified === true);
}

// Every login on this tenant. listUsers pages through the whole project (a handful of accounts).
async function tenantUsers(tenantId) {
  const auth = getAuth();
  const out = [];
  let token;
  do {
    const page = await auth.listUsers(1000, token);
    for (const u of page.users) if ((u.customClaims || {}).tenantId === tenantId) out.push(u);
    token = page.pageToken;
  } while (token);
  return out;
}

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

// Refuse anything that would leave the tenant without an enabled admin.
function leavesNoAdmin(users, uid, nextRole, nextActive) {
  return !users.some(u => {
    const role = u.uid === uid ? nextRole : roleOf(u);
    const active = u.uid === uid ? nextActive : !u.disabled;
    return role === 'admin' && active;
  });
}

async function me(user) {
  const role = user.role || 'none';
  const out = { role, email: user.email || '' };
  if (role === 'agent') {
    const snap = await getDb().collection('agentConfigs').doc(user.tenantId).get();
    out.config = effectiveConfig(snap.exists ? snap.data() : null, user.email);
  }
  return json(out);
}

async function team(user) {
  const db = getDb();
  const [users, listed] = await Promise.all([tenantUsers(user.tenantId), teamListEmails(db, user.tenantId)]);
  const rows = users.map(u => ({
    uid: u.uid,
    email: u.email || '',
    name: u.displayName || '',
    role: roleOf(u),
    active: !u.disabled,
    teamList: listed.has(String(u.email || '').toLowerCase()),
    lastLogin: u.metadata.lastSignInTime ? Date.parse(u.metadata.lastSignInTime) : null,
    created: u.metadata.creationTime ? Date.parse(u.metadata.creationTime) : null,
    self: u.uid === user.uid,
  })).sort((a, b) => a.email.localeCompare(b.email));
  // Team-list entries with no login yet (shared mailboxes like sales@).
  const withLogin = new Set(rows.map(r => r.email.toLowerCase()));
  const listOnly = [...listed].filter(e => !withLogin.has(e)).sort();
  return json({ users: rows, listOnly });
}

async function setRole(user, body) {
  const { uid, role } = body || {};
  if (!uid || !ROLES.includes(role)) return json({ error: 'Pick a role: admin, agent or none' }, 400);
  if (uid === user.uid) return json({ error: 'You cannot change your own role' }, 400);
  const users = await tenantUsers(user.tenantId);
  const target = users.find(u => u.uid === uid);
  if (!target) return json({ error: 'No such login on this team' }, 404);
  if (leavesNoAdmin(users, uid, role, !target.disabled)) return json({ error: 'That would leave the team with no admin' }, 400);
  const from = roleOf(target);
  await setClaims(uid, { role: role === 'none' ? null : role });
  const db = getDb();
  await db.collection('users').doc(uid).set({
    tenantId: user.tenantId, email: target.email || '', access: role,
    accessSetBy: user.email || user.uid, accessSetAt: Date.now(),
  }, { merge: true });
  // Taking power away should not wait for their token to expire: signing them out everywhere makes
  // their next page load ask for a fresh sign-in, which carries the new role. (A token already in a
  // browser stays valid for up to an hour for the database; the pages re-check the role on load.)
  if (from === 'admin' || role === 'agent') await getAuth().revokeRefreshTokens(uid);
  await log(db, user.tenantId, user, { action: 'set-role', uid, email: target.email || '', from, to: role });
  return json({ ok: true, uid, role });
}

async function setActive(user, body) {
  const { uid } = body || {};
  const active = !!(body && body.active);
  if (!uid) return json({ error: 'Missing uid' }, 400);
  if (uid === user.uid && !active) return json({ error: 'You cannot disable your own login' }, 400);
  const users = await tenantUsers(user.tenantId);
  const target = users.find(u => u.uid === uid);
  if (!target) return json({ error: 'No such login on this team' }, 404);
  if (!active && leavesNoAdmin(users, uid, roleOf(target), false)) return json({ error: 'That would leave the team with no admin' }, 400);
  await getAuth().updateUser(uid, { disabled: !active });
  if (!active) await getAuth().revokeRefreshTokens(uid);
  await log(getDb(), user.tenantId, user, { action: active ? 'enable' : 'disable', uid, email: target.email || '' });
  return json({ ok: true, uid, active });
}

async function setTeamList(db, tenantId, email, on) {
  const key = teamKey(email);
  await db.collection('settings').doc(tenantId).set(
    { team: { [key]: on ? { email: email.toLowerCase() } : FieldValue.delete() } }, { merge: true });
}

async function addUser(user, body) {
  const email = String((body && body.email) || '').trim().toLowerCase();
  const role = (body && body.role) || 'none';
  if (!isEmail(email)) return json({ error: 'Enter an email address' }, 400);
  if (!ROLES.includes(role)) return json({ error: 'Pick a role: admin, agent or none' }, 400);
  const auth = getAuth();
  let rec, password = null, created = false;
  try {
    rec = await auth.getUserByEmail(email);
    const t = (rec.customClaims || {}).tenantId;
    if (t && t !== user.tenantId) return json({ error: 'That email belongs to another business' }, 400);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    password = randomBytes(9).toString('base64url');
    rec = await auth.createUser({ email, password, emailVerified: true });
    created = true;
  }
  // Confirmed, as scripts/add-team-member.js does: a first "Continue with Google" then ADDS Google
  // to the account instead of replacing the password.
  if (!rec.emailVerified) rec = await auth.updateUser(rec.uid, { emailVerified: true });
  await setClaims(rec.uid, { tenantId: user.tenantId, role: role === 'none' ? null : role });
  const db = getDb();
  await db.collection('users').doc(rec.uid).set({
    tenantId: user.tenantId, email, access: role, role: 'member',
    accessSetBy: user.email || user.uid, accessSetAt: Date.now(), createdAt: Date.now(),
  }, { merge: true });
  if (body && body.teamList) await setTeamList(db, user.tenantId, email, true);
  await log(db, user.tenantId, user, { action: created ? 'add-user' : 'attach-user', uid: rec.uid, email, to: role });
  return json({ ok: true, uid: rec.uid, email, role, created, password });
}

async function teamList(user, body) {
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!isEmail(email)) return json({ error: 'Enter an email address' }, 400);
  const on = !!(body && body.on);
  const db = getDb();
  await setTeamList(db, user.tenantId, email, on);
  await log(db, user.tenantId, user, { action: on ? 'team-list-add' : 'team-list-remove', email });
  return json({ ok: true, email, on });
}

const ADMIN_ACTIONS = { team, 'set-role': setRole, 'set-active': setActive, 'add-user': addUser, 'team-list': teamList };

export async function agentPost(request) {
  const user = await verifyCrmUser(request, { allowAgent: true });
  if (!user || !user.tenantId) return json({ error: 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const action = body && body.action;
  try {
    if (action === 'me') return await me(user);
    const fn = ADMIN_ACTIONS[action];
    if (!fn) return json({ error: 'Unknown action' }, 400);
    if (!isAdminToken(user)) return json({ error: 'Admins only' }, 403);
    return await fn(user, body);
  } catch (e) {
    console.error('agent action failed:', action, e);
    return json({ error: 'Something went wrong — try again' }, 500);
  }
}
