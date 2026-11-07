// ═══════════════════════════════════════════════════════════════════════
// META ADS LEADS — the rules, in one place.
//
// Meta's lead ads write each enquiry as a row in a Google Sheet, one sheet per ad and sometimes a
// tab per form. The team then types into the same rows (Assigned to, Rating, Remarks, Follow up
// 1/2/3…). This module reads those rows and says what they mean:
//
//   classifyColumns   which column is Meta's (lead id, time, ad, phone…), which is a form answer,
//                     which is the team's (assigned, rating, remarks, follow-ups, visit date), and
//                     which has data under no header at all
//   readTab           every row of a tab as an enquiry: who, when, from which ad, what they
//                     answered, what the team wrote
//   buildPlan         the enquiries of all connected sheets grouped into PEOPLE (by phone), per
//                     property: repeat enquiries (duplicates) with each date and time, people
//                     already in the CRM (their summary), and what a sync WOULD do — create, add
//                     the property, nothing — without doing any of it. A DUPLICATE is the same
//                     person in another row for the same property; the same person enquiring for
//                     two properties is two separate enquiries
//   analyse           counts per property: per day, per ad, per form, per answer, ratings,
//                     assigned, contacted, duplicates, already in the CRM
//
// What a sync does with a person (the rules agreed on 7 Nov 2026):
//   create   not in the CRM → one new lead (source Meta Ads), every property they asked about
//   attach   in the CRM → the new property added to their lead (one person = one lead)
//   revisit  in the CRM with this property, and a NEW row came for it after the lead was made →
//            the enquiry added, the lead marked "Revisited (duplicate ad lead)", priority for the agent
//   reopen   in the CRM but Won / Lost / On hold, and a new row came → reopened, marked duplicate,
//            the reopening kept in its history like any change
//   linked   in the CRM with every property already, nothing new → nothing to do
// A person with several rows for the same property is "revisited" whichever of these applies.
// Rows with a wrong or missing phone are imported too, flagged.
//
// Pure ES module (only crm-assets/pipeline.js besides): the CRM page (window.metaLeadsModel), the
// server (api/_meta-leads.js) and the tests all use it.
// ═══════════════════════════════════════════════════════════════════════

import { stageKindOf } from './pipeline.js';
export { STAGE_DEFS, LOST_REASONS, HOLD_REASONS } from './pipeline.js';

export const TZ = 'Asia/Kolkata';
const DAY = 86400000;

// ── Links ────────────────────────────────────────────────────────────────

/** A Google Sheets link (or a bare id) → { spreadsheetId, gid } — null when it is not one. */
export function parseSheetLink(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  const id = m ? m[1] : (/^[a-zA-Z0-9_-]{30,}$/.test(s) ? s : null);
  if (!id) return null;
  const g = s.match(/[#?&]gid=(\d+)/);
  return { spreadsheetId: id, gid: g ? Number(g[1]) : null };
}
export const sheetUrl = (spreadsheetId, gid) =>
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit${gid != null ? '#gid=' + gid : ''}`;

// ── Columns ──────────────────────────────────────────────────────────────

/** "Follow Up -1 " → "follow up 1"; "expected_area_(in_sq._ft.)" → "expected area in sq ft". */
export function normHeader(h) {
  return String(h == null ? '' : h).toLowerCase()
    .replace(/[_\-–—()?:.,/]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// The columns Meta writes itself, by their exact export name.
export const META_FIELDS = {
  id: 'id', created_time: 'createdTime', ad_id: 'adId', ad_name: 'ad', adset_id: 'adsetId', adset_name: 'adset',
  campaign_id: 'campaignId', campaign_name: 'campaign', form_id: 'formId', form_name: 'form', is_organic: 'organic',
  platform: 'platform', email: 'email', full_name: 'name', phone_number: 'phone', lead_status: 'leadStatus',
  inbox_url: 'inboxUrl'
};
// What a column can be. 'answer' = a question on the ad's form; the team's are the rest.
export const ROLES = {
  meta: 'Meta', answer: 'Form answer', assigned: 'Assigned to', rating: 'Rating', remarks: 'Remarks',
  followup: 'Follow-up', visit: 'Visit date', note: 'Note', ignore: 'Not used'
};
export const TEAM_ROLES = ['assigned', 'rating', 'remarks', 'followup', 'visit', 'note'];

/** What a typed (team) header means, or null when it is not one we know. */
export function teamRoleOf(header) {
  const h = normHeader(header);
  if (!h) return null;
  if (/^(assigned( to)?|agent|owner|handled by|assignee)$/.test(h)) return 'assigned';
  if (/\brating\b|^(lead )?(temperature|quality|score)$/.test(h)) return 'rating';
  if (/^follow ?ups?\b|^followups?\b|^f ?u ?\d+$/.test(h)) return 'followup';
  if (/\bvisit\b|\bsite\b.*\bdate\b|\bsheduled\b|\bscheduled\b/.test(h)) return 'visit';
  if (/^(remarks?|notes?|comments?|feedback|status notes?|call notes?)$/.test(h)) return 'remarks';
  return null;
}

/**
 * Every column of a tab, with what it means.
 *   headers  the first row
 *   rows     the data rows (to see which header-less columns actually hold something)
 *   overrides { [index]: role } chosen by a person in Setup — they win
 * → [{ index, header, key, role, field?, label, sample, filled }]
 */
export function classifyColumns(headers, rows, overrides) {
  const H = Array.isArray(headers) ? headers : [];
  const R = Array.isArray(rows) ? rows : [];
  const width = Math.max(H.length, ...R.map(r => (Array.isArray(r) ? r.length : 0)), 0);
  const out = [];
  for (let i = 0; i < width; i++) {
    const header = String(H[i] == null ? '' : H[i]).trim();
    const values = R.map(r => String((r && r[i]) == null ? '' : r[i]).trim()).filter(Boolean);
    const filled = values.length;
    const sample = values.slice(0, 3);
    const raw = header.toLowerCase();
    let role, field;
    if (META_FIELDS[raw]) { role = 'meta'; field = META_FIELDS[raw]; }
    else if (!header) role = filled ? 'note' : 'ignore';
    else role = teamRoleOf(header)
      // Meta writes a form's questions in snake_case, as typed by nobody ("what_is_your_budget?",
      // "expected_area_(in_sq._ft.)", "city"); a header a person typed has spaces or capitals.
      || (/^[a-z0-9_?().,'’–\-₹]+$/.test(header) ? 'answer' : 'note');
    const ov = overrides && overrides[i];
    if (ov && ROLES[ov] && !(role === 'meta' && ov !== 'ignore')) { role = ov; field = undefined; }
    const label = role === 'answer' ? answerLabel(header) : (header || `Column ${colLetter(i)} (no header)`);
    out.push({ index: i, header, key: normHeader(header) || `col_${colLetter(i)}`, role, ...(field ? { field } : {}), label, sample, filled });
  }
  return out;
}

/** "what_is_your_budget?" → "What is your budget?" */
export function answerLabel(h) {
  const s = String(h || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
/** "1_cr_to_2_cr" → "1 cr to 2 cr"; "₹70–₹100" stays. */
export function answerValue(v) {
  return String(v == null ? '' : v).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

export function colLetter(i) {
  let n = i + 1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** The problems a tab's layout has, in words — shown in Setup. */
export function columnIssues(cols) {
  const has = f => cols.some(c => c.role === 'meta' && c.field === f);
  const issues = [];
  if (!has('id')) issues.push('No "id" column — this does not look like a Meta lead export');
  if (!has('phone')) issues.push('No phone_number column — leads can only be matched by email');
  if (!has('createdTime')) issues.push('No created_time column — enquiry times will be missing');
  const unnamed = cols.filter(c => !c.header && c.role !== 'ignore');
  if (unnamed.length) issues.push(`${unnamed.length} column${unnamed.length > 1 ? 's hold' : ' holds'} data with no header (${unnamed.map(c => colLetter(c.index)).join(', ')}) — read as notes until named`);
  return issues;
}

// ── Values ───────────────────────────────────────────────────────────────

/** Same canonical phone as the CRM's phoneKey() (crm-assets/app.js) — Meta's "p:+91…" included. */
export function phoneKey(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1);
  return digits;
}
/** A normal Indian mobile once canonical: 91 + 10 digits starting 6–9. */
export const isValidMobile = key => /^91[6-9]\d{9}$/.test(String(key || ''));
/** "+91 95855 09459" for display; anything unusual as Meta gave it. */
export function displayPhone(raw) {
  const k = phoneKey(raw);
  if (isValidMobile(k)) return '+91 ' + k.slice(2, 7) + ' ' + k.slice(7);
  return String(raw || '').replace(/^p:/, '').trim();
}

/** Meta's "2026-10-15T01:37:51-05:00" (or a plain date a person typed) → ms, or null. */
export function parseTime(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
  // A person's "27-8-2026" / "01/09/2026" — day first, as typed in India.
  const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const t = Date.UTC(y, Number(m[2]) - 1, Number(m[1]), 4, 30); // 10:00 IST
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
const istParts = t => {
  const d = new Date(t + 5.5 * 3600000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "15 Oct 2026, 12:07 pm" in India time. */
export function fmtWhen(t) {
  if (t == null) return '—';
  const p = istParts(t), h12 = p.h % 12 || 12;
  return `${p.d} ${MONTHS[p.m]} ${p.y}, ${h12}:${String(p.mi).padStart(2, '0')} ${p.h < 12 ? 'am' : 'pm'}`;
}
/** "2026-10-15" — the India-time calendar day, for grouping. */
export function dayKey(t) {
  const p = istParts(t);
  return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
export const fmtDay = key => { const [y, m, d] = key.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };

/**
 * The lead rating as the team writes it in the ad sheets: 1 to 5 (5 = the best lead, 1 = the
 * weakest). "4", "4 ", "4/5", "3.5" are read as numbers; a word someone typed instead is placed on
 * the same scale (hot 5, warm 3, cold 1). → 1…5, or null.
 */
export function parseRating(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^\d+(\.\d+)?/);
  const n = m ? Number(m[0]) : NaN;
  if (Number.isFinite(n) && n >= 1 && n <= 5) return Math.round(n);
  if (/hot|very high/.test(s)) return 5;
  if (/high/.test(s)) return 4;
  if (/warm|medium|mid/.test(s)) return 3;
  if (/low/.test(s)) return 2;
  if (/cold|not/.test(s)) return 1;
  return null;
}
export const RATINGS = [5, 4, 3, 2, 1];
export const RATING_LABEL = { 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' };
/** The rating band a report counts as strong: 4 and 5. */
export const isTopRated = r => r >= 4;

/**
 * The team member a typed name means: "Swami" → swami@threepin.in. Matched on the part of the
 * email before "@", or its first word ("thirumal.r@…" for "Thirumal"). null when it is no one.
 */
export function matchAgent(raw, roster) {
  const s = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ');
  if (!s) return null;
  const list = (roster || []).map(e => String(e).toLowerCase());
  const handle = e => e.split('@')[0];
  const words = e => handle(e).split(/[._-]+/);
  if (list.includes(String(raw).trim().toLowerCase())) return String(raw).trim().toLowerCase();
  // The whole name: "raj m" ↔ raj.m@…, "swami" ↔ swami@…
  const whole = list.filter(e => words(e).join(' ') === s || handle(e) === s.replace(/ /g, ''));
  if (whole.length === 1) return whole[0];
  // Only the first name: only when exactly one teammate has it ("Raj" with raj.k@ and raj.m@ is no one).
  const first = s.split(' ')[0];
  const byFirst = list.filter(e => words(e)[0] === first);
  if (byFirst.length === 1 && s.split(' ').length === 1) return byFirst[0];
  const byStart = list.filter(e => first.length >= 4 && handle(e).startsWith(first));
  return byStart.length === 1 && s.split(' ').length === 1 ? byStart[0] : null;
}

// ── Reading a tab ────────────────────────────────────────────────────────

/**
 * Every row of a tab as an enquiry.
 *   tab: { sourceId, spreadsheetId, sheetTitle, title, gid, propertyCode, values, overrides }
 * → { cols, issues, enquiries: [{ key, metaId, row, at, name, phone, phoneKey, email, platform, ad,
 *        adset, campaign, form, organic, answers:[{label,value}], team:{assigned, rating, remarks:[],
 *        followups:[], visit, notes:[]}, where }] }
 */
export function readTab(tab) {
  const values = Array.isArray(tab.values) ? tab.values : [];
  const headers = values[0] || [];
  const rows = values.slice(1);
  const cols = classifyColumns(headers, rows, tab.overrides);
  const metaCol = f => cols.find(c => c.role === 'meta' && c.field === f);
  const cell = (r, c) => (c ? String(r[c.index] == null ? '' : r[c.index]).trim() : '');
  const where = { sourceId: tab.sourceId || '', spreadsheetId: tab.spreadsheetId || '', sheetTitle: tab.sheetTitle || '', tab: tab.title || '', gid: tab.gid == null ? null : tab.gid, tag: tab.tag || '' };
  const enquiries = [];
  rows.forEach((r, i) => {
    if (!Array.isArray(r) || !r.some(v => String(v == null ? '' : v).trim())) return;
    const metaId = cell(r, metaCol('id'));
    const name = cell(r, metaCol('name'));
    const phoneRaw = cell(r, metaCol('phone'));
    const email = cell(r, metaCol('email'));
    if (!metaId && !name && !phoneRaw && !email) return;   // a stray note below the data
    const team = { assigned: '', rating: null, ratingRaw: '', remarks: [], followups: [], visit: '', notes: [] };
    const answers = [];
    for (const c of cols) {
      const v = cell(r, c);
      if (!v) continue;
      if (c.role === 'answer') answers.push({ label: c.label, value: answerValue(v) });
      else if (c.role === 'assigned') team.assigned = team.assigned || v;
      else if (c.role === 'rating') { team.ratingRaw = team.ratingRaw || v; team.rating = team.rating || parseRating(v); }
      else if (c.role === 'remarks') team.remarks.push({ label: c.label, text: v });
      else if (c.role === 'followup') team.followups.push({ label: c.label, text: v });
      else if (c.role === 'visit') team.visit = team.visit || v;
      else if (c.role === 'note') team.notes.push({ label: c.label, text: v });
    }
    const pk = phoneKey(phoneRaw);
    enquiries.push({
      key: metaId || `${where.spreadsheetId}:${where.tab}:${i + 2}`,
      metaId, row: i + 2, at: parseTime(cell(r, metaCol('createdTime'))),
      name, phone: phoneRaw.replace(/^p:/, ''), phoneKey: pk, phoneOk: isValidMobile(pk), email,
      platform: cell(r, metaCol('platform')), ad: cell(r, metaCol('ad')), adset: cell(r, metaCol('adset')),
      campaign: cell(r, metaCol('campaign')), form: cell(r, metaCol('form')), organic: cell(r, metaCol('organic')) === 'true',
      answers, team, propertyCode: tab.propertyCode || '', where
    });
  });
  return { cols, issues: columnIssues(cols), enquiries };
}

/**
 * The "contacted" signal: something only a conversation produces — a remark, a follow-up, a note,
 * a visit date or a rating. Being assigned to an agent is NOT contact (a lead bulk-assigned this
 * morning and never called must still show as not contacted).
 */
const wroteOn = t => !!(t && (t.ratingRaw || t.remarks.length || t.followups.length || t.visit || t.notes.length));
export const teamWrote = e => wroteOn(e.team) || (e.alsoIn || []).some(a => wroteOn(a.team));

// ── The plan ─────────────────────────────────────────────────────────────

/** A tab's key: "<spreadsheetId>:<gid>" (an enquiry's: from its where). */
export const tabKey = t => `${t.spreadsheetId}:${t.gid}`;
const inTab = (e, key) => `${e.where.spreadsheetId}:${e.where.gid}` === key;

/** The key a person is known by: their phone, else their email, else the Meta lead id. */
export function personKey(e) {
  if (e.phoneKey && e.phoneKey.length >= 10) return 'p:' + e.phoneKey;
  if (e.email) return 'e:' + e.email.toLowerCase();
  return 'l:' + e.key;
}

/**
 * Everything a sync would do, decided and not done.
 *   tabs       [{ ...tab, values }] as readTab takes them (all connected tabs)
 *   crmLeads   the CRM's leads (in memory on the page)
 *   roster     the team's emails
 *   properties { [code]: name }
 *   stages     [{ id, name }]
 * → { tabs: [{ id, sheetTitle, title, propertyCode, cols, issues, count }], properties: [ … ],
 *     people: [ … ], issues: [ … ] }
 */
export function buildPlan({ tabs, crmLeads, roster, properties, stages } = {}) {
  const stageName = id => ((stages || []).find(s => s.id === id) || {}).name || id || '';
  const crmByPhone = new Map(), crmByEmail = new Map();
  for (const l of crmLeads || []) {
    const k = phoneKey(l.phone);
    if (k && !crmByPhone.has(k)) crmByPhone.set(k, l);
    const em = String(l.email || '').trim().toLowerCase();
    if (em && !crmByEmail.has(em)) crmByEmail.set(em, l);
  }

  const tabOut = [];
  const seen = new Map();          // Meta lead id → the enquiry kept (a copied tab repeats rows)
  const all = [];
  for (const t of tabs || []) {
    const r = readTab(t);
    let copies = 0;
    for (const e of r.enquiries) {
      if (e.metaId && seen.has(e.metaId)) {
        const kept = seen.get(e.metaId);
        kept.alsoIn = (kept.alsoIn || []).concat([{ ...e.where, row: e.row, team: e.team, sameTab: kept.where.spreadsheetId === e.where.spreadsheetId && kept.where.gid === e.where.gid }]);
        for (const f of ['assigned', 'ratingRaw', 'visit']) if (!kept.team[f] && e.team[f]) kept.team[f] = e.team[f];
        if (!kept.team.rating && e.team.rating) kept.team.rating = e.team.rating;
        copies++;
        continue;
      }
      if (e.metaId) seen.set(e.metaId, e);
      all.push(e);
    }
    tabOut.push({ id: tabKey(t), spreadsheetId: t.spreadsheetId, gid: t.gid, sheetTitle: t.sheetTitle, title: t.title,
      propertyCode: t.propertyCode, tag: t.tag || '', remark: t.remark || '', cols: r.cols, issues: r.issues, count: r.enquiries.length, copies });
  }

  // People: every enquiry of the same phone (or email) is one person, across tabs and properties.
  const byPerson = new Map();
  for (const e of all) {
    const k = personKey(e);
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k).push(e);
  }
  const people = [];
  for (const [key, list] of byPerson) {
    list.sort((a, b) => (a.at || 0) - (b.at || 0));
    const last = list[list.length - 1];
    const pick = f => { for (let i = list.length - 1; i >= 0; i--) if (list[i][f]) return list[i][f]; return ''; };
    const latestTeam = f => { for (let i = list.length - 1; i >= 0; i--) { const v = list[i].team[f]; if (v != null && v !== '') return v; } return null; };
    const assignedRaw = latestTeam('assigned') || '';
    const agent = assignedRaw ? matchAgent(assignedRaw, roster) : null;
    const notes = [];
    for (const e of list) {
      const src = `${e.where.sheetTitle} › ${e.where.tab}`;
      const all2 = [e, ...(e.alsoIn || []).map(a => ({ team: a.team, where: a }))];
      for (const x of all2) {
        const s2 = `${x.where.sheetTitle} › ${x.where.tab}`;
        for (const n of [...x.team.remarks, ...x.team.followups, ...x.team.notes]) {
          if (!notes.some(o => o.text === n.text)) notes.push({ label: n.label, text: n.text, where: s2 || src });
        }
        if (x.team.visit && !notes.some(o => o.text === x.team.visit)) notes.push({ label: 'Visit date', text: x.team.visit, where: s2 });
      }
    }
    const codes = [...new Set(list.map(e => e.propertyCode).filter(Boolean))];
    const pk = list.find(e => e.phoneKey)?.phoneKey || '';
    const em = (list.find(e => e.email) || {}).email || '';
    const crm = (pk && crmByPhone.get(pk)) || (em && crmByEmail.get(em.toLowerCase())) || null;
    const crmCodes = crm ? (Array.isArray(crm.propertyCodes) ? crm.propertyCodes : []) : [];
    const issues = [];
    if (!pk) issues.push('No phone number');
    else if (!isValidMobile(pk)) issues.push(`Phone looks wrong (${displayPhone(list.find(e => e.phoneKey).phone)})`);
    if (assignedRaw && !agent) issues.push(`"${assignedRaw}" is not on the team list`);
    // Duplicate = more than one row for the same property. Several properties ≠ duplicate.
    const dupCodes = codes.filter(c => list.filter(e => e.propertyCode === c).length > 1);
    // For a CRM lead: the rows that came AFTER it was made (half a day's slack — the lead is often
    // typed in by hand from the very same enquiry) are new enquiries; older ones are where it came from.
    const crmKind = crm ? stageKindOf((stages || []).find(s => s.id === crm.stageId) || null) : null;
    const closed = crmKind === 'won' || crmKind === 'lost' || crmKind === 'hold';
    const since = crm ? (Number(crm.createdAt) || 0) + DAY / 2 : 0;
    const newRows = crm ? list.filter(e => e.at && e.at > since) : list;
    const againForOwn = crm ? newRows.filter(e => crmCodes.includes(e.propertyCode)) : [];
    let action;
    if (!crm) action = 'create';
    else if (closed && newRows.length) action = 'reopen';
    else if (codes.some(c => !crmCodes.includes(c))) action = 'attach';
    else if (againForOwn.length) action = 'revisit';
    else action = 'linked';
    // The properties enquired about again: a second row here, or a new row on the lead's own property.
    const revisitCodes = [...new Set([...dupCodes, ...againForOwn.map(e => e.propertyCode)])];
    const revisited = revisitCodes.length > 0;
    const priority = revisited || action === 'reopen';
    people.push({
      key, name: pick('name'), phone: pick('phone'), phoneKey: pk, phoneOk: isValidMobile(pk), email: em,
      enquiries: list, firstAt: list[0].at, lastAt: last.at, properties: codes,
      dupCodes, duplicate: dupCodes.length > 0, multiProperty: codes.length > 1,
      revisited, revisitCodes, priority, newRows: newRows.length,
      team: { assignedRaw, agent, rating: latestTeam('rating'), ratingRaw: latestTeam('ratingRaw') || '', notes, contacted: list.some(teamWrote) },
      crm: crm ? {
        id: crm.id, name: crm.name || '', stage: stageName(crm.stageId), stageId: crm.stageId || '', agent: crm.assignedAgent || '',
        propertyCodes: crmCodes, propertyInterest: crm.propertyInterest || '', budget: crm.budget || '', source: crm.source || '',
        createdAt: crm.createdAt || null, updatedAt: crm.updatedAt || null, followUpAt: crm.followUpAt || null,
        summary: crm.aiSummary || (crm.ai && crm.ai.line) || '', lostReason: crm.lostReason || '', kind: crmKind || '', closed
      } : null,
      action, missingCodes: crm ? codes.filter(c => !crmCodes.includes(c)) : codes, issues
    });
  }
  people.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

  // Per property.
  const codes = [...new Set([...tabOut.map(t => t.propertyCode), ...people.flatMap(p => p.properties)].filter(Boolean))];
  const props = codes.map(code => {
    const ppl = people.filter(p => p.properties.includes(code));
    const enq = ppl.flatMap(p => p.enquiries.filter(e => e.propertyCode === code));
    return {
      code, name: (properties && properties[code]) || '',
      tabs: tabOut.filter(t => t.propertyCode === code),
      enquiries: enq.length, people: ppl.length,
      repeats: ppl.filter(p => p.enquiries.filter(e => e.propertyCode === code).length > 1).length,
      alsoOther: ppl.filter(p => p.properties.length > 1).length,
      inCrm: ppl.filter(p => p.crm).length,
      create: ppl.filter(p => p.action === 'create').length,
      attach: ppl.filter(p => p.action === 'attach').length,
      revisit: ppl.filter(p => p.action === 'revisit').length,
      reopen: ppl.filter(p => p.action === 'reopen').length,
      priority: ppl.filter(p => isPriorityFor(p, code)).length,
      problems: ppl.filter(p => p.issues.length).length
    };
  });

  const issues = [];
  for (const t of tabOut) for (const i of t.issues) issues.push({ where: `${t.sheetTitle} › ${t.title}`, text: i });
  for (const t of tabOut) if (t.copies) issues.push({ where: `${t.sheetTitle} › ${t.title}`, text: `${t.copies} row${t.copies > 1 ? 's repeat' : ' repeats'} a Meta lead id already read (copied tab, or the same row twice) — counted once` });
  return { tabs: tabOut, properties: props, people, issues, enquiries: all.length };
}

/** Priority for a property's view (or overall when code is empty): revisited for it, or reopening. */
export function isPriorityFor(p, code) {
  if (!code) return p.priority;
  return p.action === 'reopen' || p.revisitCodes.includes(code);
}

/**
 * The duplicates: the same person enquiring for the SAME property in more than one row. The same
 * person enquiring for two different properties is two enquiries, not a duplicate (see otherCodes).
 * One entry per person and property, newest repeat first, each row in time order.
 */
export function duplicatesOf(plan, code) {
  const out = [];
  for (const p of plan.people) {
    for (const c of p.dupCodes) {
      if (code && c !== code) continue;
      out.push({ ...p, code: c, rows: p.enquiries.filter(e => e.propertyCode === c), otherCodes: p.properties.filter(x => x !== c) });
    }
  }
  return out.sort((a, b) => ((b.rows[b.rows.length - 1] || {}).at || 0) - ((a.rows[a.rows.length - 1] || {}).at || 0));
}

// ── Analysis ─────────────────────────────────────────────────────────────

const groupBy = (list, f) => { const m = new Map(); for (const x of list) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return [...m.entries()]; };
const tally = (list, f) => {
  const m = new Map();
  for (const x of list) { const k = f(x); if (k == null || k === '') continue; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n || String(a.label).localeCompare(String(b.label)));
};

/**
 * Counts for one property (or all when code is empty), or for one tab of it (tab = its key).
 * now: for the "last N days" series.
 */
export function analyse(plan, code, now = Date.now(), days = 30, tab = '') {
  let ppl = code ? plan.people.filter(p => p.properties.includes(code)) : plan.people;
  let enq = ppl.flatMap(p => (code ? p.enquiries.filter(e => e.propertyCode === code) : p.enquiries));
  if (tab) { ppl = ppl.filter(p => p.enquiries.some(e => inTab(e, tab))); enq = enq.filter(e => inTab(e, tab)); }
  const series = [];
  const byDay = new Map(tally(enq.filter(e => e.at), e => dayKey(e.at)).map(x => [x.label, x.n]));
  const firstAt = Math.min(...enq.map(e => e.at || Infinity));
  const span = Number.isFinite(firstAt) ? Math.min(days, Math.ceil((now - firstAt) / DAY) + 1) : 0;
  for (let i = span - 1; i >= 0; i--) { const k = dayKey(now - i * DAY); series.push({ day: k, label: fmtDay(k), n: byDay.get(k) || 0 }); }
  const questions = new Map();
  for (const e of enq) for (const a of e.answers) {
    if (!questions.has(a.label)) questions.set(a.label, []);
    questions.get(a.label).push(a.value);
  }
  const ratings = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0, none: 0 };
  for (const p of ppl) ratings[p.team.rating || 'none']++;
  return {
    enquiries: enq.length, people: ppl.length,
    repeats: ppl.filter(p => (code ? p.dupCodes.includes(code) : p.duplicate)).length,
    multiProperty: ppl.filter(p => p.multiProperty).length,
    priority: ppl.filter(p => isPriorityFor(p, code)).length,
    reopen: ppl.filter(p => p.action === 'reopen').length,
    inCrm: ppl.filter(p => p.crm).length,
    contacted: ppl.filter(p => p.team.contacted).length,
    assigned: ppl.filter(p => p.team.assignedRaw).length,
    last7: enq.filter(e => e.at && e.at > now - 7 * DAY).length,
    series,
    byAd: tally(enq, e => e.ad || '(no ad name)'),
    byForm: tally(enq, e => `${e.where.sheetTitle} › ${e.where.tab}`),
    byPlatform: tally(enq, e => ({ ig: 'Instagram', fb: 'Facebook' }[e.platform] || e.platform || 'Unknown')),
    byAgent: tally(ppl, p => (p.team.agent || p.team.assignedRaw || 'Not assigned')),
    byStage: tally(ppl.filter(p => p.crm), p => p.crm.stage || '—'),
    ratings,
    questions: [...questions.entries()].map(([label, vals]) => ({ label, answers: tally(vals, v => v) })),
    problems: ppl.filter(p => p.issues.length).length,
    // The admin's view of the team: per agent, how many they hold and how far they got.
    agents: groupBy(ppl, p => p.team.agent || p.team.assignedRaw || '').map(([agent, list]) => ({
      agent, people: list.length,
      contacted: list.filter(p => p.team.contacted).length,
      untouched: list.filter(p => !p.team.contacted).length,
      top: list.filter(p => p.team.rating >= 4).length, mid: list.filter(p => p.team.rating === 3).length, low: list.filter(p => p.team.rating && p.team.rating <= 2).length,
      rated: list.filter(p => p.team.rating).length,
      priority: list.filter(p => isPriorityFor(p, code)).length
    })).sort((a, b) => (a.agent ? 0 : 1) - (b.agent ? 0 : 1) || b.people - a.people),
    // Which ad brings the better leads: per ad, the people it brought, how many are hot, how many reached.
    adQuality: groupBy(enq, e => e.ad || '(no ad name)').map(([ad, rows]) => {
      const who = [...new Set(rows.map(e => ppl.find(p => p.enquiries.includes(e))).filter(Boolean))];
      const rated = who.filter(p => p.team.rating);
      return { ad, enquiries: rows.length, people: who.length, top: who.filter(p => p.team.rating >= 4).length,
        threePlus: who.filter(p => p.team.rating >= 3).length, low: who.filter(p => p.team.rating && p.team.rating <= 2).length,
        contacted: who.filter(p => p.team.contacted).length, rated: rated.length,
        avg: rated.length ? Math.round(10 * rated.reduce((n, p) => n + p.team.rating, 0) / rated.length) / 10 : null };
    }).sort((a, b) => b.enquiries - a.enquiries),
    // Each sheet's tab, side by side (for the property, or all).
    byTab: plan.tabs.filter(t => !code || t.propertyCode === code).map(t => {
      const rows = plan.people.flatMap(p => p.enquiries.filter(e => inTab(e, t.id)).map(e => ({ e, p })));
      const who = [...new Set(rows.map(x => x.p))];
      const at = rows.map(x => x.e.at).filter(Boolean);
      return {
        key: t.id, spreadsheetId: t.spreadsheetId, gid: t.gid, sheetTitle: t.sheetTitle, title: t.title, tag: t.tag, remark: t.remark, propertyCode: t.propertyCode,
        enquiries: rows.length, people: who.length,
        last7: at.filter(x => x > now - 7 * DAY).length,
        contacted: who.filter(p => p.enquiries.some(e => inTab(e, t.id) && teamWrote(e))).length,
        duplicates: who.filter(p => p.dupCodes.includes(t.propertyCode)).length,
        inCrm: who.filter(p => p.crm).length,
        topAd: (tally(rows.map(x => x.e), e => e.ad)[0] || {}).label || '',
        firstAt: at.length ? Math.min(...at) : null, lastAt: at.length ? Math.max(...at) : null
      };
    })
  };
}

// ── Writing back to the sheet ────────────────────────────────────────────

const DEFAULT_HEADER = { assigned: 'Assigned to', rating: 'Rating', remarks: 'Remarks', visit: 'Visit date', note: 'Notes' };
export const MAX_COLS = 52;   // A…AZ, as far as a tab is read

/**
 * A row's notes in the order the team writes them: the (first) Remarks column, then every Follow-up
 * column left to right. cols: classifyColumns' list. → [{ index, header, label, role }]
 */
export function noteChain(cols) {
  const by = role => (cols || []).filter(c => c && c.role === role).sort((a, b) => a.index - b.index);
  return by('remarks').slice(0, 1).concat(by('followup'));
}

/**
 * Which cells an edit writes, decided against the tab as it is NOW (values: its rows as read just
 * before writing). Never guesses a row: each edit names its lead by Meta's lead id, found again in
 * the id column (so a sorted or filtered sheet is still written in the right row).
 *   edits: [{ metaId, field: 'assigned'|'rating'|'remarks'|'followup'|'note'|'visit', col?, next?,
 *             value, from? }] or { field: 'header', header } to add a column
 *   field 'log' → the next note: Remarks if empty, else the cell after the last note written
 *   (Follow up 1, 2, …), or a new "Follow up N" column past the last.
 *   field 'followup' with next:true → the first EMPTY follow-up cell of that row, or a new
 *   "Follow up N" column. A missing Assigned to / Rating / Remarks column is added.
 *   from: what the person saw in the cell — if the sheet now says something else, the edit is
 *   refused (a conflict), never written over.
 * → { updates: [{ range, value }], applied: [{ metaId, row, col, header, value }], conflicts: [...],
 *     added: [{ col, header }], errors: [...] }
 */
export function planSheetWrite({ values, overrides, edits }) {
  const V = Array.isArray(values) ? values : [];
  const headers = (V[0] || []).map(h => String(h == null ? '' : h));
  const rows = V.slice(1);
  const cols = classifyColumns(headers, rows, overrides);
  let width = Math.max(headers.length, ...rows.map(r => (Array.isArray(r) ? r.length : 0)), 0);
  // Trailing empty header cells with no data are free for a new column.
  while (width > 0 && !String(headers[width - 1] || '').trim() && !rows.some(r => String((r || [])[width - 1] == null ? '' : r[width - 1]).trim())) width--;
  const idCol = (cols.find(c => c.role === 'meta' && c.field === 'id') || {}).index;
  const out = { updates: [], applied: [], conflicts: [], added: [], errors: [] };
  const written = new Map();   // "r:c" → value written in this batch
  const cell = (ri, c) => { const k = ri + ':' + c; if (written.has(k)) return written.get(k); return String(((rows[ri] || [])[c]) == null ? '' : rows[ri][c]).trim(); };
  const addCol = (header) => {
    if (width >= MAX_COLS) { out.errors.push(`No room for a new column "${header}" (the tab is read up to AZ)`); return null; }
    const c = width++;
    headers[c] = header;
    cols.push({ index: c, header, role: teamRoleOf(header) || 'note', label: header });
    out.added.push({ col: c, header });
    out.updates.push({ range: colLetter(c) + '1', value: header });
    return c;
  };
  const byRole = role => cols.filter(c => c.role === role).sort((a, b) => a.index - b.index);
  for (const e of (Array.isArray(edits) ? edits : []).slice(0, 1000)) {
    if (!e) continue;
    if (e.field === 'header') {
      const h = String(e.header || '').trim().slice(0, 60);
      if (!h) continue;
      if (headers.some(x => x.trim().toLowerCase() === h.toLowerCase())) { out.errors.push(`There is already a column "${h}"`); continue; }
      addCol(h);
      continue;
    }
    const metaId = String(e.metaId || '').trim();
    if (idCol == null) { out.errors.push('This tab has no "id" column — rows cannot be found safely'); break; }
    const ri = metaId ? rows.findIndex(r => String(((r || [])[idCol]) == null ? '' : r[idCol]).trim() === metaId) : -1;
    if (ri < 0) { out.conflicts.push({ metaId, reason: 'This lead is no longer in the sheet' }); continue; }
    let c = null;
    if (e.col != null && e.col !== '') {
      c = Number(e.col);
      const known = cols.find(x => x.index === c);
      // Only the team's own columns, inside what was read — never Meta's data or its form answers.
      if (!Number.isInteger(c) || c < 0 || c >= width || !known) { out.errors.push(`Column ${Number.isInteger(c) && c >= 0 ? colLetter(c) : e.col} is outside the sheet as read`); continue; }
      if (!TEAM_ROLES.includes(known.role)) { out.errors.push(`Column ${colLetter(c)} (${known.header || 'no header'}) is ${known.role === 'meta' ? 'Meta\'s own' : 'a form answer'} and is not written`); continue; }
      // The column must still be the one the person saw — a column inserted since the read moves it.
      if (e.header !== undefined && String(e.header).trim().toLowerCase() !== String(headers[c] || '').trim().toLowerCase()) {
        out.conflicts.push({ metaId, col: c, header: headers[c] || '', reason: 'The sheet\'s columns changed since it was read' });
        continue;
      }
    } else if (e.field === 'followup' && e.next) {
      const f = byRole('followup');
      const empty = f.find(x => !cell(ri, x.index));
      let n = f.length + 1;
      while (headers.some(x => x.trim().toLowerCase() === `follow up ${n}`)) n++;
      c = empty ? empty.index : addCol(`Follow up ${n}`);
    } else if (e.field === 'log') {
      // The next note in the row's chain — Remarks, then Follow up 1, 2, 3… — in the cell after the
      // last one written, so the notes run on column by column. Past the last: a new "Follow up N".
      const chain = noteChain(cols);
      let last = -1;
      chain.forEach((x, i) => { if (cell(ri, x.index)) last = i; });
      if (last + 1 < chain.length) c = chain[last + 1].index;
      else if (!byRole('remarks').length && last < 0) c = addCol('Remarks');
      else {
        let n = byRole('followup').length + 1;
        while (headers.some(x => x.trim().toLowerCase() === `follow up ${n}`)) n++;
        c = addCol(`Follow up ${n}`);
      }
    } else if (e.field === 'note') {
      out.errors.push('Notes are written into a named column');
      continue;
    } else if (DEFAULT_HEADER[e.field] || e.field === 'followup') {
      const f = byRole(e.field);
      c = f.length ? f[0].index : addCol(DEFAULT_HEADER[e.field] || 'Follow up 1');
    }
    if (c == null) continue;
    const now = cell(ri, c);
    if (e.from !== undefined && now !== String(e.from == null ? '' : e.from).trim()) {
      out.conflicts.push({ metaId, row: ri + 2, col: c, header: headers[c] || '', was: String(e.from || ''), now, reason: 'Changed in the sheet since it was read' });
      continue;
    }
    const value = String(e.value == null ? '' : e.value).slice(0, 5000);
    if (value === now) continue;
    written.set(ri + ':' + c, value);
    out.updates.push({ range: colLetter(c) + (ri + 2), value });
    out.applied.push({ metaId, row: ri + 2, col: c, header: (headers[c] || '').trim(), value });
  }
  return out;
}
