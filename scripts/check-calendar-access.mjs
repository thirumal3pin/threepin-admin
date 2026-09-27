// Can this CRM read the team's Google Calendars yet?
//
//   node scripts/check-calendar-access.mjs [person@threepin.in ...]
//
// threepin.in is a Google Workspace domain (its MX is smtp.google.com), which
// means the calendars can be read WITHOUT asking each agent to link anything:
// the service account this project already uses for Firestore can be granted
// permission, once, to act on behalf of people in the domain. Nobody signs in
// to anything, no refresh tokens are stored, and there is nothing to re-link
// when somebody changes their password.
//
// That permission is not on yet. Three steps turn it on, all in consoles the
// owner controls, and this script says which one is still missing rather than
// making you guess from a raw Google error.
//
//   1. Google Cloud console -> project "pin-realty" -> APIs & Services ->
//      Library -> enable "Google Calendar API".
//
//   2. Google Workspace Admin (admin.google.com, signed in as a super admin)
//      -> Security -> Access and data control -> API controls ->
//      Manage Domain Wide Delegation -> Add new:
//         Client ID : 118007570407573886710
//         Scopes    : https://www.googleapis.com/auth/calendar.readonly
//      (That client ID is the service account's numeric id. It identifies, it
//      does not authenticate — the private key stays where it is.)
//
//   3. Wait a few minutes. Google propagates delegation slowly, and a refusal
//      in the first minute or two means nothing.
//
// Read-only is deliberate here. Widen the scope to .../auth/calendar only if
// the CRM is going to WRITE site visits into agents' calendars — that is a
// separate decision, and a bigger one, because a bug then writes to real
// people's diaries rather than merely reading them.

import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';

const KEY_PATH = 'api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const TEAM = process.argv.slice(2).length ? process.argv.slice(2)
  : ['sales@threepin.in', 'admin@threepin.in', 'swami@threepin.in', 'pradeep@threepin.in', 'thirumal@threepin.in'];

const key = JSON.parse(readFileSync(KEY_PATH, 'utf8'));
console.log(`service account : ${key.client_email}`);
console.log(`client id       : ${key.client_id}`);
console.log(`scope           : ${SCOPE}`);
console.log('');

// ── Step one: can the service account become one of these people at all? ──
const who = TEAM[0];
const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE], subject: who });
try {
  await jwt.authorize();
  console.log(`delegation      : ON (acting as ${who})`);
} catch (e) {
  const d = (e.response && e.response.data) || {};
  const err = d.error || e.message || '';
  const desc = d.error_description || '';
  console.log(`delegation      : REFUSED for ${who}`);
  console.log(`  ${err}${desc ? ' — ' + desc : ''}`);
  console.log('');
  if (/unauthorized_client/i.test(err) || /not authorized/i.test(desc)) {
    console.log('  That is step 2: the client id above is not listed in Domain Wide');
    console.log('  Delegation, or it is listed without this exact scope. Scopes are');
    console.log('  matched as whole strings — a trailing space or the wrong one of');
    console.log('  calendar / calendar.readonly counts as absent.');
  } else if (/invalid_grant/i.test(err)) {
    console.log(`  Google took the delegation but not the person: is ${who} a real,`);
    console.log('  active mailbox in this Workspace? An alias or a deleted account');
    console.log('  fails exactly here.');
  } else if (/access_denied/i.test(err)) {
    console.log('  Delegation is present but the admin policy is blocking it.');
  } else {
    console.log('  Unfamiliar refusal — worth reading Google\'s wording above closely.');
  }
  process.exit(1);
}

// ── Step two: is the Calendar API itself switched on for the project? ──
const now = new Date();
const end = new Date(now.getTime() + 24 * 3600000);
const res = await jwt.request({
  url: 'https://www.googleapis.com/calendar/v3/freeBusy',
  method: 'POST',
  data: { timeMin: now.toISOString(), timeMax: end.toISOString(), timeZone: 'Asia/Kolkata', items: TEAM.map(id => ({ id })) }
}).catch(e => ({ failed: e }));

if (res.failed) {
  const d = (res.failed.response && res.failed.response.data) || {};
  const msg = (d.error && (d.error.message || d.error)) || res.failed.message;
  console.log(`calendar api    : FAILED — ${String(msg).slice(0, 200)}`);
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(String(msg))) {
    console.log('');
    console.log('  That is step 1: the Google Calendar API is not enabled on the');
    console.log('  pin-realty project. Enabling it takes a minute and costs nothing.');
  }
  process.exit(1);
}

console.log('calendar api    : ON');
console.log('');
console.log(`Busy time in the next 24 hours (IST), ${TEAM.length} calendars:`);
const cals = res.data.calendars || {};
let reachable = 0;
for (const who of TEAM) {
  const c = cals[who];
  if (!c) { console.log(`  ${who.padEnd(26)} no answer`); continue; }
  if (c.errors && c.errors.length) {
    // notFound here almost always means "that mailbox has not shared its
    // calendar with the domain", which delegation does NOT override.
    console.log(`  ${who.padEnd(26)} ${c.errors.map(e => e.reason).join(', ')}`);
    continue;
  }
  reachable++;
  const busy = c.busy || [];
  const t = ms => new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
  console.log(`  ${who.padEnd(26)} ${busy.length ? busy.map(b => t(b.start) + '-' + t(b.end)).join(', ') : 'clear'}`);
}
console.log('');
console.log(reachable === TEAM.length
  ? `All ${TEAM.length} calendars are readable. The CRM can show this.`
  : `${reachable} of ${TEAM.length} readable — the rest are listed above with Google's reason.`);
