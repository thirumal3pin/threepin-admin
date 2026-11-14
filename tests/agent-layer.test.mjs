// The agent layer, phase 1: the agent settings model (shared-assets/agent-config.js), the menu's
// role tags (shared-assets/appnav.js) and the server's admin check (api/_agent.js).
//   node tests/agent-layer.test.mjs
// The database rules have their own suite, run against the emulator: tests/rules (npm test there).
import { readFileSync } from 'node:fs';
import * as AC from '../shared-assets/agent-config.js';

let failed = 0, passed = 0;
const ok = (label, cond, detail) => { if (cond) passed++; else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : '')); } };
console.log('3 PIN Realty — Agent layer\n');

// ── Defaults = the brief ──
const d = AC.effectiveConfig(null, 'rameez@threepin.in');
ok('no saved settings: the brief’s defaults', d.tabs.join() === 'properties,crm,tasks,ads,campaigns', d.tabs.join());
ok('other properties show title, config and budget only', d.otherPropertyFields.join() === 'title,config,budget');
ok('own properties show everything, owner contact included', d.ownPropertyFields.includes('contact') && d.ownPropertyFields.length === AC.PROPERTY_FIELDS.length);
ok('approved requests show everything but the owner contact', !d.grantedPropertyFields.includes('contact') && d.grantedPropertyFields.length === AC.PROPERTY_FIELDS.length - 1);
ok('matching leads: requirement and AI summary, no phone', d.matchingLeadFields.join() === 'requirement,aiSummary');
ok('ads and campaigns: only their properties', d.adsScope === 'own' && d.campaignsScope === 'own');
ok('approvals: no time limit, contact off, 24 hours offered', d.approvals.detailsDays === null && d.approvals.shareContact === false && d.approvals.contactHours === 24);
ok('the defaults are not shared objects (editing one result cannot change the next)', (() => { d.tabs.push('x'); return AC.effectiveConfig(null).tabs.length === 5; })());

// ── Cleaning ──
const n = AC.normalizeConfig({
  tabs: ['crm', 'finance', 'bogus', 'crm', 'properties'],
  otherPropertyFields: ['budget', 'title', 'nope'],
  adsScope: 'everything',
  approvals: { detailsDays: 5, contactHours: 2, shareContact: 'yes' },
  overrides: { 'Rameez@ThreePin.in': { tabs: ['crm'], junk: 1 }, 'not-an-email': { tabs: [] } },
  evil: true,
}, 't_3pinrealty');
ok('tabs: known and ready only, catalogue order, no repeats (finance is not ready for agents)', n.tabs.join() === 'properties,crm', n.tabs.join());
ok('fields: known only, catalogue order', n.otherPropertyFields.join() === 'title,budget', n.otherPropertyFields.join());
ok('a bad scope keeps the default', n.adsScope === 'own');
ok('a timer outside the choices keeps the default; a good one is kept', n.approvals.detailsDays === null && n.approvals.contactHours === 2);
ok('a non-boolean switch keeps the default', n.approvals.shareContact === false);
ok('unknown keys are dropped', !('evil' in n));
ok('tenant stamped', n.tenantId === 't_3pinrealty');
ok('override keys lower-cased; junk and bad emails dropped', JSON.stringify(n.overrides) === JSON.stringify({ 'rameez@threepin.in': { tabs: ['crm'] } }), JSON.stringify(n.overrides));
ok('the written keys are exactly what firestore.rules allows', (() => {
  const allowed = ['tenantId', 'tabs', 'otherPropertyFields', 'ownPropertyFields', 'grantedPropertyFields', 'matchingLeadFields', 'adsScope', 'campaignsScope', 'approvals', 'overrides', 'updatedAt', 'updatedBy'];
  return Object.keys(n).every(k => allowed.includes(k));
})());

// ── Per-agent override ──
const stored = { tabs: ['properties', 'crm', 'tasks'], overrides: { 'rameez@threepin.in': { tabs: ['properties'], adsScope: 'all' } } };
ok('an agent’s override wins, setting by setting', AC.effectiveConfig(stored, 'RAMEEZ@threepin.in').tabs.join() === 'properties' && AC.effectiveConfig(stored, 'rameez@threepin.in').adsScope === 'all');
ok('other agents get the shared settings', AC.effectiveConfig(stored, 'new@threepin.in').tabs.join() === 'properties,crm,tasks');
ok('settings not in the override come from the shared ones', AC.effectiveConfig(stored, 'rameez@threepin.in').otherPropertyFields.join() === 'title,config,budget');

// ── Copying a property for an agent ──
const prop = {
  id: 'ADRM0002', name: '3 BHK, Anna Nagar', config: '3 BHK', startingPrice: '1.2 Cr', location: '12, 6th Avenue',
  contactName: 'Owner', contactNumber: '9000000000', geo: { lat: 1, lng: 2 },
  sheetExtras: { Owner_Builder_Contact: 'Owner 9000000000', Facing_Road: '40 ft' },
};
const locked = AC.projectProperty(prop, ['title', 'config', 'budget']);
ok('locked copy: id + the three fields, nothing else', JSON.stringify(Object.keys(locked).sort()) === JSON.stringify(['config', 'id', 'name', 'startingPrice']), Object.keys(locked).join());
const full = AC.projectProperty(prop, d.ownPropertyFields);
ok('own copy carries the owner contact and the address', full.contactNumber === '9000000000' && full.location === '12, 6th Avenue');
const noContact = AC.projectProperty(prop, ['title', 'sheet']);
ok('other sheet columns never smuggle the owner contact out', noContact.sheetExtras && !('Owner_Builder_Contact' in noContact.sheetExtras) && noContact.sheetExtras.Facing_Road === '40 ft', JSON.stringify(noContact.sheetExtras));
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
ok('setup screens stay with the team (staffOnly)', ['missing', 'changes', 'sync', 'ml-setup', 'cmp-templates', 'cmp-new'].every(id => new RegExp("id: '" + id + "'[^\\n]*staffOnly: true").test(nav)));

// ── Server ──
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}';
const { isAdminToken } = await import('../api/_agent.js');
ok('admin = admin role + confirmed email + a tenant', isAdminToken({ tenantId: 't', role: 'admin', email_verified: true }));
ok('not admin without a confirmed email', !isAdminToken({ tenantId: 't', role: 'admin', email_verified: false }));
ok('not admin as an agent or as before', !isAdminToken({ tenantId: 't', role: 'agent', email_verified: true }) && !isAdminToken({ tenantId: 't', email_verified: true }));
const shared = readFileSync(new URL('../api/_bot-shared.js', import.meta.url), 'utf8');
ok('every existing endpoint refuses agents unless it opts in', /decoded\.role === 'agent' && !allowAgent\) return null/.test(shared));

console.log(failed ? `\n${failed} failed, ${passed} passed.` : `\nAll good (${passed} checks).`);
process.exit(failed ? 1 : 0);
