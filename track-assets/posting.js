// ═══════════════════════════════════════════════════════════════════════
// POSTING TRACKER — what "posted" means for one property, in one place.
//
// Pure, dependency-free ES module (same shape as track-pipeline.js), so the
// page, the CSV export and the tests all read the same rules.
//
// One document per property (or per repost round) in `postTracker`, under a random id — the
// collection is shared by every tenant, so a property code is never the key:
//
//   propertyCode, title, location, details, photosLink      (what media shared)
//   channels: { igStory|igReel|fbReel|yt: { status, at, url, liveAt } }
//   brochure: { done, at, by }                              (admin confirms)
//   reference, plannedDate, weekOf   a row can START as just a reference from the weekly plan
//                                   ("Lux49 4Bhk", Monday) — no code, no title, no photos. The code, brochure and
//                                   dashboard record come later; the row is the same row throughout.
//   repostOf                        a second (or later) round of posts for a property already tracked:
//                                   its own schedule and links; brochure, photos, 99 Acres, website and
//                                   the dashboard link stay on the original row and are not asked again.
//   propertyId                      the Property dashboard record it is linked to, if any.
//                                   Linking is optional and can happen any time — an unlinked
//                                   property is a pending item, not an error.
//   acres99, website: { status: 'pending'|'posted'|'na', url, at }
//
// Every channel is independent: a Story can be Scheduled while the Reel is
// still "Yet to schedule" and YouTube is N/A.
//
// "Posted live" is never inferred from the clock. A scheduled time that has
// passed shows as DUE — somebody opens the post, copies its link and confirms.
// Confirming without a link is allowed but stays flagged until one is pasted.
// ═══════════════════════════════════════════════════════════════════════

import { cleanTags } from './tags.js';

export const CHANNELS = [
  { key: 'igStory', label: 'Insta Story' },
  { key: 'igReel', label: 'Insta Reel' },
  { key: 'fbReel', label: 'Facebook Reel' },
  { key: 'yt', label: 'YouTube' }
];
export const CHANNEL_KEYS = CHANNELS.map(c => c.key);

export const STATUS = { NA: 'na', YET: 'yet', SCHEDULED: 'scheduled', LIVE: 'live' };
export const STATUS_LABEL = { na: 'N/A', yet: 'Yet to schedule', scheduled: 'Scheduled', live: 'Posted live' };
export const STATUS_ORDER = ['yet', 'scheduled', 'live', 'na'];

// 99 Acres and the 3 PIN website are one-off listings, not timed posts.
export const LISTINGS = [
  { key: 'acres99', label: '99 Acres' },
  { key: 'website', label: '3 PIN website' }
];
export const LISTING_STATUS = { PENDING: 'pending', POSTED: 'posted', NA: 'na' };
export const LISTING_LABEL = { pending: 'Not posted', posted: 'Posted', na: 'N/A' };

const str = v => (v == null ? '' : String(v).trim());
export const isUrl = v => /^https?:\/\/\S+$/i.test(str(v));

// People paste "instagram.com/reel/abc" as often as the full address. A bare domain gets
// https:// added; anything else that is not a web address is left for the caller to refuse.
export function cleanUrl(v) {
  const u = str(v);
  if (u && !/^[a-z][a-z0-9+.-]*:/i.test(u) && /^[^\s/]+\.[^\s/]{2,}(\/\S*)?$/.test(u)) return 'https://' + u;
  return u;
}
export const validUrl = v => !str(v) || isUrl(cleanUrl(v));
// A link brought in from elsewhere (the dashboard) is kept only if it is a web address — a
// "javascript:" value must never end up behind a clickable link.
export const webLink = v => { const u = cleanUrl(v); return isUrl(u) ? u : ''; };
const BAD_URL = 'That does not look like a web link — paste the full address.';

// For comparing codes: "LUX 049", "lux-049" and "LUX049" are the same property.
export const codeKey = code => str(code).toUpperCase().replace(/[^A-Z0-9]+/g, '');

// A code's safe form. Only used to check a code has letters or digits in it — it is NOT the row id.
export function trackerId(code) {
  const c = str(code).toUpperCase().replace(/[^A-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return c || '';
}
// Row ids are random: two tenants (or two rounds of one property) can never land on one document.
export function newTrackerId(now) {
  return 'pt_' + (Number(now) || Date.now()).toString(36) + Math.random().toString(36).slice(2, 10);
}

export function normalizeChannel(c) {
  const s = c && STATUS_ORDER.includes(c.status) ? c.status : STATUS.YET;
  return {
    status: s,
    at: s === STATUS.SCHEDULED || s === STATUS.LIVE ? (Number(c && c.at) || 0) : 0,
    url: str(c && c.url),
    liveAt: s === STATUS.LIVE ? (Number(c && c.liveAt) || 0) : 0,
    day: Number(c && c.day) || 0          // the day the plan says it goes out, before a time is fixed
  };
}
export function normalizeListing(l) {
  const s = l && Object.values(LISTING_STATUS).includes(l.status) ? l.status : LISTING_STATUS.PENDING;
  return { status: s, url: str(l && l.url), at: Number(l && l.at) || 0 };
}

// Every field has a default, so a half-written or older document never throws.
export function normalizeTracker(t) {
  t = t || {};
  const channels = {};
  for (const k of CHANNEL_KEYS) channels[k] = normalizeChannel(t.channels && t.channels[k]);
  return {
    ...t,
    id: str(t.id),
    propertyCode: str(t.propertyCode),
    title: str(t.title),
    location: str(t.location),
    details: str(t.details),
    note: str(t.note),
    reference: str(t.reference),
    repostOf: str(t.repostOf),
    plannedDate: Number(t.plannedDate) || 0,
    weekOf: Number(t.weekOf) || 0,
    photosLink: str(t.photosLink),
    propertyId: str(t.propertyId),
    channels,
    brochure: { done: !!(t.brochure && t.brochure.done), at: Number(t.brochure && t.brochure.at) || 0, by: str(t.brochure && t.brochure.by) },
    acres99: normalizeListing(t.acres99),
    website: normalizeListing(t.website),
    tags: cleanTags(t.tags)
  };
}

export function blankTracker(seed, now, who) {
  const code = str(seed && seed.propertyCode);
  return normalizeTracker({
    id: newTrackerId(now),
    propertyCode: code,
    title: seed && seed.title,
    location: seed && seed.location,
    details: seed && seed.details,
    note: seed && seed.note,
    reference: seed && seed.reference,
    repostOf: seed && seed.repostOf,
    propertyId: seed && seed.propertyId,
    plannedDate: seed && seed.plannedDate,
    weekOf: seed && seed.weekOf,
    channels: seed && seed.channels,
    photosLink: seed && seed.photosLink,
    createdAt: now, createdBy: who || '', updatedAt: now, updatedBy: who || ''
  });
}

// ── What a change touched ──
// A save writes only the fields that changed, so two people editing different parts of one row
// never overwrite each other. Paths are Firestore field paths: top-level fields, except channels,
// which go one channel at a time ('channels.igReel') — the Story and the Reel are often changed
// by different people. The id and the "last changed by" stamp are not part of a change.
const NOT_A_CHANGE = new Set(['id', 'updatedAt', 'updatedBy', 'tenantId']);
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
  return ka.length === kb.length && ka.every(k => same(a[k], b[k]));
}
export function changedPaths(prev, next) {
  const a = prev || {}, b = next || {}, out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (NOT_A_CHANGE.has(k)) continue;
    if (k === 'channels' && a.channels && b.channels && typeof a.channels === 'object' && typeof b.channels === 'object') {
      for (const c of new Set([...Object.keys(a.channels), ...Object.keys(b.channels)])) {
        if (!same(a.channels[c], b.channels[c])) out.push('channels.' + c);
      }
    } else if (!same(a[k], b[k])) out.push(k);
  }
  return out;
}
export function getPath(obj, path) {
  let v = obj;
  for (const p of String(path).split('.')) { if (v == null) return undefined; v = v[p]; }
  return v;
}
// `base` with the value at each path taken from `src`. Undo uses it: the row as it is NOW, with
// only the fields that one action changed put back — anything else changed since is kept.
export function copyPaths(base, src, paths) {
  const out = { ...base };
  for (const path of paths || []) {
    const parts = String(path).split('.'), v = getPath(src, path);
    let o = out;
    for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = { ...(o[parts[i]] || {}) }; o = o[parts[i]]; }
    if (v === undefined) delete o[parts[parts.length - 1]]; else o[parts[parts.length - 1]] = v;
  }
  return out;
}

// ── Changing a channel ──
// Returns { ok, tracker } or { ok:false, error }. Scheduled needs a time; the
// other statuses clear whatever no longer applies, so "Yet to schedule" can
// never keep a stale date behind it.
export function setChannel(tracker, key, status, extra, now) {
  if (!CHANNEL_KEYS.includes(key)) return { ok: false, error: 'Unknown channel' };
  if (!STATUS_ORDER.includes(status)) return { ok: false, error: 'Unknown status' };
  const t = normalizeTracker(tracker);
  const cur = t.channels[key];
  const e = extra || {};
  let next;
  if (status === STATUS.SCHEDULED) {
    const at = Number(e.at) || 0;
    if (!at) return { ok: false, error: 'Pick the date and time it will go out.' };
    next = { status, at, url: cur.url, liveAt: 0, day: cur.day };
  } else if (status === STATUS.LIVE) {
    const url = e.url !== undefined ? cleanUrl(e.url) : cur.url;
    if (url && !isUrl(url)) return { ok: false, error: BAD_URL };
    next = { status, at: cur.at || Number(e.at) || 0, url, liveAt: Number(e.liveAt) || now || Date.now(), day: cur.day };
  } else {
    // N/A means it will not go out, so it has no planned day either.
    next = { status, at: 0, url: status === STATUS.NA ? '' : cur.url, liveAt: 0, day: status === STATUS.NA ? 0 : cur.day };
  }
  t.channels = { ...t.channels, [key]: next };
  return { ok: true, tracker: t };
}

// Adding or fixing the link on a post that is already live.
export function setChannelUrl(tracker, key, url) {
  const t = normalizeTracker(tracker);
  const u = cleanUrl(url);
  if (u && !isUrl(u)) return { ok: false, error: BAD_URL };
  if (!t.channels[key] || t.channels[key].status !== STATUS.LIVE) return { ok: false, error: 'Only a live post has a link' };
  t.channels = { ...t.channels, [key]: { ...t.channels[key], url: u } };
  return { ok: true, tracker: t };
}

export function setListing(tracker, key, status, extra, now) {
  if (!LISTINGS.some(l => l.key === key)) return { ok: false, error: 'Unknown listing' };
  if (!Object.values(LISTING_STATUS).includes(status)) return { ok: false, error: 'Unknown status' };
  const t = normalizeTracker(tracker);
  const url = extra && extra.url !== undefined ? cleanUrl(extra.url) : t[key].url;
  if (status === LISTING_STATUS.POSTED && url && !isUrl(url)) return { ok: false, error: BAD_URL };
  t[key] = status === LISTING_STATUS.POSTED
    ? { status, url, at: now || Date.now() }
    : { status, url: status === LISTING_STATUS.NA ? '' : t[key].url, at: 0 };
  return { ok: true, tracker: t };
}

export function setBrochure(tracker, done, who, now) {
  const t = normalizeTracker(tracker);
  t.brochure = done ? { done: true, at: now || Date.now(), by: str(who) } : { done: false, at: 0, by: '' };
  return t;
}

// ── Reading a tracker ──
export function channelView(ch, now) {
  const c = normalizeChannel(ch);
  return {
    ...c,
    due: c.status === STATUS.SCHEDULED && c.at > 0 && c.at <= now,
    linkMissing: c.status === STATUS.LIVE && !c.url
  };
}

// The checklist for one property: what is still open, worst first. `sev`:
// 3 = something went out wrong or late, 2 = action needed now, 1 = still to do.
export function gaps(tracker, now) {
  const t = normalizeTracker(tracker);
  const out = [];
  const today = startOfDay(now);
  // A row that is only a plan reference (no code yet) is not nagged about every channel — the plan
  // says which ones are meant, and the rest are the team's choice once the property exists.
  const planOnly = (!t.propertyCode && (t.plannedDate || t.weekOf)) || !!t.repostOf;
  const anyOut = CHANNEL_KEYS.some(k => t.channels[k].status === STATUS.SCHEDULED || t.channels[k].status === STATUS.LIVE);
  for (const { key, label } of CHANNELS) {
    const v = channelView(t.channels[key], now);
    if (v.due) out.push({ kind: 'due', key, sev: 3, text: `${label} was due — confirm it is posted` });
    else if (v.linkMissing) out.push({ kind: 'link', key, sev: 3, text: `${label} is live but the post link is not shared` });
    else if (v.status === STATUS.YET && v.day) {
      const late = v.day < today, same = v.day === today;
      out.push({ kind: 'yet', key, sev: late ? 3 : same ? 2 : 1, text: `${label} planned for ${dayLabel(v.day)} — ${late ? 'that day has passed and it was never scheduled' : 'set the time'}` });
    } else if (v.status === STATUS.YET && !planOnly) out.push({ kind: 'yet', key, sev: 1, text: `${label} not scheduled yet` });
  }
  if (t.plannedDate && !CHANNEL_KEYS.some(k => t.channels[k].status === STATUS.SCHEDULED || t.channels[k].status === STATUS.LIVE || t.channels[k].day)) {
    const late = t.plannedDate < today;
    out.push({ kind: 'plan', sev: late ? 3 : t.plannedDate === today ? 2 : 1, text: `Planned for ${dayLabel(t.plannedDate)} — no channel chosen yet` });
  }
  if (t.repostOf) return out.sort((a, b) => b.sev - a.sev);   // everything else lives on the original row
  if (!t.propertyCode) out.push({ kind: 'code', sev: 1, text: 'Property code not created yet' });
  if (!t.brochure.done) out.push({ kind: 'brochure', sev: anyOut ? 3 : 1, text: anyOut ? 'Posts are going out but the brochure is not created' : 'Brochure not created' });
  for (const { key, label } of LISTINGS) {
    if (t[key].status === LISTING_STATUS.PENDING) out.push({ kind: key, key, sev: 1, text: `${label} not posted` });
    else if (t[key].status === LISTING_STATUS.POSTED && !t[key].url) out.push({ kind: 'link', key, sev: 2, text: `${label} is posted but the link is not shared` });
  }
  if (!t.propertyId) out.push({ kind: 'dashboard', sev: 1, text: 'Not added to the Property dashboard yet' });
  if (!t.photosLink) out.push({ kind: 'photos', sev: 2, text: 'Photos link not received' });
  if (!t.details) out.push({ kind: 'details', sev: 2, text: 'Property details not received' });
  return out.sort((a, b) => b.sev - a.sev);
}

// ── Days and the weekly plan ──
export function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
export function mondayOf(ts) { const d = new Date(startOfDay(ts)); const k = (d.getDay() + 6) % 7; d.setDate(d.getDate() - k); return d.getTime(); }
export function addDays(ts, n) { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); }
// toLocale*String builds a new formatter on every call, which a 300-row page does thousands of
// times. One formatter per format (keyed by the options object) is built once and reused.
const FORMATTERS = new WeakMap();
export function formatDate(ts, opts) {
  let f = FORMATTERS.get(opts);
  if (!f) { f = new Intl.DateTimeFormat([], opts); FORMATTERS.set(opts, f); }
  return f.format(ts);
}
const DAY_LABEL = { weekday: 'short', day: 'numeric', month: 'short' };
export function dayLabel(ts) { return ts ? formatDate(ts, DAY_LABEL) : ''; }
export function displayName(t, all) {
  if (t && t.repostOf) {
    const o = (all || []).find(x => x.id === t.repostOf);
    return (o ? nameOf(o) : 'Repost') + (t.reference && o && nameOf(o) !== t.reference ? ' — ' + t.reference : '');
  }
  return nameOf(t);
}
export function nameOf(t) { return str(t && t.title) || str(t && t.reference) || str(t && t.propertyCode) || 'Untitled'; }

const DAYS = [['mon', 0], ['tue', 1], ['wed', 2], ['thu', 3], ['fri', 4], ['sat', 5], ['sun', 6]];
// Only real day names and their usual short forms — "Sunshine Apartments" is not a Sunday.
const DAY_RE = /^(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b\s*[-–—:]?\s*(.*)$/i;
const YT_RE = /^(you\s?tube|yt)\b\s*[-–—:]?\s*(.*)$/i;
const cleanRef = v => String(v || '').replace(/^[\s\-–—:]+/, '').replace(/\s+/g, ' ').trim();

// Turns a pasted week ("Monday -S- Lux49 - 4Bhk") into rows. "S" means Insta Story; a line with no
// S only has the day. A "Youtube - …" line is a YouTube item for the whole week. Headings such as
// "THIS WEEK" and anything else unrecognised are returned in `skipped` for the person to see.
export function parsePlan(text, monday) {
  const items = [], skipped = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(this|next|last|his)\s+(week|wk)\b/i.test(line) || /^week\b/i.test(line)) continue;
    let m = line.match(YT_RE);
    if (m && cleanRef(m[2])) { items.push({ reference: cleanRef(m[2]), kind: 'youtube', day: 0, story: false, raw: line }); continue; }
    m = line.match(DAY_RE);
    if (m) {
      const d = DAYS.find(x => m[1].toLowerCase().startsWith(x[0]));
      let rest = m[2].trim(), story = false;
      const sm = rest.match(/^[-–—:]*\s*s\s*[-–—:]\s*(.*)$/i);
      if (sm) { story = true; rest = sm[1]; }
      rest = cleanRef(rest);
      if (d && rest) { items.push({ reference: rest, kind: 'day', day: addDays(monday, d[1]), story, raw: line }); continue; }
    }
    skipped.push(line);
  }
  return { items, skipped };
}

// Parsed items → new rows, leaving out any already there (same reference and day / week), so
// pasting the same week twice is harmless. A code tagged on a line when that property already has
// a first row (saved, or earlier in this same paste) makes the line a repost of that row.
export function planRows(items, monday, existing, now, who) {
  const keyOf = (ref, day, week) => ref.toLowerCase() + '|' + day + '|' + week;
  const ex = (existing || []).map(normalizeTracker);
  const seen = new Set(ex.map(t => keyOf(t.reference, t.plannedDate, t.weekOf)));
  const rows = [];
  let n = 0;
  for (const it of items) {
    const yt = it.kind === 'youtube';
    const key = keyOf(it.reference, yt ? 0 : it.day, yt ? monday : 0);
    if (seen.has(key)) continue;
    seen.add(key);
    const channels = {};
    if (yt) { for (const k of ['igStory', 'igReel', 'fbReel']) channels[k] = { status: 'na' }; channels.yt = { status: 'yet' }; }
    else if (it.story) channels.igStory = { status: 'yet', day: it.day };
    const tag = it.tag || {};
    const base = { reference: it.reference, plannedDate: yt ? 0 : it.day, weekOf: yt ? monday : 0, channels };
    const first = tag.propertyCode && ex.concat(rows)
      .find(x => !x.repostOf && codeKey(x.propertyCode) && codeKey(x.propertyCode) === codeKey(tag.propertyCode));
    if (tag.repostOf) base.repostOf = tag.repostOf;
    else if (first) base.repostOf = first.id;
    else if (tag.propertyCode) Object.assign(base, { propertyCode: tag.propertyCode, title: tag.title || '', propertyId: tag.propertyId || '' });
    rows.push(blankTracker(base, now + (n++), who));
  }
  return rows;
}

// Everything planned for a day that has no time yet: a Story with a day, or a planned row with no
// channel chosen. Soonest first; `late` means the day has already passed.
export function planned(trackers, now) {
  const today = startOfDay(now), rows = [];
  for (const raw of trackers || []) {
    const t = normalizeTracker(raw);
    let any = false;
    for (const { key, label } of CHANNELS) {
      const c = t.channels[key];
      if (c.status === STATUS.YET && c.day) { any = true; rows.push({ id: t.id, tracker: t, key, label, day: c.day, late: c.day < today }); }
    }
    if (!any && t.plannedDate && !CHANNEL_KEYS.some(k => t.channels[k].status === STATUS.SCHEDULED || t.channels[k].status === STATUS.LIVE)) {
      rows.push({ id: t.id, tracker: t, key: null, label: 'Channel not chosen', day: t.plannedDate, late: t.plannedDate < today });
    }
  }
  return rows.sort((a, b) => a.day - b.day);
}

// Does anything on this row fall in the week starting `monday`: its planned day, its week, a
// planned channel day, or a scheduled / live time?
export function inWeek(tracker, monday) {
  const t = normalizeTracker(tracker), end = addDays(monday, 7);
  const hit = ts => ts >= monday && ts < end;
  if (hit(t.plannedDate) || t.weekOf === monday) return true;
  return CHANNEL_KEYS.some(k => { const c = t.channels[k]; return hit(c.day) || hit(c.at) || hit(c.liveAt); });
}
// The week a row belongs to, for grouping: its planned day, else its week, else its latest post.
export function weekKey(tracker) {
  const t = normalizeTracker(tracker);
  if (t.plannedDate) return mondayOf(t.plannedDate);
  if (t.weekOf) return t.weekOf;
  const times = CHANNEL_KEYS.map(k => { const c = t.channels[k]; return c.status === STATUS.LIVE ? (c.liveAt || c.at) : c.at || c.day; }).filter(Boolean);
  // The latest activity decides: a property posted months ago and going out again this week
  // belongs to this week, where the work is.
  return times.length ? mondayOf(Math.max(...times)) : 0;
}

// ── Add schedule: one date, several entries, each with its platforms ──
// entry = { keys: ['igStory', …], and ONE of:
//   trackerId: an existing row (scheduled on its latest round if those platforms are untouched,
//              otherwise as a new repost round, so earlier posts are never overwritten),
//   inv: { propertyCode, title, propertyId, location, photosLink, details } (a dashboard property),
//   ref: 'free text' (a plain reference row) }
// when = { day } (planned for the day) or { day, at } (scheduled at that time) — the default for
// entries that do not carry their own { day, at }.
// Returns { create: [rows], update: [rows], errors: [text] } — nothing is saved here.
export function bulkSchedule(trackers, entries, when, now, who) {
  const list = (trackers || []).map(normalizeTracker);
  const rawDay = Number(when && when.day) || 0;
  const defDay = rawDay ? startOfDay(rawDay) : 0, defAt = Number(when && when.at) || 0;
  const out = { create: [], update: [], errors: [] };
  // Every entry needs a date — its own, or the shared one.
  if ((entries || []).some(e => e && (e.trackerId || e.inv || str(e.ref)) && !(Number(e.day) || defDay))) { out.errors.push('Pick the date on every entry.'); return out; }
  const touched = new Map();   // rows updated in this same submit, so two entries do not fight
  let n = 0;
  let day = defDay, at = defAt;
  const applyKeys = (row, keys) => {
    const channels = { ...row.channels };
    for (const k of keys) {
      if (!CHANNEL_KEYS.includes(k)) continue;
      channels[k] = at ? { ...channels[k], status: STATUS.SCHEDULED, at, liveAt: 0, day } : { ...channels[k], status: STATUS.YET, at: 0, liveAt: 0, day };
    }
    return { ...row, channels, plannedDate: row.plannedDate || day };
  };
  for (const e of entries || []) {
    const keys = (e && e.keys || []).filter(k => CHANNEL_KEYS.includes(k));
    // This entry's own date and time, when it has one.
    if (e && Number(e.day)) { day = startOfDay(Number(e.day)); at = Number(e.at) || 0; } else { day = defDay; at = defAt; }
    if (e && e.trackerId) {
      const fam = familyOf(list.map(t => touched.get(t.id) || t), e.trackerId);
      if (!fam.length) { out.errors.push('A property picked here no longer exists.'); continue; }
      const latest = touched.get(fam[fam.length - 1].id) || fam[fam.length - 1];
      const untouched = keys.length && keys.every(k => { const c = latest.channels[k]; return c.status === STATUS.YET && !c.day && !c.at; });
      if (untouched && (!latest.plannedDate || latest.plannedDate === day)) {
        const row = applyKeys(latest, keys);
        touched.set(row.id, row);
        const i = out.update.findIndex(r => r.id === row.id);
        if (i >= 0) out.update[i] = row; else out.update.push(row);
      } else {
        const root = fam[0];
        const base = blankTracker({ reference: nameOf(root), repostOf: root.id, plannedDate: day }, now + (n++), who);
        out.create.push(applyKeys(base, keys));
      }
    } else if (e && e.inv && e.inv.propertyCode) {
      const p = e.inv;
      const exists = list.find(t => !t.repostOf && codeKey(t.propertyCode) === codeKey(p.propertyCode));
      if (exists) { out.errors.push(`${p.propertyCode} is already tracked — pick it from the tracked list instead.`); continue; }
      // The same dashboard property twice in one submit: the first line is its row, later ones are reposts of it.
      const first = out.create.find(t => !t.repostOf && codeKey(t.propertyCode) === codeKey(p.propertyCode));
      const row = first
        ? blankTracker({ reference: nameOf(first), repostOf: first.id, plannedDate: day }, now + (n++), who)
        : blankTracker({ propertyCode: p.propertyCode, title: p.title, location: p.location, photosLink: webLink(p.photosLink), details: p.details, propertyId: p.propertyId, plannedDate: day }, now + (n++), who);
      out.create.push(applyKeys(row, keys));
    } else if (e && str(e.ref)) {
      out.create.push(applyKeys(blankTracker({ reference: str(e.ref), plannedDate: day }, now + (n++), who), keys));
    }
  }
  if (!out.create.length && !out.update.length && !out.errors.length) out.errors.push('Add at least one property or reference.');
  return out;
}

// ── A property across all its rounds ──
// The original row plus every repost of it, oldest round first. Asking from a repost gives the
// same family as asking from the original.
// `index` (from familyIndex) is optional: a page drawing many cells builds it once per render,
// so each lookup is instant instead of re-reading every row.
export function familyOf(trackers, id, index) {
  return (index || familyIndex(trackers)).get(id) || [];
}
// Every row's family, by row id, built in one pass.
export function familyIndex(trackers) {
  const list = (trackers || []).map(normalizeTracker);
  const byId = new Map(), reposts = new Map(), fams = new Map(), out = new Map();
  for (const t of list) {
    if (!byId.has(t.id)) byId.set(t.id, t);
    if (t.repostOf) { if (!reposts.has(t.repostOf)) reposts.set(t.repostOf, []); reposts.get(t.repostOf).push(t); }
  }
  const firstDate = t => t.plannedDate || t.weekOf || Math.min(...CHANNEL_KEYS.map(k => t.channels[k].at || t.channels[k].day || Infinity)) || t.createdAt || 0;
  const famOf = rootId => {
    if (!fams.has(rootId)) {
      const rs = (reposts.get(rootId) || []).slice().sort((a, b) => firstDate(a) - firstDate(b) || (a.createdAt || 0) - (b.createdAt || 0));
      fams.set(rootId, [byId.get(rootId), ...rs]);
    }
    return fams.get(rootId);
  };
  for (const [id, me] of byId) out.set(id, famOf(me.repostOf && byId.has(me.repostOf) ? me.repostOf : me.id));
  return out;
}
// Every time this property went out (or is due to) on one channel, across all its rounds,
// oldest first. `when` is the live time, the scheduled time, or the planned day.
export function channelHistory(trackers, id, key, index) {
  const out = [];
  for (const t of familyOf(trackers, id, index)) {
    const c = t.channels[key];
    if (!c || c.status === STATUS.NA || (c.status === STATUS.YET && !c.day)) continue;
    const when = c.status === STATUS.LIVE ? (c.liveAt || c.at) : c.status === STATUS.SCHEDULED ? c.at : c.day;
    out.push({ rowId: t.id, repost: !!t.repostOf, status: c.status, when, url: c.url });
  }
  return out.sort((a, b) => (a.when || 0) - (b.when || 0));
}
// How many times live, and how many still to come, per channel — the property's scorecard.
export function familyCounts(trackers, id, index) {
  const out = {};
  index = index || familyIndex(trackers);
  for (const { key } of CHANNELS) {
    const h = channelHistory(trackers, id, key, index);
    out[key] = { live: h.filter(x => x.status === STATUS.LIVE).length, coming: h.filter(x => x.status !== STATUS.LIVE).length };
  }
  return out;
}

// Why a row sits in its week: the posts that go out that week, by day. A post counts on its
// live day if it is live, its scheduled time if scheduled, its planned day if only planned.
// `keys` are the channels to highlight; `days` (soonest first) say which day each goes out.
export function rowFocus(tracker, monday) {
  const t = normalizeTracker(tracker);
  const wk = monday != null ? monday : weekKey(t);
  if (!wk) return { week: 0, keys: [], days: [] };
  const end = addDays(wk, 7), byDay = new Map(), keys = [];
  for (const { key } of CHANNELS) {
    const c = t.channels[key];
    const when = c.status === STATUS.LIVE ? (c.liveAt || c.at) : c.status === STATUS.SCHEDULED ? c.at : c.status === STATUS.YET ? c.day : 0;
    if (!when || when < wk || when >= end) continue;
    const d = startOfDay(when);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(key);
    keys.push(key);
  }
  // A week item (the weekly YouTube line) is about YouTube even without a day.
  if (!keys.length && t.weekOf === wk && t.channels.yt.status !== STATUS.NA) keys.push('yt');
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, k]) => ({ day, keys: k }));
  return { week: wk, keys, days };
}

// ── Does a pasted link belong to the place it is being pasted for? ──
// true = looks right, false = clearly another platform's link, null = can't tell (e.g. our own
// website, or a short link). Only `false` warns — and it never blocks, it only asks for a second look.
const HOSTS = {
  igStory: /(^|\.)instagram\.com$|(^|\.)instagr\.am$/, igReel: /(^|\.)instagram\.com$|(^|\.)instagr\.am$/,
  fbReel: /(^|\.)facebook\.com$|(^|\.)fb\.watch$|(^|\.)fb\.com$/, yt: /(^|\.)youtube\.com$|(^|\.)youtu\.be$/,
  acres99: /(^|\.)99acres\.com$/
};
const ANY_SOCIAL = /(^|\.)(instagram\.com|instagr\.am|facebook\.com|fb\.watch|fb\.com|youtube\.com|youtu\.be|99acres\.com)$/;
export function linkLooksLike(key, url) {
  let host;
  try { host = new URL(cleanUrl(url)).hostname.toLowerCase(); } catch (e) { return null; }
  if (!HOSTS[key]) return ANY_SOCIAL.test(host) ? false : null;     // website: a social link is suspicious
  if (HOSTS[key].test(host)) return true;
  return ANY_SOCIAL.test(host) ? false : null;
}
export function platformOf(url) {
  let host;
  try { host = new URL(cleanUrl(url)).hostname.toLowerCase(); } catch (e) { return ''; }
  if (/instagram|instagr\.am/.test(host)) return 'Instagram';
  if (/facebook|fb\.watch|fb\.com/.test(host)) return 'Facebook';
  if (/youtube|youtu\.be/.test(host)) return 'YouTube';
  if (/99acres/.test(host)) return '99 Acres';
  return '';
}

// ── The week at a glance: what goes out each day, and as what ──
// One entry per post: a channel that is scheduled, live, or planned for a day in this week. A
// planned row with no channel yet is an entry too ("not decided"), so a day is never silently
// empty just because the type has not been picked. Week items (e.g. "Youtube - T nagar series")
// have no day and are listed apart.
export const SHORT_CH = { igStory: 'Story', igReel: 'Reel', fbReel: 'FB Reel', yt: 'YouTube' };
export function weekAgenda(trackers, monday, now) {
  const end = addDays(monday, 7);
  const days = Array.from({ length: 7 }, (_, i) => ({ day: addDays(monday, i), items: [] }));
  const weekItems = [];
  const counts = { igStory: 0, igReel: 0, fbReel: 0, yt: 0, undecided: 0 };
  const dayIdx = ts => Math.floor((startOfDay(ts) - monday) / 86400000 + 0.01);
  for (const raw of trackers || []) {
    const t = normalizeTracker(raw);
    let placed = false;
    for (const { key } of CHANNELS) {
      const c = t.channels[key];
      let when = 0, state = '';
      if (c.status === STATUS.LIVE) { when = c.liveAt || c.at; state = c.url ? 'live' : 'nolink'; }
      else if (c.status === STATUS.SCHEDULED) { when = c.at; state = c.at <= now ? 'due' : 'scheduled'; }
      else if (c.status === STATUS.YET && c.day) { when = c.day; state = c.day < startOfDay(now) ? 'late' : 'planned'; }
      if (!when) {
        // A week item (YouTube series) belongs to the week, not to a day.
        if (t.weekOf === monday && c.status === STATUS.YET && key === 'yt') { weekItems.push({ id: t.id, tracker: t, key, state: 'planned' }); counts.yt++; placed = true; }
        continue;
      }
      if (when < monday || when >= end) continue;
      days[dayIdx(when)].items.push({ id: t.id, tracker: t, key, state, at: c.status === STATUS.YET ? 0 : when });
      counts[key]++; placed = true;
    }
    if (!placed && t.plannedDate >= monday && t.plannedDate < end && !CHANNEL_KEYS.some(k => t.channels[k].status === STATUS.SCHEDULED || t.channels[k].status === STATUS.LIVE)) {
      days[dayIdx(t.plannedDate)].items.push({ id: t.id, tracker: t, key: null, state: t.plannedDate < startOfDay(now) ? 'late' : 'undecided', at: 0 });
      counts.undecided++;
    }
  }
  for (const d of days) d.items.sort((a, b) => (a.at || Infinity) - (b.at || Infinity));
  return { days, weekItems, counts };
}

// A suggestion only: which tracked property a plan line probably means. Conservative on purpose —
// a code in the line, or every word of one name found in the other (at least two words).
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w && !['the', 'a', 'and', 'for', 'rent', 'sale', 'new', 'brand', 'story', 'reel'].includes(w));
export function suggestTag(reference, trackers) {
  const refW = words(reference), refKey = codeKey(reference);
  if (!refW.length) return null;
  for (const raw of trackers || []) {
    const t = normalizeTracker(raw);
    if (t.repostOf) continue;
    const ck = codeKey(t.propertyCode);
    if (ck && ck.length >= 4 && refKey.includes(ck)) return t.id;
  }
  for (const raw of trackers || []) {
    const t = normalizeTracker(raw);
    if (t.repostOf) continue;
    for (const name of [t.title, t.reference]) {
      const nw = words(name);
      if (nw.length < 2) continue;
      const set = new Set(refW), nset = new Set(nw);
      if (nw.every(w => set.has(w)) || (refW.length >= 2 && refW.every(w => nset.has(w)))) return t.id;
    }
  }
  return null;
}

// Giving a code to a row that started as a reference. Codes are unique across rows.
export function setCode(trackers, id, code) {
  const c = str(code), key = trackerId(c);
  if (!key) return { ok: false, error: 'Enter the property code.' };
  const clash = (trackers || []).find(t => t.id !== id && !t.repostOf && codeKey(t.propertyCode) === codeKey(c));
  if (clash) return { ok: false, error: 'That code is already used by ' + nameOf(clash) + '.' };
  return { ok: true, code: c.toUpperCase() };   // codes are written in capitals everywhere else
}

// ── Tasks: the same gaps, grouped by the job that clears them ──
// In the order a person should work: confirm what has gone out, fix what is wrong with it,
// chase what is missing, then schedule what is still open.
export const TASK_DEFS = [
  { kind: 'due', title: 'Confirm posted', who: 'Admin', hint: 'The scheduled time has passed. Open the post, copy its link, confirm it.' },
  { kind: 'link', title: 'Add the post link', who: 'Admin', hint: 'It is live, but nobody has pasted the link.' },
  { kind: 'plan', title: 'Planned — choose a channel and time', who: 'Media team', hint: 'The plan has a day for these but no channel yet.' },
  { kind: 'brochure', title: 'Create the brochure', who: 'Admin', hint: 'Properties with posts out or booked and no brochure come first.' },
  { kind: 'photos', title: 'Waiting for photos', who: 'Media team', hint: 'No photos link shared yet.' },
  { kind: 'details', title: 'Waiting for property details', who: 'Media team', hint: 'No details shared yet.' },
  { kind: 'code', title: 'Create the property code', who: 'Admin', hint: 'These started as a reference from the weekly plan.' },
  { kind: 'yet', title: 'Schedule the posts', who: 'Media team', hint: 'Pick a date and time, or mark N/A if it will not be posted.' },
  { kind: 'acres99', title: 'Post on 99 Acres', who: 'Admin', hint: 'Mark N/A to skip it for a property.' },
  { kind: 'website', title: 'Post on the 3 PIN website', who: 'Admin', hint: 'Mark N/A to skip it for a property.' },
  { kind: 'dashboard', title: 'Add to the Property dashboard', who: 'Admin', hint: 'Optional, any time — link it once it exists there.' }
];
export function tasks(trackers, now) {
  const groups = TASK_DEFS.map(d => ({ ...d, items: [] }));
  for (const raw of trackers || []) {
    const t = normalizeTracker(raw);
    for (const g of gaps(t, now)) {
      const grp = groups.find(x => x.kind === g.kind);
      if (!grp) continue;
      let row = grp.items.find(i => i.id === t.id);
      if (!row) { row = { id: t.id, tracker: t, keys: [], sev: g.sev }; grp.items.push(row); }
      if (g.key) row.keys.push(g.key);
      row.sev = Math.max(row.sev, g.sev);
    }
  }
  for (const g of groups) g.items.sort((a, b) => b.sev - a.sev || String(a.tracker.propertyCode).localeCompare(String(b.tracker.propertyCode)));
  return groups.filter(g => g.items.length);
}

// The one line at the top of every view.
export function summary(trackers, now) {
  const list = (trackers || []).map(normalizeTracker);
  const n = k => list.filter(t => overall(t, now) === k).length;
  const up = upcoming(list, now);
  return { total: list.length, complete: n('complete'), attention: n('attention'), scheduled: up.filter(r => !r.due).length, due: up.filter(r => r.due).length };
}

// Done / applicable. N/A items drop out of both sides, so a property that only
// needs a Reel and a brochure can still reach 100%.
export function progress(tracker) {
  const t = normalizeTracker(tracker);
  let done = 0, total = 0;
  if (t.repostOf) {
    // A repost is only its own posts: the ones planned, scheduled or live.
    for (const k of CHANNEL_KEYS) {
      const c = t.channels[k];
      if (c.status === STATUS.NA || (c.status === STATUS.YET && !c.day)) continue;
      total++; if (c.status === STATUS.LIVE) done++;
    }
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  }
  for (const k of CHANNEL_KEYS) {
    const s = t.channels[k].status;
    if (s === STATUS.NA) continue;
    total++; if (s === STATUS.LIVE) done++;
  }
  total++; if (t.brochure.done) done++;
  for (const { key } of LISTINGS) {
    const s = t[key].status;
    if (s === LISTING_STATUS.NA) continue;
    total++; if (s === LISTING_STATUS.POSTED) done++;
  }
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// complete → all applicable done and nothing flagged; attention → something is
// late or inconsistent; started → at least one thing done or scheduled; new.
export function overall(tracker, now) {
  const g = gaps(tracker, now);
  const p = progress(tracker);
  if (!g.length && p.done === p.total && p.total > 0) return 'complete';
  if (g.some(x => x.sev >= 3)) return 'attention';
  const t = normalizeTracker(tracker);
  const touched = p.done > 0 || CHANNEL_KEYS.some(k => t.channels[k].status === STATUS.SCHEDULED);
  return touched ? 'started' : 'new';
}

// Every timed post across properties, soonest first — what the CEO's plan turns
// into. `due` ones sort to the very top: they are the ones owed a confirmation.
export function upcoming(trackers, now) {
  const rows = [];
  for (const raw of trackers || []) {
    const t = normalizeTracker(raw);
    for (const { key, label } of CHANNELS) {
      const c = t.channels[key];
      if (c.status !== STATUS.SCHEDULED || !c.at) continue;
      rows.push({ id: t.id, tracker: t, key, label, at: c.at, due: c.at <= now });
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

export function liveMissingLink(trackers) {
  const rows = [];
  for (const raw of trackers || []) {
    const t = normalizeTracker(raw);
    for (const { key, label } of CHANNELS) {
      if (t.channels[key].status === STATUS.LIVE && !t.channels[key].url) rows.push({ id: t.id, tracker: t, key, label });
    }
  }
  return rows;
}

// ── Filters shown as one row of counted buttons ──
export const FILTERS = [
  ['thisweek', 'This week'],
  ['due', 'Due now'],
  ['nocode', 'No code yet'],
  ['nobrochure', 'Brochure not created'],
  ['nolink', 'Link missing'],
  ['unscheduled', 'Not scheduled'],
  ['noacres', '99 Acres not posted'],
  ['noinputs', 'Photos / details missing'],
  ['nodash', 'Not in Property dashboard']
];
export function matchesFilter(tracker, f, now) {
  const t = normalizeTracker(tracker);
  const g = gaps(t, now);
  switch (f) {
    case 'due': return g.some(x => x.kind === 'due');
    case 'nobrochure': return !t.brochure.done;
    case 'nolink': return g.some(x => x.kind === 'link');
    case 'unscheduled': return g.some(x => x.kind === 'yet');
    case 'noacres': return t.acres99.status === LISTING_STATUS.PENDING;
    case 'nodash': return !t.repostOf && !t.propertyId;
    case 'nocode': return !t.repostOf && !t.propertyCode;
    case 'thisweek': return inWeek(t, mondayOf(now));
    case 'noinputs': return !t.photosLink || !t.details;
    default: return true;
  }
}

// ── CSV: sheet-ready, since nothing here writes to the inventory sheet ──
const csvCell = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
// Local time throughout: a day planned in Chennai must not come out as the day before (UTC).
const when = ts => {
  if (!ts) return '';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const dateOnly = ts => when(ts).slice(0, 10);
export function toCsv(trackers) {
  const head = ['Planned date', 'Reference', 'Repost of', 'Property code', 'Title', 'Location', 'In Property dashboard', 'Photos link', 'Details', 'Notes'];
  for (const c of CHANNELS) head.push(c.label + ' status', c.label + ' date/time', c.label + ' link');
  head.push('Brochure created', 'Brochure by');
  for (const l of LISTINGS) head.push(l.label + ' status', l.label + ' link');
  head.push('Progress');
  const rows = (trackers || []).map(normalizeTracker).map(t => {
    const r = [dateOnly(t.plannedDate), t.reference, t.repostOf, t.propertyCode, t.title, t.location, t.propertyId ? 'Yes' : 'No', t.photosLink, t.details, t.note];
    for (const c of CHANNELS) { const x = t.channels[c.key]; r.push(STATUS_LABEL[x.status], when(x.at), x.url); }
    r.push(t.brochure.done ? 'Yes' : 'No', t.brochure.by);
    for (const l of LISTINGS) r.push(LISTING_LABEL[t[l.key].status], t[l.key].url);
    const p = progress(t); r.push(`${p.done}/${p.total}`);
    return r;
  });
  return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}
