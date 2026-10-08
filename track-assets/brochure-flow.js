// ═══════════════════════════════════════════════════════════════════════
// BROCHURE FROM A LISTING — the rules, with no page attached.
//
// A listing on the Property & Media board can ask for its brochure directly:
// property code, title, photos link, description and internal notes go to the
// same Google Form the Create brochure page uses, so the same pipeline builds
// it (Queue sheet → Mac → Drive + email → Inventory → dashboard).
//
// What can go wrong, and what this file does about each:
//   • a code typed with a small slip (THVA0001 for THVA001) sends the brochure
//     to a property nobody can find → similarCodes() names the near-miss
//   • a code already in the dashboard is typed for a new property → findCode()
//     says so, and the listing can link to it instead of duplicating it
//   • two listings claim one code → findCode() reports the other listing
//   • the dashboard's brochure "link" is still a bare file name while the Mac
//     has not delivered yet → isUrl() keeps it from counting as done
//   • a field filled by hand is overwritten by a mapping → fillFromProperty()
//     only fills blanks (photos and brochure links excepted: the dashboard's
//     own delivered links are the truth once they exist)
// ═══════════════════════════════════════════════════════════════════════

const str = v => (v == null ? '' : String(v)).trim();

// "thva 001", "THVA-001" and "THVA001" are one code. Stored codes are kept as
// typed by the pipeline; this is only for comparing.
// Timeline entries are HTML; anything from the dashboard goes in escaped.
const esc = s => str(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const codeKey = c => str(c).toUpperCase().replace(/[^A-Z0-9]/g, '');
// Real codes are letters then digits (TNAG0002, THVA001). Older listings use a
// bare number as their id — those are not codes anyone types.
export const CODE_RE = /^[A-Z]{2,8}\d{1,6}$/;
export const looksLikeCode = c => CODE_RE.test(codeKey(c));
// What a code should look like when it is written down: capitals, no spaces —
// and a proper code loses its dashes too ("thva-001" goes to the form as THVA001,
// the way the pipeline files it).
export const normCode = c => { const n = str(c).toUpperCase().replace(/\s+/g, ''); return looksLikeCode(n) ? codeKey(n) : n; };
export const isRealCode = c => !!str(c) && !/^\d+$/.test(str(c));
export const isUrl = v => /^https?:\/\/\S+$/i.test(str(v));

// One property, one seller, one listing: a code mapped to (or claimed for a brochure by) one
// listing on the board can never be mapped to another. The message says which listing has it.
export const takenMessage = (code, listing) => `${code} is already mapped to “${str(listing && listing.title) || 'another listing'}” on this board — one property has one seller, one listing.`;

// Is this code already in the dashboard, or claimed by another listing here?
export function findCode(code, inventory, listings, selfId) {
  const k = codeKey(code);
  if (!k) return { inventory: null, listing: null };
  const inv = (inventory || []).find(p => isRealCode(p.propertyCode) && codeKey(p.propertyCode) === k) || null;
  const lst = (listings || []).find(l => l.id !== selfId && (codeKey(l.propertyCode) === k || codeKey(l.brochure && l.brochure.code) === k)) || null;
  return { inventory: inv, listing: lst };
}

// Codes that are probably what was meant, always for the SAME number: the same
// letters with the number padded differently (THVA0001 / THVA001), or the letters
// one slip away — one letter wrong, missing, extra, or two side by side swapped
// (TNGA0002 / TNAG0002). A different number is never a near-miss: TNAG0003 is
// simply the next property after TNAG0002.
function split(k) { const m = k.match(/^([A-Z]+)(\d+)$/); return m ? { a: m[1], n: parseInt(m[2], 10), d: m[2] } : null; }
function lettersSlip(a, b) {
  if (a === b) return false;
  if (a.length === b.length) {
    const diff = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true;
    return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
  }
  if (Math.abs(a.length - b.length) !== 1) return false;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
}
export function similarCodes(code, inventory, limit = 3) {
  const k = codeKey(code);
  const me = split(k);
  if (!k || !me) return [];
  const out = [];
  for (const p of inventory || []) {
    if (!isRealCode(p.propertyCode)) continue;
    const pk = codeKey(p.propertyCode);
    if (pk === k) continue;
    const o = split(pk);
    if (!o) continue;
    if (o.n !== me.n) continue;
    const padding = o.a === me.a && o.d !== me.d;              // THVA0001 vs THVA001
    // A letter slip, whatever the padding: VLC0002 for VLCA002 is the same property, slipped twice.
    if (padding || lettersSlip(o.a, me.a)) out.push(p);
  }
  return out.slice(0, limit);
}

// Suggestions while typing: codes that start with what has been typed (then
// codes containing it), real codes only, A–Z.
export function codeSuggestions(typed, inventory, limit = 6) {
  const k = codeKey(typed);
  if (!k) return [];
  const real = (inventory || []).filter(p => isRealCode(p.propertyCode));
  const starts = real.filter(p => codeKey(p.propertyCode).startsWith(k));
  const has = real.filter(p => !codeKey(p.propertyCode).startsWith(k) && codeKey(p.propertyCode).includes(k));
  const byCode = (a, b) => String(a.propertyCode).localeCompare(String(b.propertyCode), undefined, { numeric: true });
  return [...starts.sort(byCode), ...has.sort(byCode)].slice(0, limit);
}

// Each series of codes (TNAG0001, TNAG0002 … is the TNAG series): how many, the latest, and the
// next free code — so a new property takes the next number instead of a guessed one.
export function codeSeries(inventory) {
  const m = new Map();
  for (const p of inventory || []) {
    if (!isRealCode(p.propertyCode) || /_/.test(p.propertyCode) || !looksLikeCode(p.propertyCode)) continue;
    const s = split(codeKey(p.propertyCode));
    if (!s) continue;
    const g = m.get(s.a) || { letters: s.a, count: 0, max: -1, width: s.d.length, last: '' };
    g.count++;
    if (s.n > g.max) { g.max = s.n; g.width = s.d.length; g.last = p.propertyCode; }
    m.set(s.a, g);
  }
  const taken = new Set((inventory || []).map(p => codeKey(p.propertyCode)));
  for (const g of m.values()) {
    let n = g.max + 1;
    while (taken.has(g.letters + String(n).padStart(g.width, '0'))) n++;
    g.next = g.letters + String(n).padStart(g.width, '0');
  }
  return m;
}
// The series a typed code belongs to: letters only ("TNA") — every series it could be; letters and a
// number — exactly that series.
export function seriesFor(typed, inventory) {
  const k = codeKey(typed);
  if (!k) return [];
  const letters = (k.match(/^[A-Z]+/) || [''])[0];
  return [...codeSeries(inventory).values()]
    .filter(g => /\d/.test(k) ? g.letters === letters : g.letters.startsWith(k))
    .sort((a, b) => a.letters.localeCompare(b.letters));
}

// Bring a dashboard property's details onto the listing. Blanks only — a photos link someone
// typed on the listing is theirs — except the delivered brochure, which the pipeline owns.
// Returns { patch, filled: [field labels] }.
const FILL = [
  ['title', 'name', 'Title'],
  ['location', 'location', 'Location'],
  ['config', 'config', 'Configuration'],
  ['askingPrice', 'startingPrice', 'Price'],
  ['description', 'detailsText', 'Description']
];
export function fillFromProperty(listing, prop, internalNotes) {
  const x = listing || {}, p = prop || {};
  const patch = {}, filled = [];
  for (const [lf, pf, label] of FILL) {
    const cur = str(x[lf]);
    if ((!cur || (lf === 'title' && cur === 'New listing')) && str(p[pf])) { patch[lf] = str(p[pf]); filled.push(label); }
  }
  if (isUrl(p.photosLink) && !str(x.photosLink)) { patch.photosLink = str(p.photosLink); filled.push('Photos link'); }
  if (isUrl(p.brochureLink) && str(p.brochureLink) !== str(x.brochureLink)) { patch.brochureLink = str(p.brochureLink); filled.push('Brochure'); }
  if (!str(x.internalNotes) && str(internalNotes)) { patch.internalNotes = str(internalNotes); filled.push('Internal notes'); }
  return { patch, filled };
}

// ── What a mapping brought, and what unmapping takes back ──
// Mapping a listing to a dashboard property fills its blanks from that property. Each filled field
// is recorded on the listing as fetched: { field: { value, was } } — what it got, and what it held
// before. Unmapping puts back every field that still holds exactly what the mapping brought; a
// field typed, pasted or changed by a person is theirs and stays. Once a brochure has been
// generated from the listing, its details are what that brochure was made from: they all stay,
// and only the code goes with the mapping.
export const FETCHED_FIELDS = ['title', 'location', 'config', 'askingPrice', 'description', 'photosLink', 'internalNotes'];
export function recordFetched(prev, before, patch) {
  const out = { ...(prev || {}) };
  for (const f of FETCHED_FIELDS) {
    if (!patch || !(f in patch)) continue;
    // Filled again: what it held first is still what it goes back to — unless a person changed it
    // in between (cleared it, say), in which case theirs is what it held.
    const cur = str(before && before[f]);
    out[f] = { value: str(patch[f]), was: out[f] && cur === out[f].value ? out[f].was : cur };
  }
  return out;
}
// `cur` is the listing as it will be saved (an edit form's values over it); `oldProp` the property
// it was mapped to, for listings mapped before fields were recorded.
export function unmapPatch(cur, oldProp) {
  const x = cur || {};
  const patch = { brochureLink: '', fetched: null };
  const generated = !!(x.brochure && x.brochure.requestedAt);
  if (!generated) {
    // A card is never left without a name.
    const back = (f, v) => (f === 'title' && !str(v) ? 'New listing' : v);
    if (x.fetched) {
      // Recorded: exactly what the mapping filled, where it still holds that.
      for (const f of FETCHED_FIELDS) {
        const r = x.fetched[f];
        if (r && str(x[f]) === r.value) patch[f] = back(f, r.was);
      }
    } else {
      // Mapped before fields were recorded: what is identical to the old property came from it.
      for (const f of ['title', 'description', 'photosLink']) {
        const from = oldProp && { title: oldProp.name, description: oldProp.detailsText, photosLink: oldProp.photosLink }[f];
        if (from && str(x[f]) === str(from)) patch[f] = back(f, '');
      }
    }
  }
  return { patch, brochure: { doneAt: null, requestedAt: null, requestedCode: '', unlockedAt: null, unlockedLink: '' } };
}

// Where a brochure for this code stands in the pipeline's queue (the team's brochure log, with the
// Queue sheet's status): the newest entry for this code — asked for from this listing (not before
// it was asked), or from the Create brochure page for the property it is mapped to.
export function queueEntryFor(listing, log) {
  const x = listing || {};
  const k = codeKey(listingCode(x));
  if (!k || !Array.isArray(log)) return null;
  const since = x.brochure && x.brochure.requestedAt ? x.brochure.requestedAt - 60000 : (str(x.propertyCode) ? 0 : Infinity);
  return log.filter(e => e && e.at >= since && codeKey(str(e.title).split(/\s+/)[0]) === k)
    .sort((a, b) => b.at - a.at)[0] || null;
}

// The code this listing will be — or already is — known by.
export const listingCode = x => str((x && x.propertyCode) || (x && x.brochure && x.brochure.code));

// Can the brochure be asked for yet? Lists what is missing, in plain words.
export function brochureCheck(listing, inventory, listings) {
  const x = listing || {};
  const code = listingCode(x);
  const missing = [], warnings = [];
  if (!code) missing.push('Property code');
  else if (!looksLikeCode(code)) missing.push('A property code like TNAG0002 (letters, then numbers)');
  if (!str(x.title) || str(x.title) === 'New listing') missing.push('Title');
  if (!str(x.photosLink)) missing.push('Photos link');
  else if (!isUrl(x.photosLink)) missing.push('A photos link that starts with https://');
  if (!str(x.description)) missing.push('Description');
  if (code) {
    const f = findCode(code, inventory, listings, x.id);
    // A code already in the dashboard that this listing is NOT linked to: generating would build
    // a second brochure under somebody else's property.
    if (f.inventory && codeKey(x.propertyCode) !== codeKey(f.inventory.propertyCode)) missing.push(`Link to ${f.inventory.propertyCode}, or use a new code — it is already in the dashboard`);
    if (f.listing) missing.push(`A different code — ${code} is already used by “${str(f.listing.title) || 'another listing'}”`);
    if (!f.inventory && similarCodes(code, inventory).length) warnings.push(`Check the code — ${similarCodes(code, inventory).map(p => p.propertyCode).join(', ')} already exists`);
  }
  if (str(x.photosLink) && isUrl(x.photosLink) && !/drive\.google\.com|docs\.google\.com/i.test(x.photosLink)) warnings.push('The photos link is not a Google Drive folder — the brochure is uploaded into that folder');
  return { ok: !missing.length, missing, warnings };
}

// The form's "Property ID & Title" field: "CODE - Title", as the pipeline reads it.
export function brochureTitle(listing) {
  const code = normCode(listingCode(listing));
  const t = str(listing && listing.title);
  return t ? `${code} - ${t}` : code;
}

// Is the panel locked? Done by hand or by delivery, unless unlocked for a redo and no new brochure since.
export function isLocked(listing, inventory) {
  const x = listing || {};
  if (x.brochure && x.brochure.doneAt) return true;
  if (brochureState(x, inventory) !== 'ready') return false;
  const old = x.brochure && x.brochure.unlockedLink;
  if (!old) return true;
  const p = ownProperty(x, inventory);
  const now = (p && isUrl(p.brochureLink) && str(p.brochureLink)) || str(x.brochureLink);
  return now !== str(old);
}

// The dashboard property this listing's brochure comes from: the one it is linked to, or the code
// its brochure was asked for under. A code merely typed is not enough — that property's brochure
// is not this listing's.
function ownProperty(x, inventory) {
  const code = listingCode(x);
  if (!code || !(str(x.propertyCode) || (x.brochure && x.brochure.requestedAt))) return null;
  return (inventory || []).find(q => codeKey(q.propertyCode) === codeKey(code)) || null;
}

export function brochureState(listing, inventory) {
  const x = listing || {};
  if (isUrl(x.brochureLink)) return 'ready';
  const p = ownProperty(x, inventory);
  if (p && isUrl(p.brochureLink)) return 'ready';
  if (x.brochure && x.brochure.requestedAt) return p && str(p.brochureLink) ? 'building' : 'requested';
  return 'none';
}

// Is this listing waiting on the pipeline — asked for, and its brochure not in yet?
// (A redo asked for after unlocking waits again, though the old link is still there.)
// A request that never lands (the form's answer is opaque, or it was filed under another code)
// stops being waited for after two days, so open tabs do not re-read the inventory forever.
export const AWAIT_FOR = 2 * 86400000;
export function awaitingBrochure(x, now = Date.now()) {
  const b = (x && x.brochure) || {};
  if (!b.requestedAt || b.doneAt || now - b.requestedAt > AWAIT_FOR) return false;
  return !isUrl(x.brochureLink) || (!!b.unlockedAt && b.requestedAt > b.unlockedAt);
}

// After a brochure was asked for: once the property is in the dashboard, link the listing to it
// and bring its details across; once its brochure is delivered, mark the brochure done.
// Only listings that are linked, or whose brochure was actually asked for, are touched — a code
// merely typed (even one already in the dashboard) never pulls a property's photos and brochure in.
// Returns [{ id, patch, history }] — nothing is saved here.
export function reconcileBrochures(listings, inventory, now) {
  const out = [];
  for (const x of listings || []) {
    const linked = !!str(x.propertyCode);
    const b = x.brochure || {};
    // Asked for, not linked: only under the code it was asked for. A different code typed since
    // (or the box emptied to unlink it) is not a request.
    const asked = !linked && !!b.requestedAt && !!str(b.code) && (!b.requestedCode || codeKey(b.code) === codeKey(b.requestedCode));
    if (!linked && !asked) continue;
    const code = listingCode(x);
    if (!code) continue;
    // A linked listing may point at an older property whose id is a bare number; that link was chosen.
    const p = (inventory || []).find(q => (linked || isRealCode(q.propertyCode)) && codeKey(q.propertyCode) === codeKey(code));
    if (!p) continue;
    const patch = {}, notes = [];
    if (asked) {
      // Another listing already has this property: one property, one listing — leave this one unlinked.
      if ((listings || []).some(o => o.id !== x.id && codeKey(o.propertyCode) === codeKey(p.propertyCode))) continue;
      patch.propertyCode = p.propertyCode;
      notes.push(`Linked to <b>${esc(p.propertyCode)}</b> — it is now in the Property dashboard`);
    }
    const f = fillFromProperty({ ...x, ...patch }, p, '');
    Object.assign(patch, f.patch);
    // Every change made here is in the timeline, so nothing on a listing changes unexplained.
    const quiet = f.filled.filter(l => l !== 'Brochure');
    if (quiet.length) notes.push(`Filled from the dashboard: ${esc(quiet.join(', ').toLowerCase())}`);
    // Unlocked for a redo: the brochure that was showing then does not count — only a new one does.
    const oldLink = x.brochure && x.brochure.unlockedLink;
    if (isUrl(p.brochureLink) && !(x.brochure && x.brochure.doneAt) && str(p.brochureLink) !== str(oldLink)) {
      patch.brochure = { ...(x.brochure || {}), code: p.propertyCode, doneAt: now };
      notes.push('Brochure delivered — marked done');
    } else if (f.patch.brochureLink) notes.push('Brochure link updated from the dashboard');
    if (Object.keys(patch).length) out.push({ id: x.id, patch, history: notes.join(' · ') || null });
  }
  return out;
}

// The same Google Form the Create brochure page (dashboard-assets/brochure-form.js) posts to,
// so a brochure asked for from a listing goes down the very same pipeline. If the form's
// entry ids ever change, change them in both places — tests/brochure-flow.test.mjs checks they match.
export const FORM_ACTION = 'https://docs.google.com/forms/d/e/1FAIpQLSdhhCVV3frLlFaN8FXpGB0exOXT2He4VWPnOqTdEUeV82fLMA/formResponse';
export const FORM_FIELDS = { title: 'entry.1238821452', drive: 'entry.1785532374', details: 'entry.134248436', internal: 'entry.1764716931' };
export function formBody(listing) {
  const x = listing || {};
  const p = new URLSearchParams();
  p.append(FORM_FIELDS.title, brochureTitle(x));
  p.append(FORM_FIELDS.drive, str(x.photosLink));
  p.append(FORM_FIELDS.details, str(x.description));
  if (str(x.internalNotes)) p.append(FORM_FIELDS.internal, str(x.internalNotes));
  return p;
}
