import crypto from 'node:crypto';
import { getDb } from './_bot-shared.js';

// Facebook / Instagram Lead Ads intake.
//
// Meta POSTs here the moment someone submits an instant form. The payload
// carries IDENTIFIERS ONLY (leadgen_id, page_id, form_id, ad_id) — never the
// person's details — so every lead costs one authenticated Graph call to
// resolve. That is by design on Meta's side, not an inefficiency here.
//
// Replaces the pre-multi-tenant version deleted in 60c2d78, which wrote leads
// with no `tenantId` (so they never appeared on the tenant-filtered board) and
// stored notes/history as inline arrays (since migrated to subcollections).
//
// Instagram leads arrive through this SAME endpoint — there is no separate IG
// webhook. The lead object's `platform` field is what distinguishes them.
//
// See docs/META-LEAD-ADS.md for the setup and the field mapping rationale.

const GRAPH = 'https://graph.facebook.com/v25.0';

// ─────────────────────────────────────────────────────────────────────────────
// Mapping configuration — the only part that should need editing when the
// Meta lead forms change. Everything below this block is form-agnostic.
// ─────────────────────────────────────────────────────────────────────────────

// form_id → property name, for forms that do not ASK which property.
// This is the fallback when no property question exists on the form; adding a
// property question to the form itself is the better long-term answer, because
// one form can otherwise only ever mean one property.
//
//   '1636362728110123': 'Bala Nagar Plots',
const FORM_PROPERTY_MAP = {};

// Meta's `platform` → the CRM's `channel` value. Both values are rendered by
// CHANNEL_META in crm-assets/app.js — an unknown channel degrades to '—' on the
// board rather than breaking it, but keep the two in sync.
const CHANNEL_BY_PLATFORM = { instagram: 'instagram', facebook: 'facebook' };
const DEFAULT_CHANNEL = 'facebook';

const DEFAULT_ENQUIRY_TYPE = 'Property Enquiry';

// Field keys are matched case-insensitively, and a form's own key wins over
// these fallbacks. Meta's standard keys are stable; custom questions are keyed
// by a slug derived from the question text, so match those by substring.
const STANDARD = {
  fullName: ['full_name'],
  firstName: ['first_name'],
  lastName: ['last_name'],
  phone: ['phone_number'],
  email: ['email'],
  city: ['city']
};
const CONTAINS = {
  // Order matters — first match wins.
  property: ['propert', 'project', 'which_plot', 'location_interested'],
  budget: ['budget'],
  plotSize: ['size_of_plot', 'plot_size', 'sq.ft', 'sqft'],
  timeline: ['when_are_you', 'planning_to_purchase', 'timeline']
};

// ─────────────────────────────────────────────────────────────────────────────
// Signature + verification
// ─────────────────────────────────────────────────────────────────────────────

// Meta signs the RAW body. Any re-serialisation (JSON.parse → stringify) breaks
// the comparison, so the body is read once as text and parsed only afterwards.
function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// Page access token
// ─────────────────────────────────────────────────────────────────────────────

// Page-scoped endpoints (including reading a lead) reject a System User token
// outright — "(#190) This method must be called with a Page Access Token" — so
// the Page token is derived from it on demand. Cached for the lifetime of the
// warm serverless instance: a Page token minted from a non-expiring System User
// token does not itself expire, so this is a latency optimisation, not a TTL.
let _pageTokenCache = null;

async function getPageAccessToken(pageId) {
  if (_pageTokenCache && _pageTokenCache.pageId === pageId) return _pageTokenCache.token;

  // An explicitly configured Page token wins, so a deployment can pin one
  // without depending on the System User indirection at all.
  if (process.env.META_PAGE_ACCESS_TOKEN) {
    _pageTokenCache = { pageId, token: process.env.META_PAGE_ACCESS_TOKEN };
    return _pageTokenCache.token;
  }

  const sysToken = process.env.META_SYSTEM_USER_TOKEN;
  if (!sysToken) throw new Error('Neither META_PAGE_ACCESS_TOKEN nor META_SYSTEM_USER_TOKEN is set');

  const url = `${GRAPH}/${pageId}?fields=access_token&access_token=${encodeURIComponent(sysToken)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Could not derive a Page token for ${pageId}: ${res.status} ${JSON.stringify(body.error || body)}`);
  }
  _pageTokenCache = { pageId, token: body.access_token };
  return body.access_token;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchLead(leadgenId, pageId) {
  const token = await getPageAccessToken(pageId);
  const fields = [
    'id', 'created_time', 'field_data', 'form_id', 'ad_id', 'ad_name',
    'adset_id', 'adset_name', 'campaign_id', 'campaign_name',
    'is_organic', 'platform'
  ].join(',');
  const res = await fetch(`${GRAPH}/${leadgenId}?fields=${fields}&access_token=${encodeURIComponent(token)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Graph error reading lead ${leadgenId}: ${res.status} ${JSON.stringify(body.error || body)}`);
  }
  return body;
}

// ─────────────────────────────────────────────────────────────────────────────
// Field mapping
// ─────────────────────────────────────────────────────────────────────────────

function toFieldMap(fieldData) {
  const out = {};
  (fieldData || []).forEach((f) => {
    if (!f || !f.name) return;
    out[String(f.name).toLowerCase()] = (f.values && f.values[0] != null) ? String(f.values[0]) : '';
  });
  return out;
}

function pickExact(map, keys) {
  for (const k of keys) {
    const v = map[k];
    if (v) return v;
  }
  return '';
}

function pickContains(map, needles) {
  for (const needle of needles) {
    for (const key of Object.keys(map)) {
      if (key.includes(needle) && map[key]) return map[key];
    }
  }
  return '';
}

// Meta's multiple-choice budgets arrive as display strings — "₹30–50 Lakhs",
// "Below ₹25 Lakhs", "3 - 5 Crores", "₹70 Lakhs+" — with a rupee sign and an
// EN DASH. The CRM's pipeline-value parser reads "1.5 Cr", "85 L" and
// "3 to 4 Cr", so unnormalised values are silently dropped from Open Pipeline
// Value. Normalise into that dialect; the untouched original always survives in
// rawFieldData and in the lead's first note, so nothing is lost.
export function normalizeBudget(raw) {
  if (!raw) return '';
  let s = String(raw)
    .replace(/[₹,]/g, ' ')
    .replace(/[‒-―−]/g, '-')   // en/em/figure dash + minus → hyphen
    .replace(/\bLakhs?\b/gi, 'L')
    .replace(/\bLacs?\b/gi, 'L')
    .replace(/\bCrores?\b/gi, 'Cr')
    .replace(/\s+/g, ' ')
    .trim();

  // "70 L+" / "Above 5 Cr" → the stated bound. "Below 25 L" → the stated cap.
  // Using the bound rather than inventing a midpoint keeps the number
  // defensible; it is the only figure the lead actually told us.
  s = s.replace(/^\s*(above|over|more than)\s+/i, '')
       .replace(/^\s*(below|under|less than|upto|up to)\s+/i, '')
       .replace(/\+\s*$/, '');

  // "30 - 50 L" → "30 to 50 L", which the CRM averages.
  s = s.replace(/(\d)\s*-\s*(\d)/, '$1 to $2');

  return s.replace(/\s+/g, ' ').trim();
}

// Form id → form name. Populated with ONE Graph call per warm instance rather
// than one per lead: there are ~10 forms and they change rarely, so caching
// turns a per-lead cost into a per-cold-start one.
let _formNameCache = null;

async function formNames(pageId) {
  if (_formNameCache) return _formNameCache;
  try {
    const token = await getPageAccessToken(pageId);
    const res = await fetch(`${GRAPH}/${pageId}/leadgen_forms?fields=id,name&limit=100&access_token=${encodeURIComponent(token)}`);
    const body = await res.json().catch(() => ({}));
    _formNameCache = {};
    for (const f of body.data || []) _formNameCache[String(f.id)] = f.name || '';
  } catch (e) {
    // A missing form name degrades the property string; it must never drop the
    // lead, so cache the failure as empty and carry on.
    console.error('meta: could not load form names:', e);
    _formNameCache = {};
  }
  return _formNameCache;
}

// `propertyInterest` is REQUIRED by the CRM (readLeadForm in app.js) and no
// current Meta form asks for it, so it is composed from the ad hierarchy:
//
//   "<campaign name> - <ad set name> - <form name>"
//
// That makes each lead traceable back to the exact ad that produced it, and
// gives Property Performance a real dimension to group by. Parts that are
// missing (an organic lead has no campaign) are dropped rather than leaving
// empty separators.
//
// An explicit property question still wins when one exists — no current form
// has one, so this is a no-op today and simply does the right thing if one is
// added later.
function resolveProperty(map, lead, formId, formName) {
  const explicit = pickContains(map, CONTAINS.property);
  if (explicit) return explicit;

  const composite = [lead.campaign_name, lead.adset_name, formName]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' - ');
  if (composite) return composite;

  return FORM_PROPERTY_MAP[formId] || pickExact(map, STANDARD.city) || '';
}

function resolveName(map) {
  const full = pickExact(map, STANDARD.fullName);
  if (full) return full;
  const joined = [pickExact(map, STANDARD.firstName), pickExact(map, STANDARD.lastName)]
    .filter(Boolean).join(' ').trim();
  return joined || 'Meta Lead';
}

// Deliberately identical to phoneKey() in crm-assets/app.js and normPhone() in
// dashboardMetrics.js, so server-side dedupe and the client's "already exists"
// check can never disagree about what counts as the same number.
export function phoneKey(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1);
  return digits;
}

// Everything the form asked that does not map onto a first-class CRM field is
// still worth an agent's eyes, so it goes into the opening note rather than
// being buried in rawFieldData.
function buildIntakeNote(lead, map, formName) {
  const bits = [];
  if (formName) bits.push(`Form: ${formName}`);
  const size = pickContains(map, CONTAINS.plotSize);
  if (size) bits.push(`Plot size: ${size}`);
  const budgetRaw = pickContains(map, CONTAINS.budget);
  if (budgetRaw) bits.push(`Budget (as answered): ${budgetRaw}`);
  const when = pickContains(map, CONTAINS.timeline);
  if (when) bits.push(`Timeline: ${when}`);
  if (lead.campaign_name) bits.push(`Campaign: ${lead.campaign_name}`);
  if (lead.ad_name) bits.push(`Ad: ${lead.ad_name}`);
  if (lead.is_organic) bits.push('Organic (not from a paid ad)');
  return bits.join(' · ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tenant routing
// ─────────────────────────────────────────────────────────────────────────────

// waPages/{pageId} → { tenantId }. firestore.rules already reserves this
// collection as server-only; this is its first reader. Falling back to
// META_DEFAULT_TENANT_ID keeps a single-Page deployment working before the
// routing table is seeded, but a lead with NO tenant is never written — that
// was precisely the bug in the deleted version.
async function resolveTenant(db, pageId) {
  try {
    const snap = await db.collection('waPages').doc(String(pageId)).get();
    if (snap.exists && snap.data().tenantId) return snap.data().tenantId;
  } catch (e) {
    console.error('waPages lookup failed:', e);
  }
  return process.env.META_DEFAULT_TENANT_ID || null;
}

async function firstStageId(db, tenantId) {
  try {
    const snap = await db.collection('pipelines').doc(tenantId).get();
    const stages = snap.exists ? (snap.data().stages || []) : [];
    if (stages.length && stages[0].id) return stages[0].id;
  } catch (e) {
    console.error('pipeline lookup failed:', e);
  }
  return 'new';
}

// The client dedupes by phone in-memory across the whole board; the webhook has
// no such view, so it queries. Firestore cannot query on a computed key, so
// this compares normalised keys over the tenant's leads. Fine at this scale
// (hundreds), and it is what keeps a repeat enquirer from silently becoming a
// second card.
async function findLeadByPhone(db, tenantId, phone) {
  const key = phoneKey(phone);
  if (!key) return null;
  const snap = await db.collection('leads').where('tenantId', '==', tenantId).get();
  for (const doc of snap.docs) {
    if (phoneKey(doc.data().phone) === key) return doc;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lead write
// ─────────────────────────────────────────────────────────────────────────────

export async function processLeadgenEvent(db, value) {
  const leadgenId = value && value.leadgen_id;
  if (!leadgenId) return { skipped: 'no leadgen_id' };

  const pageId = value.page_id || process.env.META_PAGE_ID;
  const tenantId = await resolveTenant(db, pageId);
  if (!tenantId) {
    // Refuse rather than write an orphan. A lead with no tenant is invisible on
    // every board, which reads as "the webhook is broken" and wastes a day.
    throw new Error(`No tenant mapped for page ${pageId}. Seed waPages/${pageId} or set META_DEFAULT_TENANT_ID.`);
  }

  const lead = await fetchLead(leadgenId, pageId);
  const map = toFieldMap(lead.field_data);
  const formId = String(lead.form_id || value.form_id || '');
  const formName = (await formNames(pageId))[formId] || '';

  const name = resolveName(map);
  const phone = pickExact(map, STANDARD.phone);
  const email = pickExact(map, STANDARD.email);
  const property = resolveProperty(map, lead, formId, formName);
  const budget = normalizeBudget(pickContains(map, CONTAINS.budget));
  const channel = CHANNEL_BY_PLATFORM[String(lead.platform || '').toLowerCase()] || DEFAULT_CHANNEL;

  const now = Date.now();
  const createdAt = lead.created_time ? new Date(lead.created_time).getTime() : now;

  const metaFields = {
    leadgenId: String(leadgenId),
    formId,
    adId: lead.ad_id || value.ad_id || '',
    adName: lead.ad_name || '',
    adsetId: lead.adset_id || '',
    adsetName: lead.adset_name || '',
    campaignId: lead.campaign_id || '',
    campaignName: lead.campaign_name || '',
    platform: lead.platform || '',
    isOrganic: !!lead.is_organic,
    rawFieldData: map
  };

  // A repeat enquirer keeps ONE card. Patch what the form actually told us and
  // log it, rather than creating a duplicate the team then has to merge by hand.
  const existing = await findLeadByPhone(db, tenantId, phone);
  if (existing) {
    const prev = existing.data();
    const patch = { updatedAt: now, updatedBy: 'meta-webhook', ...metaFields };
    if (!prev.email && email) patch.email = email;
    if (!prev.budget && budget) patch.budget = budget;
    if (!prev.propertyInterest && property) patch.propertyInterest = property;

    await existing.ref.set(patch, { merge: true });

    const event = {
      id: 'h' + now + Math.random().toString(36).slice(2, 7),
      type: 'field',
      text: 'New <b>Meta Lead Ads</b> submission from this number — details merged',
      at: now,
      by: 'meta-webhook'
    };
    await existing.ref.collection('history').doc(event.id).set(event);
    return { merged: existing.id };
  }

  // The board interpolates a lead's id straight into inline handlers
  // (onclick="openDetail('<id>')" in leadCardHtml), so the id must never carry
  // a quote or angle bracket. Meta signs the payload, which makes leadgen_id
  // trusted — this is belt-and-braces, and costs nothing.
  const id = 'meta_' + String(leadgenId).replace(/[^A-Za-z0-9_-]/g, '');
  const ref = db.collection('leads').doc(id);

  const doc = {
    id,
    tenantId,
    channel,
    name,
    phone,
    email,
    enquiryType: DEFAULT_ENQUIRY_TYPE,
    propertyInterest: property,
    budget,
    source: 'meta',
    stageId: await firstStageId(db, tenantId),
    detailsSent: false,
    contactAt: createdAt,
    followUpAt: null,
    createdAt,
    updatedAt: now,
    createdBy: 'meta-webhook',
    updatedBy: 'meta-webhook',
    lastActionType: 'created',
    noteCount: 0,
    lastNote: null,
    ...metaFields
  };

  // The subcollection rules resolve the PARENT lead's tenantId, so the parent
  // must exist before its notes/history are written.
  await ref.set(doc, { merge: true });

  const created = {
    id: 'h' + now + Math.random().toString(36).slice(2, 7),
    type: 'created',
    text: 'Lead captured from <b>Meta Lead Ads</b>',
    at: now,
    by: 'meta-webhook'
  };
  await ref.collection('history').doc(created.id).set(created);

  const noteText = buildIntakeNote(lead, map, formName);
  if (noteText) {
    const note = { id: 'n' + now, text: noteText, createdAt: now, by: 'meta-webhook' };
    await ref.collection('notes').doc(note.id).set(note);
    // lastNote / noteCount are denormalised onto the parent so the board can
    // render a card preview without reading the subcollection.
    await ref.set({ noteCount: 1, lastNote: { text: note.text, createdAt: now, by: note.by }, lastActionType: 'note' }, { merge: true });
  }

  return { created: id };
}


// ─────────────────────────────────────────────────────────────────────────────
// Daily reconciliation — merged in here because the Hobby plan caps a
// deployment at 12 Serverless Functions. Keeping this as its own route cost a
// slot the project does not have, so it shares meta-webhook's route instead.
// ─────────────────────────────────────────────────────────────────────────────


// Well inside Meta's 90-day window, so a fortnight of undetected downtime is
// still fully recoverable, while a daily run stays cheap.
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;

export function cronAuthorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') || '';
  if (header === `Bearer ${secret}`) return true;
  // Vercel cron invocations carry the secret as a bearer token; allow an
  // explicit query param too so the endpoint can be triggered by hand.
  return new URL(request.url).searchParams.get('secret') === secret;
}

async function reconcilePageToken(pageId) {
  if (process.env.META_PAGE_ACCESS_TOKEN) return process.env.META_PAGE_ACCESS_TOKEN;
  const sys = process.env.META_SYSTEM_USER_TOKEN;
  if (!sys) throw new Error('META_SYSTEM_USER_TOKEN is not set');
  const res = await fetch(`${GRAPH}/${pageId}?fields=access_token&access_token=${encodeURIComponent(sys)}`);
  const body = await res.json().catch(() => ({}));
  if (!body.access_token) throw new Error(`Could not derive a Page token: ${JSON.stringify(body.error || body)}`);
  return body.access_token;
}

async function activeForms(pageId, token) {
  const res = await fetch(`${GRAPH}/${pageId}/leadgen_forms?fields=id,name,status&limit=100&access_token=${encodeURIComponent(token)}`);
  const body = await res.json().catch(() => ({}));
  if (body.error) throw new Error(`Listing forms failed: ${JSON.stringify(body.error)}`);
  return (body.data || []).filter((f) => f.status === 'ACTIVE');
}

// Walks every page of a form's leads since `sinceEpoch`, following Meta's
// cursor pagination rather than assuming one page is the whole story.
async function leadsForForm(formId, token, sinceEpoch) {
  const out = [];
  let url = `${GRAPH}/${formId}/leads?fields=id,created_time&limit=100`
          + `&filtering=${encodeURIComponent(JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceEpoch }]))}`
          + `&access_token=${encodeURIComponent(token)}`;

  // Bounded so a pagination bug can never spin a serverless function forever.
  for (let page = 0; page < 50 && url; page++) {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (body.error) throw new Error(`Listing leads for form ${formId} failed: ${JSON.stringify(body.error)}`);
    out.push(...(body.data || []));
    url = body.paging && body.paging.next ? body.paging.next : null;
  }
  return out;
}

export async function reconcile({ days, dryRun }) {
  const pageId = process.env.META_PAGE_ID;
  if (!pageId) throw new Error('META_PAGE_ID is not set');

  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const token = await reconcilePageToken(pageId);
  const db = getDb();

  const summary = { days, dryRun: !!dryRun, forms: 0, seen: 0, alreadyPresent: 0, ingested: 0, failed: 0, details: [] };

  for (const form of await activeForms(pageId, token)) {
    summary.forms++;
    let leads;
    try {
      leads = await leadsForForm(form.id, token, since);
    } catch (e) {
      summary.failed++;
      summary.details.push({ form: form.name, error: String(e.message || e) });
      continue;
    }

    for (const lead of leads) {
      summary.seen++;
      const docId = 'meta_' + String(lead.id).replace(/[^A-Za-z0-9_-]/g, '');

      // Cheap existence check first — the overwhelmingly common case is "the
      // webhook already handled this", and that should cost one read, not a
      // Graph call.
      const existing = await db.collection('leads').doc(docId).get();
      if (existing.exists) { summary.alreadyPresent++; continue; }

      if (dryRun) {
        summary.ingested++;
        summary.details.push({ form: form.name, leadgenId: lead.id, createdTime: lead.created_time, wouldIngest: true });
        continue;
      }

      try {
        await processLeadgenEvent(db, { leadgen_id: lead.id, page_id: pageId, form_id: form.id });
        summary.ingested++;
        summary.details.push({ form: form.name, leadgenId: lead.id, ingested: true });
      } catch (e) {
        summary.failed++;
        summary.details.push({ form: form.name, leadgenId: lead.id, error: String(e.message || e) });
      }
    }
  }

  // A recovered lead means the webhook missed one — worth a loud log line,
  // because that is the signal the webhook needs looking at.
  if (summary.ingested > 0 && !dryRun) {
    console.warn(`meta-reconcile: recovered ${summary.ingested} lead(s) the webhook did not capture — check the webhook subscription and function logs.`);
  }
  console.log('meta-reconcile:', JSON.stringify({ ...summary, details: summary.details.slice(0, 20) }));
  return summary;
}
