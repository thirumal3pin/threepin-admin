// The agent layer, phase 1: the agent settings model (shared-assets/agent-config.js), the menu's
// role tags (shared-assets/appnav.js) and the server's checks (api/_agent.js, api/_bot-shared.js).
//   node tests/agent-layer.test.mjs
// The database rules have their own suite, run against the emulator: tests/rules (npm test there).
import { readFileSync } from 'node:fs';
import * as AC from '../shared-assets/agent-config.js';

let failed = 0, passed = 0;
const ok = (label, cond, detail) => { if (cond) passed++; else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : '')); } };
console.log('3 PIN Realty — Agent layer\n');

// ── Defaults = the brief and the owner's answers of 14 Nov ──
const d = AC.effectiveConfig(null, 'rameez@threepin.in');
ok('menu: Properties, CRM, Tasks, Meta Ads, Campaigns', d.tabs.join() === 'properties,crm,tasks,ads,campaigns', d.tabs.join());
ok('other properties: a richer summary with no street — title, BHK, budget, type, locality, availability, primary agent',
  d.otherPropertyFields.join() === 'title,config,budget,type,locality,availability,primaryAgent', d.otherPropertyFields.join());
ok('…and never the street, the owner, office notes or the sheet’s extra columns', !['address', 'contact', 'internal', 'sheet'].some(f => d.otherPropertyFields.includes(f)));
ok('assigned properties (primary or co-agent): everything, owner included', d.ownPropertyFields.includes('contact') && d.ownPropertyFields.length === AC.PROPERTY_FIELDS.length);
ok('approved requests: everything but the owner (the approver decides that)', !d.grantedPropertyFields.includes('contact') && d.grantedPropertyFields.length === AC.PROPERTY_FIELDS.length - 1);
ok('matching leads: what they want and the AI summary, no phone', d.matchingLeadFields.join() === 'requirement,aiSummary');
ok('ads and campaigns: their properties only', d.adsScope === 'own' && d.campaignsScope === 'own');
ok('actions: add leads, edit own notes/availability, submit properties, export theirs, send campaigns — all on', AC.ACTIONS.every(a => d.actions[a.id] === true) && AC.ACTIONS.length === 5);
ok('approvals: the primary agent or an admin; no time limit; owner’s number off; 24 hours offered',
  d.approvals.approvers === 'primary' && d.approvals.detailsDays === null && d.approvals.shareContact === false && d.approvals.contactHours === 24);
ok('the defaults are not shared objects (editing one result cannot change the next)', (() => { d.tabs.push('x'); d.actions.addLeads = false; const e = AC.effectiveConfig(null); return e.tabs.length === 5 && e.actions.addLeads; })());
ok('only the menu changes anything yet; the rest is marked for a later update', AC.LIVE.tabs === true && !AC.LIVE.fields && !AC.LIVE.actions && !AC.LIVE.approvals);
ok('tabs that are not built for agents cannot be given', AC.TABS.filter(t => t.status !== 'ready').every(t => !AC.normalizeConfig({ tabs: [t.id] }).tabs.length));

// ── Cleaning ──
const n = AC.normalizeConfig({
  tabs: ['crm', 'finance', 'bogus', 'crm', 'properties'],
  otherPropertyFields: ['budget', 'title', 'nope'],
  grantedPropertyFields: ['title', 'contact'],
  adsScope: 'everything',
  actions: { addLeads: false, sendCampaigns: 'yes', hack: true },
  approvals: { approvers: 'anyone', detailsDays: 5, contactHours: 2, shareContact: 'yes' },
  overrides: { 'Rameez@ThreePin.in': { tabs: ['crm'], junk: 1 }, 'not-an-email': { tabs: [] } },
  evil: true,
}, 't_3pinrealty');
ok('tabs: known and ready only, catalogue order, no repeats', n.tabs.join() === 'properties,crm', n.tabs.join());
ok('fields: known only, catalogue order', n.otherPropertyFields.join() === 'title,budget', n.otherPropertyFields.join());
ok('the owner’s number can never be a standing part of approved access', n.grantedPropertyFields.join() === 'title');
ok('a bad scope keeps the default', n.adsScope === 'own');
ok('actions: booleans only; unknown ones dropped', n.actions.addLeads === false && n.actions.sendCampaigns === true && !('hack' in n.actions));
ok('approvals: an unknown approver keeps the default; a bad timer too; a good one is kept', n.approvals.approvers === 'primary' && n.approvals.detailsDays === null && n.approvals.contactHours === 2);
ok('a non-boolean switch keeps the default', n.approvals.shareContact === false);
ok('unknown keys are dropped', !('evil' in n));
ok('tenant stamped', n.tenantId === 't_3pinrealty');
ok('override keys lower-cased; junk and bad emails dropped', JSON.stringify(n.overrides) === JSON.stringify({ 'rameez@threepin.in': { tabs: ['crm'] } }), JSON.stringify(n.overrides));
ok('the written keys are exactly what firestore.rules allows', (() => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const allowed = [...rules.match(/match \/agentConfigs[\s\S]*?hasOnly\(\[([\s\S]*?)\]\)/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  return Object.keys(n).every(k => allowed.includes(k)) && allowed.includes('actions');
})());

// ── Settings saved by the first version keep their meaning ──
const old = AC.effectiveConfig({ otherPropertyFields: ['title', 'area', 'status', 'agents'], approvals: { agentsApprove: false } });
ok('old field ids are translated (area → locality, status → availability + possession, agents → both names)',
  old.otherPropertyFields.join() === 'title,locality,availability,primaryAgent,possession,coAgents', old.otherPropertyFields.join());
ok('old “agents approve: no” becomes admins only', old.approvals.approvers === 'admins');
ok('old “agents approve: yes” becomes any agent on the property', AC.effectiveConfig({ approvals: { agentsApprove: true } }).approvals.approvers === 'all');

// ── Per-agent override ──
const stored = { tabs: ['properties', 'crm', 'tasks'], overrides: { 'rameez@threepin.in': { tabs: ['properties'], adsScope: 'all', actions: { exportOwn: false } } } };
ok('an agent’s override wins, setting by setting', AC.effectiveConfig(stored, 'RAMEEZ@threepin.in').tabs.join() === 'properties' && AC.effectiveConfig(stored, 'rameez@threepin.in').adsScope === 'all');
ok('an override of one action leaves the others as they were', (() => { const c = AC.effectiveConfig(stored, 'rameez@threepin.in'); return c.actions.exportOwn === false && c.actions.addLeads === true; })());
ok('other agents get the common settings', AC.effectiveConfig(stored, 'new@threepin.in').tabs.join() === 'properties,crm,tasks');
ok('settings not in the override come from the common ones', AC.effectiveConfig(stored, 'rameez@threepin.in').otherPropertyFields.length === 7);

// ── Copying a property for an agent ──
const prop = {
  id: 'ADRM0002', name: '3 BHK near Ramesh 98400 12345, Anna Nagar', config: '3 BHK', startingPrice: '1.2 Cr', zone: 'Anna Nagar',
  location: '12, 6th Avenue', contactName: 'Owner', contactNumber: '9000000000', geo: { lat: 1, lng: 2 }, assignedAgent: 'rameez@threepin.in',
  detailsText: 'Call +91 98765-43210 or 044 2345 6789 for a visit', sheetNotes: 'owner mob 9123456789',
  sheetExtras: { Owner_Builder_Contact: 'Owner 9000000000', Landlord: 'Mr X', WhatsApp: '9999911111', Mob: '9888877777', Facing_Road: '40 ft', Caretaker_note: 'ring 9876501234' },
};
const summaryCopy = AC.projectProperty(prop, d.otherPropertyFields);
ok('summary copy: id and the summary fields only', JSON.stringify(Object.keys(summaryCopy).sort()) === JSON.stringify(['assignedAgent', 'config', 'id', 'name', 'startingPrice', 'zone']), Object.keys(summaryCopy).join());
ok('a phone number typed into the title is masked', !/98400/.test(summaryCopy.name) && /•/.test(summaryCopy.name), summaryCopy.name);
const full = AC.projectProperty(prop, AC.DEFAULTS.ownPropertyFields);
ok('assigned copy carries the owner, the address and the numbers as typed', full.contactNumber === '9000000000' && full.location === '12, 6th Avenue' && /98765-43210/.test(full.detailsText));
const granted = AC.projectProperty(prop, AC.DEFAULTS.grantedPropertyFields);
ok('approved copy: no owner, and numbers in the share text and notes masked (mobile with +91, landline)',
  !('contactNumber' in granted) && !/98765|2345 6789/.test(granted.detailsText) && !/9123456789/.test(granted.sheetNotes), granted.detailsText + ' | ' + granted.sheetNotes);
ok('approved copy: contact-looking sheet columns dropped (owner, landlord, WhatsApp, Mob); numbers in the rest masked',
  granted.sheetExtras && !['Owner_Builder_Contact', 'Landlord', 'WhatsApp', 'Mob'].some(k => k in granted.sheetExtras)
  && granted.sheetExtras.Facing_Road === '40 ft' && !/9876501234/.test(granted.sheetExtras.Caretaker_note), JSON.stringify(granted.sheetExtras));
ok('prices and sizes are not mistaken for phone numbers', AC.maskPhones('1.2 Cr · 1450 sq.ft · UDS 650 · plot 2400') === '1.2 Cr · 1450 sq.ft · UDS 650 · plot 2400');
ok('a copy is a copy (changing it leaves the property alone)', (() => { full.geo.lat = 9; return prop.geo.lat === 1; })());
ok('subcollections follow their groups', AC.propertySubs(['notes', 'internal']).join() === 'notes,internalNotes' && AC.propertySubs(['title']).length === 0);

// ── The menu: every section is tagged, so an agent never sees an untagged one by accident ──
const nav = readFileSync(new URL('../shared-assets/appnav.js', import.meta.url), 'utf8');
const mapSrc = nav.match(/var MAP = \[([\s\S]*?)\n  \];/)[1];
const sections = [...mapSrc.matchAll(/\n    \{\n      (?:\/\/[^\n]*\n      )?id: '([^']+)'[^\n]*/g)].map(m => ({ id: m[1], line: m[0] }));
ok('the menu lists its sections', sections.length >= 9, sections.map(s => s.id).join());
const tabIds = AC.TABS.map(t => t.id);
for (const s of sections) {
  const tab = (s.line.match(/tab: '([^']+)'/) || [])[1];
  const adminOnly = /adminOnly: true/.test(mapSrc.slice(mapSrc.indexOf("id: '" + s.id + "'"), mapSrc.indexOf("id: '" + s.id + "'") + 400));
  ok(`menu section "${s.id}" names an agent tab, is admin-only, or is hidden from agents on purpose`,
    (tab && tabIds.includes(tab)) || adminOnly || s.id === 'brochure', s.line);
}
ok('Team & access is admin-only and goes to team.html', /id: 'team'[\s\S]{0,200}adminOnly: true/.test(mapSrc) && /team: \{ href: 'team.html'/.test(nav));
ok('setup screens stay with the full-access team (staffOnly)', ['missing', 'changes', 'sync', 'ml-setup', 'cmp-templates', 'cmp-new'].every(id => new RegExp("id: '" + id + "'[^\\n]*staffOnly: true").test(nav)));
ok('the menu starts from the device’s last known role (no flash of the full menu)', /pin\.access\.last/.test(nav));
ok('a deep link to a view an agent may not see is ignored', /navAllowed\(value\)/.test(nav));
for (const [file, c] of [['crm.html', 'crm'], ['dashboard.html', 'property'], ['property.html', 'property'], ['propertytrack.html', 'track'], ['3pinfinance.html', 'finance'], ['team.html', 'team']]) {
  const html = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  ok(`${file} says which console it is and loads access.js`, new RegExp('<html[^>]*data-console="' + c + '"').test(html) && /shared-assets\/access\.js/.test(html));
}

// ── Server ──
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}';
const A = await import('../api/_agent.js');
ok('admin = admin role + confirmed email + a tenant', A.isAdminToken({ tenantId: 't', role: 'admin', email_verified: true }));
ok('not admin without a confirmed email', !A.isAdminToken({ tenantId: 't', role: 'admin', email_verified: false }));
ok('not admin as an agent or as full access', !A.isAdminToken({ tenantId: 't', role: 'agent', email_verified: true }) && !A.isAdminToken({ tenantId: 't', email_verified: true }));
const U = (uid, role, { disabled = false, verified = true } = {}) => ({ uid, disabled, emailVerified: verified, customClaims: { tenantId: 't', ...(role ? { role } : {}) } });
ok('last-admin guard: demoting the only admin is refused', A.leavesNoAdmin([U('a', 'admin'), U('b')], 'a', { role: 'none' }));
ok('last-admin guard: turning the only admin off is refused', A.leavesNoAdmin([U('a', 'admin'), U('b')], 'a', { active: false }));
ok('last-admin guard: fine while another enabled, confirmed admin remains', !A.leavesNoAdmin([U('a', 'admin'), U('b', 'admin')], 'a', { role: 'agent' }));
ok('last-admin guard: an admin who is off or unconfirmed does not count', A.leavesNoAdmin([U('a', 'admin'), U('b', 'admin', { disabled: true }), U('c', 'admin', { verified: false })], 'a', { role: 'none' }));
ok('WhatsApp numbers: a 10-digit mobile gets 91; spaces and a leading 0 are fine; junk refused; blank allowed',
  A.cleanPhone('98400 12345') === '919840012345' && A.cleanPhone('098400-12345') === '919840012345' && A.cleanPhone('+91 98400 12345') === '919840012345' && A.cleanPhone('123') === null && A.cleanPhone('') === '');
const agentSrc = readFileSync(new URL('../api/_agent.js', import.meta.url), 'utf8');
ok('add-user refuses someone already on the team (no way around the role guard rails)', /Already on the team/.test(agentSrc));
ok('add-user replaces the password of an account that signed itself up', /hasPassword[\s\S]{0,200}patch\.password = password/.test(agentSrc));
ok('admin actions check the token against the live account', /checkRevoked: isAdminAction/.test(agentSrc));
ok('approve: only agent or full access, never straight to admin', /role !== 'agent' && role !== 'none'/.test(agentSrc));
ok('approve: a password the sign-up chose is replaced with a one-time one', /async function approve[\s\S]{0,1400}password = newPassword\(\)/.test(agentSrc));
ok('sign-ups (the whole project’s) are handled only by the home tenant’s admins', /user\.tenantId !== HOME_TENANT \? \[\]/.test(agentSrc) && (agentSrc.match(/user\.tenantId !== HOME_TENANT\) return json/g) || []).length === 2);
ok('an admin cannot reset another admin’s password', /roleOf\(target\) === 'admin'\) return json\(\{ error: 'Admins reset their own password/.test(agentSrc));
ok('names come from what an admin set, not the account’s own display name', /name: nameOf\[u\.uid\] \|\| ''/.test(agentSrc));
const shared = readFileSync(new URL('../api/_bot-shared.js', import.meta.url), 'utf8');
ok('every endpoint lets in full access only, unless it opts in to agents; unknown roles never',
  /if \(role !== '' && role !== 'admin' && !\(role === 'agent' && allowAgent\)\) return null/.test(shared));
const digest = readFileSync(new URL('../api/followup-digest.js', import.meta.url), 'utf8');
ok('agents can still send the email for a change to their own task', /verifyCrmUser\(request, \{ allowAgent: isTask \}\)/.test(digest));
ok('…at most one of each kind per task every 10 minutes (managers excepted), and who was emailed is not echoed', /!isMgr && Date\.now\(\) - lastAt < 10 \* 60 \* 1000/.test(digest) && !/sent, results \}/.test(digest));
const acc = readFileSync(new URL('../shared-assets/access.js', import.meta.url), 'utf8');
ok('the agent wipe is marked done only once it worked, retried next session, reset when no longer an agent', /if \(await forgetLocalCopy\(\)\) \{ try \{ localStorage\.setItem\(WIPED/.test(acc) && /role !== 'agent'\) \{ try \{ localStorage\.removeItem\(WIPED\)/.test(acc));
ok('the wipe also clears data copies kept in localStorage', /pinProp:\|pinCal:\|pinTodayOpens:\|easy/.test(acc));
const rulesSrc = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
ok('rules: what agents may use is open to known roles only (an undefined role gets nothing)', /function isKnownRole\(\)/.test(rulesSrc) && !/allow (read|create|update|delete)[^;]*: if hasTenant\(\)/.test(rulesSrc));

console.log(failed ? `\n${failed} failed, ${passed} passed.` : `\nAll good (${passed} checks).`);
process.exit(failed ? 1 : 0);
