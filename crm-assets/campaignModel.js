// ═══════════════════════════════════════════════════════════════════════
// WHATSAPP CAMPAIGNS — the pure half: templates, each lead's values, who is held back, the CSV.
//
// Pure, dependency-free ES module shared by the CRM page (bridged onto window.crmCampaign in
// crm.html), the server's campaign actions (api/_campaign.js) and tests/campaign.test.mjs — so
// what the page previews, what it downloads and what the server sends are filled in by the
// same code.
//
// A template's variables are its {{name}}-style placeholders. 3 PIN's templates name them freely
// ({{name}}, {{customer_name}}, {{property_name}}, {{property_code}}), so each variable is MAPPED
// to where its value comes from — the lead's name, the property's title or code, the visit's date,
// or text typed once for the whole campaign. TailorTalk sends named variables as an object and
// numbered ones ({{1}}, {{2}}) as a list in number order. WhatsApp rejects a send with an empty
// variable ("(#131008) Required parameter is missing"), so a lead without a value for every
// variable is held back rather than sent.
// ═══════════════════════════════════════════════════════════════════════

// What {{name}} becomes when a lead has no usable name. "Hi there!" reads naturally.
export const NAME_FALLBACK = 'there';

// The most leads one campaign holds — the recipients live in the campaign's one document.
export const MAX_RECIPIENTS = 1000;

// Where TailorTalk's template screen is.
export const TAILORTALK_URL = 'https://dashboard.tailortalk.ai/';

const VAR = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

// Every distinct variable in the texts, in order of first appearance.
export function varsIn(...texts) {
  const out = [];
  for (const t of texts) {
    for (const m of String(t == null ? '' : t).matchAll(VAR)) if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export const isPositional = vars => !!vars.length && vars.every(v => /^\d+$/.test(v));

// A variable name WhatsApp accepts: lower-case letters, digits and underscores, starting with a letter.
export const validVarName = v => /^[a-z][a-z0-9_]{0,29}$/.test(String(v || ''));

// A template name WhatsApp accepts.
export const validTemplateName = n => /^[a-z][a-z0-9_]{0,511}$/.test(String(n || ''));

// "Sold out notice!" → "sold_out_notice".
export function slugName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 't_$1').slice(0, 60);
}

// The number WhatsApp and TailorTalk's Broadcast want: country code, digits only, no "+".
// Ten digits are an Indian mobile; anything that cannot be a phone number is ''.
// "00" is the international prefix as typed from a landline ("0091…"), and "+91 0…" is a
// trunk 0 typed after the country code — both are dropped. An Indian number is only ever 91 and
// a ten-digit mobile starting 6–9: a landline or a typo would be a failed send that still costs.
// Other countries keep the 11–15 digits WhatsApp allows.
export function waNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  if (d.length === 13 && d.startsWith('910')) d = '91' + d.slice(3);
  if (d.startsWith('91')) return /^91[6-9]\d{9}$/.test(d) ? d : '';
  return d.length >= 11 && d.length <= 15 ? d : '';
}

// "919941880088" → "+91 99418 80088", for people to read.
export function prettyNumber(n) {
  const d = waNumber(n);
  if (!d) return String(n || '');
  if (d.startsWith('91') && d.length === 12) return '+91 ' + d.slice(2, 7) + ' ' + d.slice(7);
  return '+' + d;
}

// A display name as a greeting can use it: WhatsApp's "~ Ravi 🙂" becomes "Ravi", an all-digit
// "name" (the number, when nobody typed one) becomes ''.
export function greetingName(raw) {
  const s = String(raw || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/^[\s~@._-]+|[\s~@._-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || /^[\d\s+()-]+$/.test(s)) return '';
  if (s.length <= 30) return s;
  // Cut at the last whole word that fits — "Hi Ravichandran Venkatasubraman" reads as a typo.
  const cut = s.slice(0, 31).lastIndexOf(' ');
  return (cut > 0 ? s.slice(0, cut) : s.slice(0, 30)).trim();
}

// "Ravi Kumar" → "Ravi" — for a greeting that should sound like a person, not a form.
export const firstName = raw => greetingName(raw).split(' ')[0] || '';

// The inventory title for {{property}}, else configuration + type + location.
export function propertyLabel(p) {
  if (!p) return '';
  const title = String(p.name || '').trim();
  if (title) return title;
  return [[p.config, p.type].filter(Boolean).join(' '), p.location].filter(Boolean).join(', ');
}

// The code a lead's {{code}} gets — the inventory code, never the numeric id of an older row.
export const propertyCode = p => (p && p.propertyCode && !/^\d+$/.test(p.propertyCode) ? String(p.propertyCode) : '');

// ─── where a variable's value comes from ─────────────────────────────────

export const SOURCES = [
  ['lead_name', 'Lead’s name'],
  ['first_name', 'Lead’s first name'],
  ['property', 'Property name'],
  ['code', 'Property code'],
  ['area', 'Property area'],
  ['price', 'Property price'],
  ['config', 'Configuration (BHK)'],
  ['visit_date', 'Visit date'],
  ['visit_time', 'Visit time'],
  ['agent_name', 'Agent’s name'],
  ['agent_phone', 'Agent’s phone'],
  ['req_area', 'Area they want'],
  ['req_config', 'Size they want (BHK)'],
  ['req_budget', 'Their budget'],
  ['fixed', 'Same text for everyone']
];

// One line on each source, for the mapping screen — what the lead will actually see.
export const SOURCE_HELP = {
  lead_name: 'The lead’s name as saved in the CRM — “there” when it has none',
  first_name: 'Only the first word of the lead’s name — “there” when it has none',
  property: 'The property’s name from the inventory',
  code: 'The property’s inventory code, like ANR003',
  area: 'Where the property is',
  price: 'The property’s starting price from the inventory',
  config: 'The property’s configuration, like 3 BHK',
  visit_date: 'The day of the lead’s site visit',
  visit_time: 'The time of the lead’s site visit',
  agent_name: 'The team member meeting them (the visit’s agent, else the one sending)',
  agent_phone: 'That team member’s phone number',
  req_area: 'The area the LEAD asked for — from their enquiry, not the property',
  req_config: 'The size the LEAD asked for, like 3 BHK — from their enquiry',
  req_budget: 'The budget the LEAD gave us — from their enquiry',
  fixed: 'Text you type once — every lead gets the same words'
};

// A sensible first guess from the variable's own name; anything unrecognised is typed once.
// Read word by word ("preferred_location" is preferred + location), so a word hiding inside
// another — the "ref" in "preferred" — never decides it.
export function autoSource(v) {
  const s = String(v || '').toLowerCase();
  if (/^1$/.test(s)) return 'lead_name';
  const w = s.split(/[^a-z0-9]+/).filter(Boolean);
  const has = (...words) => w.some(t => words.includes(t));
  if (has('budget')) return 'req_budget';
  // What the lead asked for, not what the property is.
  if (has('req', 'requirement', 'preferred', 'wanted', 'want', 'wants', 'looking')) {
    return has('bhk', 'config', 'configuration', 'size') ? 'req_config' : 'req_area';
  }
  if (has('agent', 'executive', 'rm', 'manager', 'consultant', 'staff')) {
    return has('phone', 'number', 'mobile', 'contact', 'no', 'ph', 'whatsapp') ? 'agent_phone' : 'agent_name';
  }
  if (has('first', 'fname', 'firstname')) return 'first_name';
  if (w.some(t => t === 'day' || t === 'dt' || t.endsWith('date'))) return 'visit_date';
  if (w.some(t => t === 'slot' || t.endsWith('time'))) return 'visit_time';
  if (w.some(t => t === 'ref' || t === 'refno' || t.endsWith('code'))) return 'code';
  if (w.some(t => /^(price|rate|cost|amount)/.test(t))) return 'price';
  if (has('area', 'location', 'locality', 'place', 'zone', 'address')) return 'area';
  if (w.some(t => t === 'bhk' || t.startsWith('config'))) return 'config';
  if (has('property', 'project', 'listing', 'flat', 'apartment', 'villa', 'home', 'house')) return 'property';
  if (has('name', 'customer', 'client', 'lead', 'buyer')) return 'lead_name';
  return 'fixed';
}

export function autoMapping(vars, prev) {
  const out = {};
  for (const v of vars) out[v] = prev && prev[v] && prev[v].source ? prev[v] : { source: autoSource(v), text: '' };
  return out;
}

const IST = 'Asia/Kolkata';
export function visitDate(at) {
  if (!at) return '';
  return new Date(at).toLocaleDateString('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short' });
}
export function visitTime(at) {
  if (!at) return '';
  return new Date(at).toLocaleTimeString('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s/g, ' ').toUpperCase();
}

// ─── what the lead asked for ─────────────────────────────────────────────

// Rupees from budget or price text as people type it — "1.5 Cr", "85 L", "₹65L+", "3 to 4 Crores"
// (the dashboard's own reading, parseBudgetToINR in dashboardMetrics.js). A range gives its
// `pick`: 'min', 'max' or the average (default). No unit (Cr / L) → null, never a guess.
export function parseRupees(str, pick) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  let unit = null;
  if (/crore|cr[es]?(?![a-z])/.test(s)) unit = 1e7;
  else if (/lakh|lac|l(?![a-z])/.test(s)) unit = 1e5;
  if (!unit) return null;
  const nums = (s.match(/\d+(\.\d+)?/g) || []).map(Number).filter(n => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  const n = pick === 'min' ? Math.min(...nums) : pick === 'max' ? Math.max(...nums) : nums.reduce((a, b) => a + b, 0) / nums.length;
  return n * unit;
}

// 15000000 → "₹1.5 Cr", 8500000 → "₹85 L".
export function formatRupees(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return '';
  if (x >= 1e7) return `₹${(x / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr`;
  if (x >= 1e5) return `₹${(x / 1e5).toFixed(2).replace(/\.?0+$/, '')} L`;
  return `₹${Math.round(x).toLocaleString('en-IN')}`;
}

// Short enough for a variable, cut at a word.
function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n + 1).lastIndexOf(' ');
  return (cut > 0 ? t.slice(0, cut) : t.slice(0, n)).replace(/[,;:.\-–—\s]+$/, '');
}

const TYPE_WORDS = { apartment: 'apartment', villa: 'villa', independent_house: 'independent house', plot: 'plot', commercial: 'commercial' };

/**
 * What the LEAD asked for — never the property's facts. The AI's reading of the chat
 * (lead.ai.want: areas, bhk, budget_max …) when there is one; else what TailorTalk or a person
 * saved on the lead (tt.values.propertyInterest / propertyInterest, budget).
 * @returns {{ areas: string[], bhk: number[], budgetMax: number|null, areaText, configText, budgetText }}
 *   every text '' when unknown.
 */
export function leadRequirement(lead) {
  const l = lead || {};
  const want = (l.ai && l.ai.want && typeof l.ai.want === 'object') ? l.ai.want : {};
  const vals = (l.tt && l.tt.values) || {};
  const interest = String(vals.propertyInterest || l.propertyInterest || '').trim();
  const budgetRaw = String(l.budget || vals.budget || '').trim();

  const areas = (Array.isArray(want.areas) ? want.areas : []).map(a => String(a || '').trim()).filter(Boolean);
  // "3BHK in Adyar, budget 1.8Cr" → "Adyar": the size and the budget have sources of their own.
  const place = interest.replace(/\b\d+(\.\d+)?\s*-?\s*bhk\b/gi, ' ').replace(/\bbudget\b.*$/i, ' ')
    .replace(/^[\s,;:-]*(?:in|at|near|around)\b/i, ' ').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '').replace(/\s+/g, ' ');
  const areaText = areas.length ? clip(areas.slice(0, 2).join(', '), 40) : clip(place, 40);

  let bhk = (Array.isArray(want.bhk) ? want.bhk : []).filter(n => Number.isInteger(n) && n > 0);
  if (!bhk.length) bhk = [...interest.matchAll(/\b(\d)\s*-?\s*bhk\b/gi)].map(m => Number(m[1]));
  bhk = [...new Set(bhk)].sort((a, b) => a - b);
  const types = (Array.isArray(want.types) ? want.types : []).map(t => TYPE_WORDS[t]).filter(Boolean);
  const configText = bhk.length
    ? (bhk.length > 1 ? bhk.slice(0, -1).join(', ') + ' or ' + bhk[bhk.length - 1] : String(bhk[0])) + ' BHK'
    : (types[0] || '');

  const monthly = want.budget_unit === 'per_month' || want.budget_unit === 'lease_amount';
  const aiMax = !monthly && Number(want.budget_max) > 0 ? Number(want.budget_max) : null;
  const aiMin = !monthly && Number(want.budget_min) > 0 ? Number(want.budget_min) : null;
  const budgetMax = aiMax || parseRupees(budgetRaw, 'max');
  const budgetText = budgetRaw ? clip(budgetRaw, 30)
    : aiMax ? (aiMin && aiMin < aiMax ? formatRupees(aiMin) + ' – ' + formatRupees(aiMax) : formatRupees(aiMax)) : '';
  return { areas, bhk, budgetMax: budgetMax || null, areaText, configText, budgetText };
}

// One lead's value for one source. `prop` is the property this lead is sent about (the campaign's
// one property, or the lead's own) — null when it has none; `visit` is the lead's site visit;
// `agent` { name, phone } is the team member the message names (the visit's agent, else the sender).
export function sourceValue(source, { lead, prop, visit, agent, text } = {}) {
  switch (source) {
    case 'lead_name': return greetingName(lead && lead.name) || NAME_FALLBACK;
    case 'first_name': return firstName(lead && lead.name) || NAME_FALLBACK;
    case 'property': return propertyLabel(prop);
    case 'code': return propertyCode(prop);
    case 'area': return String((prop && prop.location) || '').trim();
    case 'price': return String((prop && prop.startingPrice) || '').trim();
    case 'config': return String((prop && prop.config) || '').trim();
    case 'visit_date': return visitDate(visit && visit.at);
    case 'visit_time': return visitTime(visit && visit.at);
    case 'agent_name': return clip(agent && agent.name, 30);
    case 'agent_phone': {
      const raw = String((agent && agent.phone) || '').trim();
      return waNumber(raw) ? prettyNumber(raw) : raw;
    }
    case 'req_area': return leadRequirement(lead).areaText;
    case 'req_config': return leadRequirement(lead).configText;
    case 'req_budget': return leadRequirement(lead).budgetText;
    case 'fixed': return String(text || '').trim();
    default: return '';
  }
}

export function valuesFor(vars, mapping, ctx) {
  const out = {};
  for (const v of vars) {
    const m = (mapping && mapping[v]) || { source: autoSource(v) };
    out[v] = sourceValue(m.source, { ...ctx, text: m.text });
  }
  return out;
}

// The variables with no value — a lead with any is not sent.
export function missingVars(vars, values) {
  return vars.filter(v => !String((values || {})[v] == null ? '' : values[v]).trim());
}

// A variable's value as WhatsApp accepts it: Meta refuses a parameter holding a new line or a
// tab, or more than three spaces in a row ("(#132018) … issue with the parameters"), so a note
// typed over two lines becomes one.
export function cleanParam(v) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
}

// TailorTalk's template_params: an object by name, or a list in number order for {{1}}, {{2}}.
export function paramsFor(vars, values) {
  const val = v => cleanParam((values || {})[v]);
  if (isPositional(vars)) return [...vars].sort((a, b) => a - b).map(val);
  return Object.fromEntries(vars.map(v => [v, val(v)]));
}

// The template text as this lead will read it; a variable with no value stays visible as {{v}}.
export function fillText(text, values) {
  return String(text || '').replace(VAR, (m, v) => cleanParam((values || {})[v]) || m);
}

// ─── WhatsApp's template rules, checked before anything is submitted ──────

export const LIMITS = { header: 60, body: 1024, footer: 60, button: 25, buttons: 3 };

// Words that make a Utility template read as selling — offers, and anything pointing the lead at a
// property other than the one they already dealt with us about. Meta re-labels such a template
// Marketing (and charges for it); a template that needs them should be Marketing from the start.
const UTILITY_PROMO = /\b(offers?|discount|deal|limited|hurry|exclusive|best|lowest|grab|sale|launch|similar|more options|other properties|new|available|refer|referral|friends?|review|visit this week|still looking)\b/i;

// Problems Meta rejects a template for (errors), and things that make rejection or a Marketing
// re-label likely (warnings).
export function lintTemplate(t) {
  const errors = [], warnings = [];
  const name = String((t && t.name) || ''), header = String((t && t.header) || ''), body = String((t && t.body) || '');
  const footer = String((t && t.footer) || ''), buttons = (t && Array.isArray(t.buttons) ? t.buttons : []).map(b => String((b && b.text) || b || '').trim());
  if (!validTemplateName(name)) errors.push('Name: lower-case letters, numbers and _ only, starting with a letter');
  if (!body.trim()) errors.push('The message body is empty');
  if (body.length > LIMITS.body) errors.push(`Body is ${body.length} characters — at most ${LIMITS.body}`);
  if (header.length > LIMITS.header) errors.push(`Header is ${header.length} characters — at most ${LIMITS.header}`);
  if (footer.length > LIMITS.footer) errors.push(`Footer is ${footer.length} characters — at most ${LIMITS.footer}`);
  if (varsIn(header).length > 1) errors.push('A header can hold at most one variable');
  if (varsIn(footer).length) errors.push('A footer cannot hold a variable');
  if (/\n\s*\n\s*\n/.test(body)) warnings.push('More than one blank line in a row — WhatsApp rejects this');
  const vars = varsIn(header, body);
  const bad = vars.filter(v => !validVarName(v) && !/^\d+$/.test(v));
  if (bad.length) errors.push('Variable names are lower-case with _ only: ' + bad.join(', '));
  if (vars.some(v => /^\d+$/.test(v)) && vars.some(v => !/^\d+$/.test(v))) errors.push('Use named variables ({{name}}) or numbered ones ({{1}}), not both');
  // Numbered variables count from {{1}} in the order they appear, none skipped — Meta numbers the
  // header and the body each on their own.
  else if (isPositional(vars)) {
    const inOrder = list => list.every((v, i) => v === String(i + 1));
    if (!inOrder(varsIn(header)) || !inOrder(varsIn(body))) errors.push('Numbered variables must run {{1}}, {{2}}, {{3}}… in the order they appear, none skipped');
  }
  const trimmed = body.trim();
  if (/^\{\{[^}]+\}\}/.test(trimmed)) errors.push('The body cannot start with a variable');
  if (/\{\{[^}]+\}\}[.!?\s]*$/.test(trimmed)) errors.push('The body cannot end with a variable — add a few words after it');
  if (/\}\}\s*\{\{/.test(body)) errors.push('Two variables side by side — put words between them');
  const words = trimmed.replace(VAR, ' ').split(/\s+/).filter(Boolean).length;
  const bodyVars = varsIn(body).length;
  if (bodyVars && words < bodyVars * 3 + 3) warnings.push('Very little text around the variables — Meta may reject it as too thin');
  if (buttons.length > LIMITS.buttons) errors.push(`At most ${LIMITS.buttons} buttons`);
  buttons.forEach((b, i) => {
    if (!b) errors.push(`Button ${i + 1} has no text`);
    else if (b.length > LIMITS.button) errors.push(`Button “${b}” is ${b.length} characters — at most ${LIMITS.button}`);
  });
  if (new Set(buttons.map(b => b.toLowerCase())).size !== buttons.length) errors.push('Two buttons have the same text');
  if (t && t.category === 'UTILITY' && UTILITY_PROMO.test(body + ' ' + header)) {
    warnings.push('Promotional words in a Utility template — Meta will likely re-label it Marketing');
  }
  return { errors, warnings, ok: !errors.length };
}

// The template as one block of text, to paste into TailorTalk's template screen.
export function templateAsText(t) {
  const lines = [`Name: ${t.name}`, `Category: ${t.category === 'UTILITY' ? 'Utility' : 'Marketing'}`, `Language: ${t.language || 'en'}`];
  if (t.header) lines.push('', 'Header:', t.header);
  lines.push('', 'Body:', t.body || '');
  if (t.footer) lines.push('', 'Footer:', t.footer);
  const b = (t.buttons || []).map(x => String((x && x.text) || x || '')).filter(Boolean);
  if (b.length) lines.push('', 'Quick reply buttons:', ...b.map(x => '• ' + x));
  const ex = t.examples || {};
  const vars = varsIn(t.header, t.body);
  if (vars.length) lines.push('', 'Variable samples:', ...vars.map(v => `{{${v}}} → ${ex[v] || SAMPLE[v] || 'sample'}`));
  return lines.join('\n');
}

// Sample values Meta asks for with each variable.
export const SAMPLE = {
  name: 'Ravi', customer_name: 'Ravi', lead_name: 'Ravi', first_name: 'Ravi', property: 'Sunrise Residency 3 BHK', property_name: 'Sunrise Residency 3 BHK',
  code: 'ANR003', property_code: 'ANR003', area: 'Anna Nagar', price: '₹2.8 Cr', config: '3 BHK',
  visit_date: 'Sat, 8 Nov', visit_time: '11:00 AM', agent_name: 'Karthik', agent_phone: '+91 98400 12345',
  req_area: 'Anna Nagar', req_config: '3 BHK', req_budget: '₹1.5 Cr',
  enquiries: '12', visits: '3', feedback: 'liked the layout, asked about parking'
};
export const sampleFor = (v, examples) => (examples && examples[v]) || SAMPLE[v] || (/name/.test(v) ? 'Ravi' : 'sample');

// ─── the starter library ─────────────────────────────────────────────────
//
// Ready to submit as written, in the words of a marketing review (Nov 2026). The category is the
// honest one: a Utility template speaks only to something the lead already did with 3 PIN — a
// visit, the property they enquired about, a report they are owed — which is what keeps it
// Utility. Anything that points them at another home is Marketing, says so, and carries a
// "Stop offers" button, so a lead can turn offers off without turning off their visit reminders.
// One starter per purpose (the Tamil reminder is a second language of the same one); purposes
// the journeys use (crm-assets/journeys.js) each have theirs.

const FOOT = '- 3PIN Realty';
export const STARTERS = [
  { purpose: 'visit_reminder', title: 'Visit reminder', category: 'UTILITY', name: 'visit_reminder_v2', language: 'en',
    header: '',
    body: 'Hi {{name}}, a reminder of your site visit to {{property}}, {{area}} on {{visit_date}} at {{visit_time}}.\n\n{{agent_name}} from 3 PIN Realty will meet you there and can be reached on {{agent_phone}}. Tap Confirm, or Reschedule if the time no longer suits you.',
    footer: FOOT, buttons: ['Confirm', 'Reschedule', 'Share location'] },
  { purpose: 'visit_reminder', title: 'Visit reminder (Tamil)', category: 'UTILITY', name: 'visit_reminder_ta_v1', language: 'ta',
    header: '',
    body: 'வணக்கம் {{name}}! {{property}} சைட் விசிட் நினைவூட்டல்: {{visit_date}} அன்று {{visit_time}}.\n\n3 PIN Realty-யின் {{agent_name}} உங்களை அங்கே சந்திப்பார். நேரத்தை மாற்ற கீழே உள்ள பட்டனைத் தட்டுங்கள்.',
    footer: FOOT, buttons: ['உறுதி', 'நேரம் மாற்ற'] },
  { purpose: 'visit_confirmed', title: 'Visit confirmed', category: 'UTILITY', name: 'visit_confirmed_v1', language: 'en',
    header: 'Site Visit Confirmed',
    body: 'Hi {{name}}, your site visit to {{property}} ({{code}}) is confirmed for {{visit_date}} at {{visit_time}}.\n\nOur team member will share the location before the visit. Reply here for any change.',
    footer: FOOT, buttons: ['Thank you', 'Reschedule'] },
  { purpose: 'no_show', title: 'Missed visit', category: 'UTILITY', name: 'no_show_v1', language: 'en',
    header: '',
    body: 'Hi {{name}}, we were expecting you at {{property}} today and missed you.\n\nShall we fix another time that suits you? Tap below or reply with a day and time.',
    footer: FOOT, buttons: ['Reschedule', 'Call me'] },
  { purpose: 'visit_feedback', title: 'Site visit feedback', category: 'UTILITY', name: 'visit_feedback_v2', language: 'en',
    header: '',
    body: 'Hi {{name}}, thank you for visiting {{property}} ({{code}}) with 3 PIN Realty on {{visit_date}}.\n\nHow did you find it? Tap a reply below, or write to us what you liked and any concerns you have.',
    footer: FOOT, buttons: ['Liked it', 'Have some concerns', 'Not for me'] },
  { purpose: 'feedback_nudge', title: 'Feedback nudge', category: 'UTILITY', name: 'visit_feedback_nudge_v2', language: 'en',
    header: '',
    body: 'Hi {{name}}, checking in after your visit to {{property}} ({{code}}) on {{visit_date}}.\n\nIf you have any questions on the price, documents or home loan, tap below and our team will help.',
    footer: FOOT, buttons: ['Request a call', 'Help with loan', 'Not for me'] },
  { purpose: 'brochure', title: 'Brochure share', category: 'UTILITY', name: 'brochure_share_v1', language: 'en', mediaHeader: true,
    header: '',
    body: 'Hi {{name}}, here is the brochure for {{property}} ({{code}}) that you asked about.\n\nIt has the plan, size and price details. Reply here to book a site visit.',
    footer: FOOT, buttons: ['Book a visit', 'Talk to the team'] },
  { purpose: 'owner_report', title: 'Owner monthly report', category: 'UTILITY', name: 'owner_monthly_report_v1', language: 'en',
    header: '',
    body: 'Hi {{name}}, your monthly update for {{property}} ({{code}}) from 3 PIN Realty: {{enquiries}} enquiries and {{visits}} site visits this month.\n\nBuyer feedback so far: {{feedback}}. Reply here or tap below to discuss the next step.',
    footer: FOOT, buttons: ['Call me', 'Review the price', 'All good'] },
  // Marketing from here on — each one is about a home other than the one they dealt with us about.
  { purpose: 'sold_out', title: 'Sold — similar homes', category: 'MARKETING', name: 'property_sold_similar_v1', language: 'en',
    header: '',
    body: 'Hi {{name}}, {{property}} in {{area}}, which you asked about, has been sold.\n\nWe have a few similar homes nearby in the same budget. Shall we send you the 3 closest matches?',
    footer: FOOT, buttons: ['Yes, send them', 'Not now', 'Stop offers'] },
  { purpose: 'new_listing', title: 'New listing', category: 'MARKETING', name: 'new_listing_v2', language: 'en', mediaHeader: true,
    header: '',
    body: 'Hi {{name}}, a new {{config}} at {{property}}, {{area}} has just come to us at {{price}}.\n\nIt matches what you told us you were looking for. Want the photos and floor plan, or a visit this weekend?',
    footer: FOOT, buttons: ['Send details', 'Book a visit', 'Stop offers'] },
  { purpose: 'price_drop', title: 'Price drop', category: 'MARKETING', name: 'price_drop_v1', language: 'en',
    header: 'New Price',
    body: 'Hi {{name}}, good news on {{property}} in {{area}} — it is now available at {{price}}.\n\nReply to get the latest details or to arrange a visit this week.',
    footer: FOOT, buttons: ['Send details', 'Book a visit', 'Stop offers'] },
  { purpose: 'options_followup', title: 'Options follow-up', category: 'MARKETING', name: 'options_followup_v2', language: 'en',
    header: '',
    body: 'Hi {{name}}, did you get a chance to look at the homes we sent for {{req_area}}?\n\nIf one stands out, we can arrange a visit this weekend. If none fit, tell us what to change (area, budget or size) and we will send fresh options.',
    footer: FOOT, buttons: ['Book a visit', 'Send fresh options', 'Not now'] },
  { purpose: 'search_checkin', title: 'On hold — search check-in', category: 'MARKETING', name: 'search_checkin_v1', language: 'en',
    header: '',
    body: 'Hi {{name}}, 3 PIN Realty here. You had asked us to check back about your {{req_config}} home search around {{req_area}}.\n\nIs now a good time? Tap below and we will send this week\'s best matches in your budget, or call at a time that suits you.',
    footer: FOOT, buttons: ['Send matches', 'Call me', 'Not yet'] },
  { purpose: 'reengage', title: 'Re-engage a quiet lead', category: 'MARKETING', name: 'reengage_search_v1', language: 'en',
    header: '',
    body: 'Hi {{name}}, AIRA here from 3 PIN Realty. We have added new homes across Chennai since we last spoke.\n\nShall we share the latest options that match what you were looking for?',
    footer: FOOT, buttons: ['Yes, share options', 'Not now', 'Stop offers'] },
  { purpose: 'referral', title: 'Review or referral', category: 'MARKETING', name: 'review_referral_v1', language: 'en',
    header: '',
    body: 'Hi {{name}}, congratulations again on your new home at {{property}} from all of us at 3 PIN Realty! 🏡\n\nIf you were happy with how we helped, a short Google review would mean a lot to our small team. And if anyone you know wants to buy or sell in Chennai, just reply with their name.',
    footer: FOOT, buttons: ['Write a review', 'Refer someone'] }
];

// Purposes a template can be tagged with: the starters', then ones older templates still carry
// (property_requirement_followup is 'followup'; a price-revision template 'price_update').
export const PURPOSES = (() => {
  const out = [];
  for (const s of STARTERS) if (!out.some(p => p[0] === s.purpose)) out.push([s.purpose, s.title.replace(/ \(Tamil\)$/, '')]);
  return out.concat([['followup', 'Requirement follow-up'], ['price_update', 'Price update'], ['other', 'Something else']]);
})();

// A template's purpose: its own tag, else read from its name — the more particular names first
// (a "feedback nudge" is not the feedback ask itself). '' when the name says nothing.
export function purposeOf(t) {
  if (!t) return '';
  if (t.purpose) return t.purpose;
  const n = String(t.name || '');
  if (/nudge/.test(n)) return 'feedback_nudge';
  if (/referr|review|after_purchase/.test(n)) return 'referral';
  if (/options?_follow/.test(n)) return 'options_followup';
  if (/no_?show|missed_visit/.test(n)) return 'no_show';
  if (/owner|monthly_report/.test(n)) return 'owner_report';
  if (/check_?in|search_checkin/.test(n)) return 'search_checkin';
  if (/feedback/.test(n)) return 'visit_feedback';
  if (/sold/.test(n)) return 'sold_out';
  if (/remind/.test(n)) return 'visit_reminder';
  if (/confirm/.test(n)) return 'visit_confirmed';
  if (/re_?engage/.test(n)) return 'reengage';
  if (/new_listing|just_listed/.test(n)) return 'new_listing';
  if (/follow/.test(n)) return 'followup';
  if (/price_drop/.test(n)) return 'price_drop';
  if (/price/.test(n)) return 'price_update';
  if (/brochure/.test(n)) return 'brochure';
  return '';
}

// ─── who gets a campaign ─────────────────────────────────────────────────

const DAY_MS = 86400000;
export const FREE_WINDOW_MS = 24 * 3600000;
export const UNANSWERED_LIMIT = 2;          // Marketing sends in a row with no reply…
export const UNANSWERED_WITHIN_DAYS = 60;   // …within this long: stop offering

// Did the lead write to us in the last 24 hours? WhatsApp lets the team reply in the chat for
// free then — a paid template would be money spent on what a message in the chat does better.
export function inFreeWindow(lead, now) {
  const t = Number(lead && lead.tt && lead.tt.lastMessageAt) || 0;
  return !!t && (now || Date.now()) - t < FREE_WINDOW_MS;
}

// When the lead last got a Marketing message. Leads from before the server kept lastMarketingAt
// fall back to the last campaign of any kind — the stricter reading, until a send records it.
function lastOfferAt(l) {
  if (l.lastMarketingAt != null) return Number(l.lastMarketingAt) || 0;
  return l.marketingUnanswered == null ? Number(l.lastCampaignAt) || 0 : 0;
}

/**
 * Why a lead with a number is held back from a campaign, or null to send — the same rules, in
 * the same order, as the server applies at create and again at send (api/_campaign.js), so what
 * the page leaves out is what the server would have cancelled.
 *
 * @param ctx { optOut: Set<number>, marketingOptOut?: Set<number>, marketing: bool, gapDays, now,
 *              sentNumbers?: Set<number>, stageKey?: string | (lead) → stage key, purpose? }
 * @returns {{ code, text } | null} — `code` is the server's own word for it, exactly as it writes
 *   recipients[k].why ('opted out', 'no offers', 'messaged recently', 'two offers unanswered',
 *   'in negotiation/won', 'inside free 24-h window — reply in chat'; also 'no number',
 *   'duplicate number', 'dead'); `text` is the line the page shows.
 */
export function holdWhy(lead, contact, ctx) {
  const c = ctx || {};
  const l = lead || {};
  const now = c.now || Date.now();
  const why = (code, text) => ({ code, text });
  if (!contact) return why('no number', 'No WhatsApp number');
  if (l.waOptOut === true || (c.optOut && c.optOut.has(contact))) return why('opted out', 'Asked not to be messaged');
  if (c.sentNumbers && c.sentNumbers.has(contact)) return why('duplicate number', 'Same number as another lead here');
  if (l.tt && l.tt.status === 'dead') return why('dead', 'Dead in TailorTalk');
  if (!c.marketing) return null;
  if (l.waMarketingOptOut === true || (c.marketingOptOut && c.marketingOptOut.has(contact))) return why('no offers', 'Asked for no more offers');
  const gap = Number(c.gapDays) || 0;
  const last = lastOfferAt(l);
  if (gap > 0 && last && now - last < gap * DAY_MS) return why('messaged recently', `Messaged in the last ${gap} days`);
  if ((Number(l.marketingUnanswered) || 0) >= UNANSWERED_LIMIT && l.lastMarketingAt && now - l.lastMarketingAt < UNANSWERED_WITHIN_DAYS * DAY_MS) {
    return why('two offers unanswered', 'Two offers unanswered');
  }
  // A Marketing message never goes to a lead whose deal a person is closing — except the
  // referral ask, which is for exactly the people who bought.
  const key = typeof c.stageKey === 'function' ? c.stageKey(lead) : c.stageKey;
  if ((key === 'negotiation' || key === 'won') && c.purpose !== 'referral') {
    return why('in negotiation/won', (key === 'won' ? 'Won' : 'Negotiating') + ' — no Marketing messages');
  }
  if (inFreeWindow(l, now)) return why('inside free 24-h window — reply in chat', 'Inside free 24-h window — reply in chat');
  return null;
}

// The same, as the one line the page shows — '' to send.
export function holdReason(lead, contact, ctx) {
  const w = holdWhy(lead, contact, ctx);
  return w ? w.text : '';
}

// ─── the CSV for TailorTalk → Campaign → Broadcast ───────────────────────

// A `contact` column, then one column per variable headed with the variable's name.
export function toCsv(rows, vars) {
  const cell = v => {
    let s = String(v == null ? '' : v);
    // A cell starting with = + @ (or a minus before a number or =) is a formula to a spreadsheet;
    // a leading apostrophe defuses it. A name like "-Ravi-" or "- 3PIN" is left as typed.
    if (/^[=+@]|^-[\d=]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ['contact', ...vars];
  const lines = [head.map(cell).join(',')];
  for (const r of rows) lines.push([r.contact, ...vars.map(v => (r.values || {})[v])].map(cell).join(','));
  return lines.join('\r\n') + '\r\n';
}

// A header document or image has to be a direct file link. A Drive "view" link is a web page, so
// it is turned into Drive's download link; only the first of several comma-separated links is used.
export function mediaUrl(raw) {
  const first = String(raw || '').split(/[,\s]+/).find(s => /^https?:\/\//i.test(s)) || '';
  if (!first) return '';
  const m = first.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([A-Za-z0-9_-]{10,})/);
  return m ? 'https://drive.google.com/uc?export=download&id=' + m[1] : first;
}

// ─── delivery ────────────────────────────────────────────────────────────

// Delivery only moves forward; a later status never goes back to an earlier one.
export const STATUS_ORDER = ['ready', 'sending', 'sent', 'delivered', 'read', 'replied'];
export function laterStatus(cur, next) {
  if (next === 'failed') return cur === 'ready' || cur === 'sending' || cur === 'sent' ? 'failed' : cur;
  const a = STATUS_ORDER.indexOf(cur), b = STATUS_ORDER.indexOf(next);
  return b > a ? next : cur;
}

// Totals for a campaign's recipients, by where each one got to. "delivered" counts everyone who
// got at least that far (a read message was delivered), as WhatsApp's own reports do.
export function tally(recipients) {
  const t = { total: 0, ready: 0, sending: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, cancelled: 0, exported: 0 };
  for (const r of Object.values(recipients || {})) {
    t.total++;
    const s = r && r.status;
    if (s === 'failed' || s === 'ready' || s === 'sending' || s === 'cancelled' || s === 'exported') { t[s]++; continue; }
    const i = STATUS_ORDER.indexOf(s);
    if (i >= 2) t.sent++;
    if (i >= 3) t.delivered++;
    if (i >= 4) t.read++;
    if (i >= 5) t.replied++;
  }
  return t;
}

export const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

// ─── replies, cost, quiet hours ──────────────────────────────────────────

// What a reply meant (recipients[key].reply.action, lead.campaignReply.action), as a person reads it —
// worded as the CRM's own lead page and bell word it (crm-assets/leadAttention.js).
export const REPLY_ACTIONS = {
  optout: 'Asked not to be messaged',
  marketing_optout: 'Asked for no more offers',
  call: 'Asked for a call',
  visit: 'Wants a site visit',
  options: 'Wants options or details',
  feedback: 'Gave feedback',
  not_now: 'Said not now — check back in 30 days',
  found: 'Says they found a property',
  reschedule: 'Wants to reschedule the visit',
  ack: 'Said thanks / confirmed',
  not_this: 'Not interested in this one',
  referral: 'Wants to refer someone',
  seller: 'Wants to sell or list a property',
  loan: 'Needs home-loan help',
  other: 'Replied'
};
export const replyMeaning = action => REPLY_ACTIONS[action] || REPLY_ACTIONS.other;

// How a reply reads for the campaign's scorecard. A key this file does not know is neutral —
// the server may learn new ones before the page does.
const POSITIVE = ['call', 'visit', 'options', 'feedback', 'referral', 'seller', 'loan', 'reschedule'];
const NEGATIVE = ['not_this', 'optout', 'marketing_optout'];
export function replySentiment(action) {
  if (POSITIVE.includes(action)) return 'positive';
  if (NEGATIVE.includes(action)) return 'negative';
  return 'neutral';
}

// Does this reply need a person? A thanks or a confirmed visit does not, nor a "not this one"
// (noted on the lead, nothing to do), nor a STOP (the server has already acted on it) —
// everything else does, including a key not known yet. Given the lead, it must also still be
// OPEN: newer than the team's last touch (lead.updatedAt) and than TailorTalk's attention mark
// (lead.tt.attentionFrom). The ONE rule the Campaigns dashboard, the Daily task list and the bell
// all use — the same list and test as REPLY_NO_PERSON / replyNeedsPerson in leadAttention.js.
// `reply` is lead.campaignReply / recipients[k].reply ({ action, at, … }) or the action itself;
// with `reply` null and a lead, the lead's campaignReply is read.
export const REPLY_NO_PERSON = ['ack', 'optout', 'marketing_optout', 'not_this'];
export function replyNeedsPerson(reply, lead) {
  const r = reply || (lead && lead.campaignReply) || null;
  if (!r) return false;
  const action = typeof r === 'string' ? r : r.action;
  if (REPLY_NO_PERSON.includes(action || 'other')) return false;
  if (!lead) return true;
  const since = Math.max(Number(lead.updatedAt) || 0, Number(lead.tt && lead.tt.attentionFrom) || 0);
  return typeof r === 'object' && (Number(r.at) || 0) > since;
}

// ₹ per message WhatsApp charges for each category in India — approximate, and editable in the
// campaign settings (marketingRate / utilityRate) as Meta's price list moves.
export const DEFAULT_RATES = { MARKETING: 0.79, UTILITY: 0.12 };
export const COST_WARN = { rupees: 500, people: 200 };

// The approximate cost of `count` messages of a template `category`, with the settings' rates.
export function estimateCost(count, category, settings) {
  const st = settings || {};
  const marketing = String(category || '').toUpperCase() === 'MARKETING';
  const rate = Number(marketing ? st.marketingRate : st.utilityRate);
  const r = Number.isFinite(rate) && rate >= 0 ? rate : DEFAULT_RATES[marketing ? 'MARKETING' : 'UTILITY'];
  const n = Math.max(0, Number(count) || 0);
  const total = Math.round(n * r * 100) / 100;
  return { rate: r, count: n, total, marketing, warn: total > COST_WARN.rupees || n > COST_WARN.people };
}

// "₹1,234" / "₹23.70" — whole rupees once it is more than a few hundred.
export function rupees(x) {
  const n = Number(x) || 0;
  return '₹' + (n >= 100 ? Math.round(n).toLocaleString('en-IN') : n.toFixed(2).replace(/\.00$/, ''));
}

// Quiet hours, in India time: from `start` o'clock to `end` o'clock the next morning (21 → 9 by
// default). Messages that land then wake people up — the server refuses unless told to send anyway.
export const QUIET_DEFAULT = { start: 21, end: 9 };
export function inQuietHours(now, start, end) {
  const s = Number.isFinite(Number(start)) && start !== null && start !== '' ? Number(start) : QUIET_DEFAULT.start;
  const e = Number.isFinite(Number(end)) && end !== null && end !== '' ? Number(end) : QUIET_DEFAULT.end;
  if (s === e) return false;
  const h = new Date((now || Date.now()) + 5.5 * 3600000).getUTCHours();
  return s < e ? h >= s && h < e : h >= s || h < e;
}
// "9 PM", "9 AM", "12 noon".
export function hourLabel(h) {
  const n = ((Number(h) % 24) + 24) % 24;
  if (n === 0) return '12 midnight';
  if (n === 12) return '12 noon';
  return (n % 12) + (n < 12 ? ' AM' : ' PM');
}

// ─── what a campaign earned ──────────────────────────────────────────────
//
// The scorecard a marketing person asks for: of the people a campaign reached, how many replied
// well, shrugged or said no, how many turned off messages, and what it led to — a visit booked
// within 14 days, a sale within 21 — against what it cost. The windows are fixed so two
// campaigns are compared on the same terms; until a window has passed the numbers can still grow
// (`counting`).

export const STATS_WINDOW = { visitDays: 14, wonDays: 21 };
const REACHED_STATUSES = ['sent', 'delivered', 'read', 'replied'];
const leadFrom = (byId, id) => (!byId || !id ? null : typeof byId.get === 'function' ? byId.get(id) : byId[id]) || null;
const within = (t, from, days) => { const x = Number(t) || 0; return x > from && x <= from + days * DAY_MS; };
const round2 = x => Math.round(x * 100) / 100;
const pct1 = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

// A site visit booked (or moved — a new time is a new yes) inside the window after `t0`.
function visitBookedWithin(l, t0, days) {
  if (!l) return false;
  if (l.reached && within(l.reached.visit_pending, t0, days)) return true;
  if (l.siteVisitAt || l.siteVisitStatus) return l.siteVisitStatus !== 'cancelled' && !!l.siteVisitAt && within(l.siteVisitSetAt, t0, days);
  const v = l.ai && l.ai.visit;
  return !!(v && v.at && v.status !== 'cancelled' && v.status !== 'none' && within(l.ai.at, t0, days));
}

/**
 * One campaign's scorecard.
 * @param campaign   the campaign document ({ createdAt, category, recipients })
 * @param leadsById  Map or plain object, lead id → lead (a recipient's key is its lead id)
 * @param now        ms
 * @param settings?  campaign settings, for the ₹ rates (estimateCost)
 * @returns {{ reached, replied, positive, neutral, negative, optOuts, visitsBooked, won, cost,
 *             costPerPositive: number|null, costPerVisit: number|null, counting: boolean }}
 */
export function campaignStats(campaign, leadsById, now, settings) {
  const c = campaign || {};
  const t0 = Number(c.createdAt) || 0;
  const res = { reached: 0, replied: 0, positive: 0, neutral: 0, negative: 0, optOuts: 0, visitsBooked: 0, won: 0,
    cost: 0, costPerPositive: null, costPerVisit: null, counting: (now || Date.now()) < t0 + STATS_WINDOW.wonDays * DAY_MS };
  for (const [key, r] of Object.entries(c.recipients || {})) {
    if (!r || !REACHED_STATUSES.includes(r.status)) continue;
    res.reached++;
    const action = r.reply && r.reply.action;
    if (r.reply || r.status === 'replied') { res.replied++; res[replySentiment(action)]++; }
    const l = r.manual ? null : leadFrom(leadsById, key);
    const stopped = action === 'optout' || action === 'marketing_optout'
      || !!(l && (within(l.waOptOutAt, t0, STATS_WINDOW.visitDays) || within(l.waMarketingOptOutAt, t0, STATS_WINDOW.visitDays)));
    if (stopped) res.optOuts++;
    if (visitBookedWithin(l, t0, STATS_WINDOW.visitDays)) res.visitsBooked++;
    if (l && l.reached && within(l.reached.won, t0, STATS_WINDOW.wonDays)) res.won++;
  }
  res.cost = estimateCost(res.reached, c.category, settings).total;
  res.costPerPositive = res.positive ? round2(res.cost / res.positive) : null;
  res.costPerVisit = res.visitsBooked ? round2(res.cost / res.visitsBooked) : null;
  return res;
}

/**
 * Which template, sent by which journey, earns its keep — one row per template × journey
 * (journey null for a campaign a person put together), the most-sent first. CSV exports reach
 * nobody through the API and are left out.
 * @returns {Array<{ template, journey: string|null, campaigns, sends, positivePct, optOutPct,
 *                   visitsPer100, costPerVisit: number|null, cost }>} — percentages to one decimal
 */
export function templateJourneyTable(campaigns, leadsById, now, settings) {
  const groups = new Map();
  for (const c of campaigns || []) {
    if (!c || !c.template) continue;
    const k = c.template + '\u0000' + (c.journey || '');
    if (!groups.has(k)) groups.set(k, { template: c.template, journey: c.journey || null, campaigns: 0, sends: 0, positive: 0, optOuts: 0, visits: 0, cost: 0 });
    const g = groups.get(k);
    const s = campaignStats(c, leadsById, now, settings);
    g.campaigns++; g.sends += s.reached; g.positive += s.positive; g.optOuts += s.optOuts; g.visits += s.visitsBooked; g.cost += s.cost;
  }
  return [...groups.values()].filter(g => g.sends).map(g => ({
    template: g.template, journey: g.journey, campaigns: g.campaigns, sends: g.sends,
    positivePct: pct1(g.positive, g.sends), optOutPct: pct1(g.optOuts, g.sends),
    visitsPer100: pct1(g.visits, g.sends), costPerVisit: g.visits ? round2(g.cost / g.visits) : null, cost: round2(g.cost)
  })).sort((a, b) => b.sends - a.sends || a.template.localeCompare(b.template));
}
