#!/usr/bin/env node
//
// Meta Lead Ads — full integration diagnostic.
//
// Run this before wiring the webhook, after any credential rotation, and any
// time leads stop arriving. It checks the LIVE Meta connection, the Firestore
// side, and every branch of the lead-ingest workflow (against mocks, so it
// never writes to Firestore or calls Graph for the workflow section).
//
//   node scripts/check-meta-lead-ads.js
//
// Reads credentials from the environment. Locally:
//   export META_APP_ID=... META_APP_SECRET=... META_SYSTEM_USER_TOKEN=...
//   export META_PAGE_ID=... META_VERIFY_TOKEN=... META_DEFAULT_TENANT_ID=...
//   export META_AD_ACCOUNT_ID=act_...            # optional
//   export FIREBASE_SERVICE_ACCOUNT_PATH=api/pin-realty-firebase-adminsdk-*.json
//
// Exit code is non-zero if any REQUIRED check fails. Warnings do not fail the
// run — they flag things that are expected to be incomplete before App Review.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const GRAPH = 'https://graph.facebook.com/v25.0';

let pass = 0, fail = 0, warn = 0;
const results = [];

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

function section(title) { console.log(`\n${C.b}${title}${C.x}\n${'─'.repeat(title.length)}`); }
function ok(name, detail = '') { pass++; results.push(['PASS', name]); console.log(`  ${C.g}PASS${C.x}  ${name}${detail ? C.d + '  ' + detail + C.x : ''}`); }
function bad(name, detail = '') { fail++; results.push(['FAIL', name]); console.log(`  ${C.r}FAIL${C.x}  ${name}${detail ? '\n        ' + C.r + detail + C.x : ''}`); }
function wrn(name, detail = '') { warn++; results.push(['WARN', name]); console.log(`  ${C.y}WARN${C.x}  ${name}${detail ? '\n        ' + C.y + detail + C.x : ''}`); }

async function graph(pathname, token, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: token }).toString();
  const res = await fetch(`${GRAPH}/${pathname}?${qs}`);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && !body.error, status: res.status, body };
}

// ───────────────────────────────────────────────────────────── 1. Environment

section('1. Configuration');

const ENV = {
  META_APP_ID: process.env.META_APP_ID,
  META_APP_SECRET: process.env.META_APP_SECRET,
  META_SYSTEM_USER_TOKEN: process.env.META_SYSTEM_USER_TOKEN || process.env.META_PAGE_ACCESS_TOKEN,
  META_PAGE_ID: process.env.META_PAGE_ID,
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN,
  META_DEFAULT_TENANT_ID: process.env.META_DEFAULT_TENANT_ID
};

for (const [k, v] of Object.entries(ENV)) {
  if (v) ok(`${k} is set`, k.includes('SECRET') || k.includes('TOKEN') ? `(${String(v).length} chars)` : String(v));
  else bad(`${k} is set`, 'missing — the webhook cannot work without it');
}

const TOKEN = ENV.META_SYSTEM_USER_TOKEN;
const PAGE_ID = ENV.META_PAGE_ID;
const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID || '';

if (!TOKEN || !PAGE_ID) {
  console.log(`\n${C.r}Cannot continue without a token and page id.${C.x}\n`);
  process.exit(1);
}

// ──────────────────────────────────────────────────────── 2. Token + identity

section('2. Meta credentials');

const dbg = await graph('debug_token', TOKEN, { input_token: TOKEN });
if (!dbg.ok) {
  bad('token is valid', JSON.stringify(dbg.body.error || dbg.body));
} else {
  const d = dbg.body.data || {};
  d.is_valid ? ok('token is valid') : bad('token is valid', 'Meta reports is_valid=false');

  d.expires_at === 0
    ? ok('token never expires', 'expires_at=0')
    : wrn('token never expires', `expires_at=${d.expires_at} — it will silently stop working; regenerate as a System User token with expiry Never`);

  d.type === 'SYSTEM_USER'
    ? ok('token is a System User token', d.type)
    : wrn('token is a System User token', `type=${d.type} — a Page/User token expires and breaks intake`);

  if (ENV.META_APP_ID && String(d.app_id) !== String(ENV.META_APP_ID)) {
    bad('token belongs to META_APP_ID',
        `token app_id=${d.app_id} but META_APP_ID=${ENV.META_APP_ID}. Meta signs webhooks with the SENDING app's secret, so signature checks will fail.`);
  } else {
    ok('token belongs to META_APP_ID', `app_id=${d.app_id} (${d.application || ''})`);
  }

  const REQUIRED = ['leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'pages_manage_ads', 'ads_management'];
  const scopes = d.scopes || [];
  const missing = REQUIRED.filter((s) => !scopes.includes(s));
  missing.length === 0
    ? ok('all six Lead Ads scopes present')
    : bad('all six Lead Ads scopes present', 'missing: ' + missing.join(', '));

  const extras = scopes.filter((s) => !REQUIRED.includes(s) && s !== 'public_profile');
  if (extras.length) wrn('extra scopes on the token', extras.join(', ') + ' — each one is more to justify at App Review');
}

// ──────────────────────────────────────────────────────────── 3. Page access

section('3. Page and Instagram');

let pageToken = null;
const page = await graph(PAGE_ID, TOKEN, { fields: 'name,access_token,instagram_business_account,connected_instagram_account' });
if (!page.ok) {
  bad('Page is reachable with this token', JSON.stringify(page.body.error || page.body));
} else {
  ok('Page is reachable', page.body.name || PAGE_ID);
  pageToken = page.body.access_token || null;

  pageToken
    ? ok('Page access token derivable from the System User token', `${pageToken.length} chars`)
    : bad('Page access token derivable', 'no access_token returned — assign the Page to the System User with Full control');

  const ig = page.body.instagram_business_account || page.body.connected_instagram_account;
  ig
    ? ok('Instagram account linked to this Page', `id=${ig.id}`)
    : wrn('Instagram account linked to this Page',
          'none found — Instagram lead ads arrive through THIS Page\'s leadgen webhook, so unlinked IG leads never reach the CRM');
}

// ───────────────────────────────────────────────── 4. Webhook subscription

section('4. Webhook subscription (Phase 6)');

if (pageToken) {
  const subs = await graph(`${PAGE_ID}/subscribed_apps`, pageToken);
  if (!subs.ok) {
    wrn('Page subscribed_apps readable', JSON.stringify(subs.body.error || subs.body));
  } else {
    const apps = subs.body.data || [];
    const mine = apps.find((a) => String(a.id) === String(ENV.META_APP_ID));
    if (!mine) {
      wrn('this app is subscribed to the Page',
          `not subscribed yet — run  POST /${PAGE_ID}/subscribed_apps?subscribed_fields=leadgen`);
    } else {
      const fields = mine.subscribed_fields || [];
      fields.includes('leadgen')
        ? ok('app subscribed to the Page for leadgen', fields.join(', '))
        : bad('app subscribed for leadgen', `subscribed but fields are: ${fields.join(', ') || '(none)'} — leadgen is missing`);
    }
  }
} else {
  wrn('webhook subscription check skipped', 'no Page token');
}

// ─────────────────────────────────────────────────────── 5. Forms + Leads Access

section('5. Lead forms and Leads Access');

let forms = [];
if (pageToken) {
  const f = await graph(`${PAGE_ID}/leadgen_forms`, pageToken, { fields: 'id,name,status,questions', limit: '50' });
  if (!f.ok) {
    bad('lead forms readable', JSON.stringify(f.body.error || f.body));
  } else {
    forms = (f.body.data || []).filter((x) => x.status === 'ACTIVE');
    forms.length ? ok('active lead forms found', `${forms.length} active`) : wrn('active lead forms found', 'none active');

    // The CRM REQUIRES propertyInterest. Flag forms that cannot supply it.
    for (const form of forms) {
      const keys = (form.questions || []).map((q) => String(q.key || '').toLowerCase());
      const hasProperty = keys.some((k) => /propert|project|which_plot|location_interested/.test(k));
      const hasCity = keys.includes('city');
      if (hasProperty) ok(`form "${form.name}" supplies a property`, 'explicit question');
      else if (hasCity) wrn(`form "${form.name}" has no property question`, 'will fall back to the city field');
      else wrn(`form "${form.name}" has no property or city`, 'leads will land with an empty Property/Locality until FORM_PROPERTY_MAP is filled');
    }

    // THE silent-failure check. Leads Access not granted => 200 OK with empty
    // data, which looks identical to "no leads yet".
    if (forms.length) {
      const probe = await graph(`${forms[0].id}/leads`, pageToken, { limit: '1' });
      if (!probe.ok) {
        const msg = JSON.stringify(probe.body.error || probe.body);
        /permission|access/i.test(msg)
          ? bad('Leads Access granted', 'Business settings → Integrations → Leads access. ' + msg)
          : bad('lead retrieval works', msg);
      } else {
        const n = (probe.body.data || []).length;
        n > 0
          ? ok('lead retrieval works', 'read a real lead successfully')
          : wrn('lead retrieval returned no rows', 'either no leads in the last 90 days on this form, or Leads Access is not granted — submit a test lead to tell these apart');
      }
    }
  }
}

// ───────────────────────────────────────────────────────────── 6. Ad account

section('6. Ad account');

if (AD_ACCOUNT) {
  const acct = await graph(AD_ACCOUNT.startsWith('act_') ? AD_ACCOUNT : `act_${AD_ACCOUNT}`, TOKEN, { fields: 'name,account_status,currency' });
  acct.ok
    ? ok('ad account reachable', `${acct.body.name} · status=${acct.body.account_status} · ${acct.body.currency}`)
    : wrn('ad account reachable', JSON.stringify(acct.body.error || acct.body) + ' — campaign attribution on leads may be blank');
} else {
  wrn('ad account check skipped', 'set META_AD_ACCOUNT_ID to include it');
}

// ───────────────────────────────────────────────────────────── 7. Firestore

section('7. Firestore');

const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON && saPath && fs.existsSync(saPath)) {
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = fs.readFileSync(saPath, 'utf8');
}

let db = null;
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  wrn('Firestore checks skipped', 'set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH');
} else {
  try {
    const shared = await import(pathToFileURL(path.join(process.cwd(), 'api', '_bot-shared.js')).href);
    db = shared.getDb();
    ok('Firestore Admin SDK initialised');
  } catch (e) {
    bad('Firestore Admin SDK initialised', String(e.message || e));
  }
}

if (db) {
  const tenant = ENV.META_DEFAULT_TENANT_ID || 't_3pinrealty';
  try {
    const p = await db.collection('pipelines').doc(tenant).get();
    if (p.exists && (p.data().stages || []).length) {
      const stages = p.data().stages;
      ok(`pipeline exists for ${tenant}`, `first stage: "${stages[0].name}" (${stages[0].id})`);
      const names = stages.map((s) => String(s.name).toLowerCase().replace(/\s+/g, ''));
      names.includes('closed')
        ? ok('a stage is named exactly "Closed"', 'conversion metrics will count')
        : wrn('no stage named exactly "Closed"', `stages: ${stages.map((s) => s.name).join(', ')} — Analytics conversion reads 0% until one is renamed to Closed`);
    } else {
      bad(`pipeline exists for ${tenant}`, 'missing — new leads would fall back to stageId "new"');
    }
  } catch (e) { bad('pipeline readable', String(e.message || e)); }

  try {
    const wp = await db.collection('waPages').doc(String(PAGE_ID)).get();
    wp.exists && wp.data().tenantId
      ? ok(`waPages/${PAGE_ID} routes to a tenant`, wp.data().tenantId)
      : wrn(`waPages/${PAGE_ID} routing row`, `not seeded — the webhook will fall back to META_DEFAULT_TENANT_ID (${ENV.META_DEFAULT_TENANT_ID || 'unset'})`);
  } catch (e) { wrn('waPages readable', String(e.message || e)); }

  try {
    const leads = await db.collection('leads').where('tenantId', '==', tenant).get();
    ok('leads collection readable', `${leads.size} leads for ${tenant}`);
    const metaLeads = leads.docs.filter((d) => d.data().source === 'meta').length;
    console.log(`        ${C.d}${metaLeads} currently sourced from meta${C.x}`);
  } catch (e) { bad('leads collection readable', String(e.message || e)); }
}

// ─────────────────────────────────────────────────── 8. Workflow (mocked)

section('8. Ingest workflow — every branch (mocked, no writes)');

const wh = await import(pathToFileURL(path.join(process.cwd(), 'api', 'meta-webhook.js')).href);

function mockDb({ tenantId = 't_3pinrealty', existingLeads = [] } = {}) {
  const written = { leads: {}, history: [], notes: [] };
  const makeRef = (id) => ({
    id,
    set: async (data) => { written.leads[id] = { ...(written.leads[id] || {}), ...data }; },
    collection: (sub) => ({ doc: (did) => ({ set: async (d) => written[sub].push({ leadId: id, ...d }) }) })
  });
  return {
    written,
    collection: (name) => ({
      doc: (id) => ({
        get: async () => {
          if (name === 'waPages') return { exists: !!tenantId, data: () => ({ tenantId }) };
          if (name === 'pipelines') return { exists: true, data: () => ({ stages: [{ id: 'new', name: 'New' }] }) };
          return { exists: false, data: () => ({}) };
        },
        ...makeRef(id)
      }),
      where: () => ({
        get: async () => ({
          docs: existingLeads.map((l) => ({ id: l.id, data: () => l, ref: makeRef(l.id) }))
        })
      })
    })
  };
}

// Stub Graph so workflow tests never touch the network.
const realFetch = globalThis.fetch;
function stubGraph(lead) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('fields=access_token')) return new Response(JSON.stringify({ access_token: 'PAGE_TOKEN_STUB' }), { status: 200 });
    return new Response(JSON.stringify(lead), { status: 200 });
  };
}
process.env.META_PAGE_ACCESS_TOKEN = 'PAGE_TOKEN_STUB';

const baseLead = (over = {}) => ({
  id: '9001', created_time: '2026-08-29T06:00:00+0000',
  form_id: '1636362728110123', ad_id: 'AD1', ad_name: 'Plots Aug',
  campaign_id: 'C1', campaign_name: 'August Plots', platform: 'facebook', is_organic: false,
  field_data: [
    { name: 'full_name', values: ['Ravi Kumar'] },
    { name: 'phone_number', values: ['+919876543210'] },
    { name: 'email', values: ['ravi@example.com'] },
    { name: 'what_is_your_approximate_budget?', values: ['₹25–35 Lakhs'] },
    { name: 'what_size_of_plot_are_you_looking_for?', values: ['1,200–1,500 sq.ft'] },
    { name: 'when_are_you_planning_to_purchase?', values: ['Immediately'] },
    { name: 'city', values: ['Adyar'] }
  ],
  ...over
});

async function run(name, { lead, db: d = mockDb(), value = {} }, assert) {
  stubGraph(lead);
  try {
    const res = await wh.processLeadgenEvent(d, { leadgen_id: '9001', page_id: PAGE_ID, ...value });
    const problem = assert(res, d.written);
    problem ? bad(name, problem) : ok(name);
  } catch (e) {
    const problem = assert(null, d.written, e);
    problem ? bad(name, problem) : ok(name);
  }
}

await run('new lead is created with the full CRM shape', { lead: baseLead() }, (res, w) => {
  const l = w.leads['meta_9001'];
  if (!l) return 'no lead written';
  if (l.tenantId !== 't_3pinrealty') return `tenantId=${l.tenantId} — lead would be invisible on the board`;
  if (l.name !== 'Ravi Kumar') return `name=${l.name}`;
  if (l.phone !== '+919876543210') return `phone=${l.phone}`;
  if (l.source !== 'meta') return `source=${l.source}`;
  if (l.stageId !== 'new') return `stageId=${l.stageId}`;
  if (l.enquiryType !== 'Property Enquiry') return `enquiryType=${l.enquiryType}`;
  if (l.budget !== '25 to 35 L') return `budget=${l.budget}`;
  return null;
});

await run('property is campaign - adset - form', { lead: baseLead() }, (res, w) =>
  /^August Plots/.test(w.leads['meta_9001'].propertyInterest || '') ? null : `got "${w.leads['meta_9001'].propertyInterest}"`);

await run('an explicit property question wins over city', {
  lead: baseLead({ field_data: [...baseLead().field_data, { name: 'which_property_are_you_interested_in?', values: ['Green Meadows'] }] })
}, (res, w) => w.leads['meta_9001'].propertyInterest === 'Green Meadows' ? null : `got "${w.leads['meta_9001'].propertyInterest}"`);

await run('facebook platform maps to the facebook channel', { lead: baseLead({ platform: 'facebook' }) },
  (res, w) => w.leads['meta_9001'].channel === 'facebook' ? null : `got ${w.leads['meta_9001'].channel}`);

await run('instagram platform maps to the instagram channel', { lead: baseLead({ platform: 'instagram' }) },
  (res, w) => w.leads['meta_9001'].channel === 'instagram' ? null : `got ${w.leads['meta_9001'].channel}`);

await run('a "created" history event is logged', { lead: baseLead() },
  (res, w) => w.history.some((h) => h.type === 'created') ? null : 'no created event');

await run('intake note captures plot size, timeline and campaign', { lead: baseLead() }, (res, w) => {
  const n = w.notes[0];
  if (!n) return 'no note written';
  for (const frag of ['Plot size', 'Timeline', 'Campaign'])
    if (!n.text.includes(frag)) return `note missing ${frag}: "${n.text}"`;
  return null;
});

await run('note metadata is denormalised onto the lead', { lead: baseLead() },
  (res, w) => w.leads['meta_9001'].noteCount === 1 && w.leads['meta_9001'].lastNote ? null : 'noteCount/lastNote not set');

await run('repeat enquirer merges instead of duplicating', {
  lead: baseLead(),
  db: mockDb({ existingLeads: [{ id: 'lead_123', phone: '98765 43210', tenantId: 't_3pinrealty', name: 'Ravi K', email: '', budget: '' }] })
}, (res, w) => {
  if (!res || !res.merged) return `expected a merge, got ${JSON.stringify(res)}`;
  if (w.leads['meta_9001']) return 'created a duplicate lead as well';
  if (w.leads['lead_123'].email !== 'ravi@example.com') return 'did not backfill the blank email';
  return null;
});

await run('merge does not overwrite a value the team already set', {
  lead: baseLead(),
  db: mockDb({ existingLeads: [{ id: 'lead_123', phone: '+919876543210', tenantId: 't_3pinrealty', budget: '1 Cr', email: 'set@x.com' }] })
}, (res, w) => {
  const l = w.leads['lead_123'];
  if (l.budget) return `overwrote budget with "${l.budget}"`;
  if (l.email) return `overwrote email with "${l.email}"`;
  return null;
});

await run('missing name degrades rather than failing', {
  lead: baseLead({ field_data: [{ name: 'phone_number', values: ['+919999999999'] }] })
}, (res, w) => w.leads['meta_9001'].name === 'Meta Lead' ? null : `got "${w.leads['meta_9001'].name}"`);

await run('first_name + last_name are joined when full_name is absent', {
  lead: baseLead({ field_data: [{ name: 'first_name', values: ['Ravi'] }, { name: 'last_name', values: ['Kumar'] }, { name: 'phone_number', values: ['+91999'] }] })
}, (res, w) => w.leads['meta_9001'].name === 'Ravi Kumar' ? null : `got "${w.leads['meta_9001'].name}"`);

await run('campaign attribution is stored on the lead', { lead: baseLead() }, (res, w) => {
  const l = w.leads['meta_9001'];
  return l.campaignName === 'August Plots' && l.adId === 'AD1' && l.rawFieldData ? null : 'attribution fields missing';
});

// Both the routing row AND the env fallback must be absent for this to be a
// real test of the refusal path — clear the fallback BEFORE the call, not in
// the assertion, which runs afterwards.
const savedTenantFallback = process.env.META_DEFAULT_TENANT_ID;
delete process.env.META_DEFAULT_TENANT_ID;
await run('an unmapped page is REFUSED, never written tenant-less', {
  lead: baseLead(),
  db: mockDb({ tenantId: null })
}, (res, w, err) => {
  if (Object.keys(w.leads).length) return 'wrote a lead with no tenant — it would be invisible on every board';
  return err ? null : 'expected a refusal, got ' + JSON.stringify(res);
});
if (savedTenantFallback) process.env.META_DEFAULT_TENANT_ID = savedTenantFallback;

await run('the env fallback covers an unseeded routing row', {
  lead: baseLead(), db: mockDb({ tenantId: null })
}, (res, w) => w.leads['meta_9001'] && w.leads['meta_9001'].tenantId === 't_3pinrealty'
    ? null : 'fallback tenant not applied');

await run('an event with no leadgen_id is skipped quietly', { lead: baseLead(), value: { leadgen_id: null } },
  (res, w) => Object.keys(w.leads).length === 0 ? null : 'wrote something for an empty event');

globalThis.fetch = realFetch;

// ───────────────────────────────────────────────────────────────── Summary

console.log(`\n${'═'.repeat(60)}`);
console.log(`${C.g}${pass} passed${C.x}   ${warn ? C.y : C.d}${warn} warnings${C.x}   ${fail ? C.r : C.d}${fail} failed${C.x}`);
if (warn) {
  console.log(`\n${C.y}Warnings${C.x} are things to finish before go-live, not bugs:`);
  results.filter((r) => r[0] === 'WARN').forEach((r) => console.log(`  · ${r[1]}`));
}
if (fail) {
  console.log(`\n${C.r}Failures${C.x} block the integration:`);
  results.filter((r) => r[0] === 'FAIL').forEach((r) => console.log(`  · ${r[1]}`));
}
console.log('');
process.exit(fail ? 1 : 0);
