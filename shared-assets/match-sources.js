// ═══════════════════════════════════════════════════════════════════════════
// PIN SOURCES — every property opportunity we hold, in one matchable list
// ═══════════════════════════════════════════════════════════════════════════
//
// The matching engine (match-engine.js, window.PinMatch) scores a requirement against a property.
// Until Nov 2026 every "properties for this buyer" screen handed it ONLY the onboarded inventory
// (the `properties` collection). Everything still on its way in — a seller who wrote in last
// week, a card on the Shoot & Media board waiting for details or a shoot, an agent's submission
// waiting for approval — was invisible to every buyer, which is exactly the stock a broker most
// needs to match early. This file is the fix: one list over all of it, each entry saying plainly
// where it came from, how far it has got, and how much of what it says has been checked.
//
//   Onboarded property   properties/{id}              verified — it went through the inventory sheet
//   Shoot board card     listings/{id}                seller-provided (+ what the chat said)
//   CRM seller lead      leads/{id} (a seller)        seller-provided / read from the chat
//   Agent submission     propertySubmissions/{id}     agent-provided, pending approval
//
// It never creates or copies a record. Each entry keeps the ids of the records it was read from,
// so every screen can open the original. When the same property is in more than one place (a
// seller lead AND its board card, a card that became a property), the furthest-along record
// stands for it and the others are listed under `alsoIn` — one property, one row.
//
// Pure: no DOM, no network. The Match page, the CRM, the Track board and the server (Eåsy, the
// agents' API) all run this same file, so a website search and an Eåsy answer cannot disagree.
// A plain script (window.PinSources) for the same reason match-engine.js is one.

(function (root) {
  'use strict';

  const M = () => {
    const m = root.PinMatch;
    if (!m) throw new Error('PinSources needs PinMatch (shared-assets/match-engine.js) loaded first');
    return m;
  };
  const G = () => root.PinGeo;
  const DAY = 86400000;
  const lc = v => String(v == null ? '' : v).trim().toLowerCase();
  const ms = v => (typeof v === 'number' ? v : v && typeof v.toMillis === 'function' ? v.toMillis() : v && typeof v.seconds === 'number' ? v.seconds * 1000 : 0);
  const phoneKey = v => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };

  // ── Where an opportunity stands ──────────────────────────────────────────
  //
  // The Shoot & Media board's stages, as a buyer-matching screen should name them. A custom column
  // falls back to its own name and kind (trackPipelines/{tenant}.stages).
  const TRACK_STATUS = {
    new_listing: { label: 'New enquiry', order: 1 },
    details: { label: 'More details pending', order: 2 },
    shoot_scheduled: { label: 'Shoot pending', order: 3 },
    shoot_done: { label: 'Shoot completed', order: 4 },
    media_ready: { label: 'Media ready', order: 5 },
    for_approval: { label: 'Awaiting owner approval', order: 6 },
    approved: { label: 'Approved — not yet live', order: 7 },
    live: { label: 'Live — not yet in inventory', order: 8 },
    on_hold: { label: 'On hold', order: 0 }
  };
  const TRACK_GONE = new Set(['closed', 'dropped']);

  function trackStatus(listing, stages) {
    const id = String((listing && listing.stageId) || '');
    const st = (stages || []).find(s => s && (s.id === id || s.key === id)) || null;
    const key = (st && st.key) || id;
    if (TRACK_GONE.has(key) || (st && /closed|dropped|lost/.test(lc(st.kind)))) return null;
    const known = TRACK_STATUS[key];
    return { key: key || 'new_listing', label: known ? known.label : (st && st.name) || 'On the Shoot board', order: known ? known.order : 1 };
  }

  // An onboarded property's own availability. Sold, let and withdrawn stock stays out of matching
  // (a veto would only clutter the "ruled out" list); on hold stays in, labelled.
  const GONE = /\b(sold|let out|rented(?: out)?|leased out|withdrawn|inactive|not available|unavailable|closed)\b/i;
  function propertyStatus(p) {
    if (!p) return null;
    if (p.soldOut === true || GONE.test(String(p.availability || ''))) return null;
    if (/\bon\s*hold\b/i.test(String(p.availability || ''))) return { key: 'on_hold', label: 'On hold' };
    if (p.listingHidden === true) return { key: 'hidden', label: 'Approved — not yet live' };
    return { key: 'available', label: 'Onboarded · available' };
  }

  const SOURCE = {
    onboarded: { label: 'Onboarded property', rank: 4, trust: 'verified' },
    listing: { label: 'Shoot board', rank: 3, trust: 'seller' },
    submission: { label: 'Agent submission', rank: 2, trust: 'agent' },
    seller: { label: 'CRM seller lead', rank: 1, trust: 'seller' }
  };
  const TRUST_LABEL = {
    verified: 'Verified (inventory)', seller: 'Seller-provided', agent: 'Agent-provided',
    chat: 'Read from the chat (AI-extracted)', missing: 'Not known yet'
  };

  // A seller lead, as the pipeline sees it: still a live opportunity?
  function isSellerLead(l) {
    if (!l) return false;
    if (/seller\s*listing/i.test(String(l.enquiryType || ''))) return true;
    const i = l.ai && l.ai.intent;
    return (i === 'sell' || i === 'rent_out') && (!l.ai.confidence || l.ai.confidence === 'high') && !(l.ttHold && l.ttHold.enquiryType);
  }

  // What each fact on an entry rests on — so a card's price is never shown as if it were checked.
  function factsOf(prof, kind, raw) {
    const out = [];
    const put = (label, value, src) => out.push({ label, value: value == null || value === '' ? null : value, src: value == null || value === '' ? 'missing' : src });
    const P = M();
    const base = kind === 'onboarded' ? 'verified' : kind === 'submission' ? 'agent' : 'seller';
    const fromChat = (field) => {
      if (kind === 'onboarded' || kind === 'submission') return base;
      if (kind === 'listing') return raw.listing && raw.listing[field] ? 'seller' : 'chat';
      return raw.lead && raw.lead[field === 'askingPrice' ? 'budget' : 'propertyInterest'] ? 'seller' : 'chat';
    };
    put('Type', prof.type && prof.type !== 'Other' ? (root.PinSearch && root.PinSearch.TYPE_LABEL[prof.type]) || prof.type : null, kind === 'listing' ? (raw.listing && (raw.listing.propType || raw.listing.propertyType) ? 'seller' : 'chat') : base);
    put('Location', prof.localities && prof.localities.length ? prof.localities.map(k => (G() ? G().label(k) : k)).join(', ') : (prof.locationText || null), fromChat('location'));
    put(prof.deal === 'rent' ? 'Rent' : 'Price', P.priceLabel(prof) || null, fromChat('askingPrice'));
    put('Size', prof.areaLo != null ? P.fmtArea(prof.areaLo, prof.areaHi) : prof.landLo != null ? P.fmtArea(prof.landLo, prof.landHi) + ' land' : null, kind === 'listing' ? (raw.listing && raw.listing.sqft ? 'seller' : 'chat') : base);
    if (prof.type !== 'Plot' && prof.type !== 'Commercial') put('Configuration', prof.bhk && prof.bhk.length ? prof.bhk.join(' / ') + ' BHK' : null, kind === 'listing' ? (raw.listing && raw.listing.config ? 'seller' : 'chat') : base);
    return out;
  }

  // ── The unified list ─────────────────────────────────────────────────────
  //
  // data: { properties, listings, leads, submissions, trackStages }
  // opts: { includeGone }   → an array of property profiles, each with .src (see below), and
  //                           .raw: the plain records behind it. The array carries .raw too: the
  //                           plain properties, for the area model and idf (PinMatch caches both
  //                           on the array, so it must be the same array on every call).
  function buildUnified(data, opts) {
    const o = opts || {};
    const P = M();
    const props = (data.properties || []).filter(Boolean);
    const listings = (data.listings || []).filter(x => x && x.kind !== 'series');
    const leads = (data.leads || []).filter(Boolean);
    const subs = (data.submissions || []).filter(Boolean);
    const leadById = new Map(leads.map(l => [String(l.id), l]));
    const propById = new Map();
    props.forEach(p => { propById.set(String(p.id), p); if (p.propertyCode) propById.set(String(p.propertyCode).toUpperCase(), p); });
    const propOfListing = new Map(props.filter(p => p.listingId).map(p => [String(p.listingId), p]));
    const out = [];
    const byPhone = new Map();
    const remember = (entry, phone) => { const k = phoneKey(phone); if (k) { if (!byPhone.has(k)) byPhone.set(k, []); byPhone.get(k).push(entry); } };

    // 1. Onboarded. The inventory itself holds the odd duplicate row (the same flat entered twice
    // under two codes): same name, same place, same price is one property, shown once.
    const seenSame = new Map();
    for (const p of props) {
      const st = propertyStatus(p);
      if (!st && !o.includeGone) continue;
      let prof;
      try { prof = P.propertyProfile(p); } catch (e) { continue; }
      const same = [lc(p.name).replace(/[^a-z0-9]/g, ''), prof.localities[0] || lc(p.location), prof.priceLo || '', (prof.bhk || []).join('/')].join('|');
      if (lc(p.name) && seenSame.has(same)) {
        seenSame.get(same).src.alsoIn.push({ type: 'property', id: String(p.id), label: 'Duplicate inventory row ' + (p.propertyCode || p.id) });
        continue;
      }
      prof.src = {
        kind: 'onboarded', label: SOURCE.onboarded.label, status: st ? st.label : 'Sold / let', statusKey: st ? st.key : 'gone',
        trust: 'verified', verified: true, link: { type: 'property', id: String(p.id) },
        ids: { propertyId: String(p.id), listingId: p.listingId ? String(p.listingId) : null }, code: p.propertyCode || p.id,
        createdAt: ms(p.createdAt), updatedAt: ms(p.updatedAt) || ms(p.syncedAt), alsoIn: [], agent: lc(Array.isArray(p.assignedAgent) ? p.assignedAgent[0] : p.assignedAgent)
      };
      prof.src.facts = factsOf(prof, 'onboarded', { p });
      seenSame.set(same, prof);
      out.push(prof);
      remember(prof, p.contactNumber);
    }

    // 2. Shoot board cards not yet in the inventory.
    const listingIdsCovered = new Set();
    for (const li of listings) {
      const onboarded = (li.propertyCode && propById.get(String(li.propertyCode).toUpperCase())) || propOfListing.get(String(li.id));
      if (onboarded) {
        listingIdsCovered.add(String(li.id));
        const host = out.find(e => e.src.ids.propertyId === String(onboarded.id));
        if (host) host.src.alsoIn.push({ type: 'listing', id: String(li.id), label: 'Shoot board card' });
        continue;
      }
      const st = trackStatus(li, data.trackStages);
      if (!st) continue;
      const lead = li.leadId ? leadById.get(String(li.leadId)) : null;
      let prof;
      try { prof = P.listingProfile(li, { lead }); } catch (e) { continue; }
      listingIdsCovered.add(String(li.id));
      prof.src = {
        kind: 'listing', label: SOURCE.listing.label, status: st.label, statusKey: st.key, order: st.order,
        trust: 'seller', verified: false, link: { type: 'listing', id: String(li.id) },
        ids: { listingId: String(li.id), leadId: li.leadId ? String(li.leadId) : null }, code: li.propertyCode || null,
        createdAt: ms(li.createdAt), updatedAt: ms(li.updatedAt) || ms(li.stageChangedAt), alsoIn: lead ? [{ type: 'lead', id: String(lead.id), label: 'CRM seller lead' }] : [],
        sellerName: li.sellerName || (lead && lead.name) || '', agent: lc(li.assignedAgent || li.createdBy || '')
      };
      prof.src.facts = factsOf(prof, 'listing', { listing: li, lead });
      out.push(prof);
      remember(prof, li.sellerPhone || (lead && lead.phone));
    }

    // 3. Agent submissions still waiting.
    for (const sb of subs) {
      if (String(sb.status || 'pending') !== 'pending') continue;
      const f = sb.fields || {};
      const asProperty = Object.assign({}, f, { id: 'sub:' + sb.id, propertyCode: null, detailsText: f.notes || '' });
      let prof;
      try { prof = P.propertyProfile(asProperty); } catch (e) { continue; }
      prof.kind = 'property';
      prof.provisional = true;
      prof.src = {
        kind: 'submission', label: SOURCE.submission.label, status: 'Pending approval', statusKey: 'pending',
        trust: 'agent', verified: false, link: { type: 'submission', id: String(sb.id) },
        ids: { submissionId: String(sb.id) }, code: null, createdAt: ms(sb.createdAt), updatedAt: ms(sb.updatedAt) || ms(sb.createdAt),
        alsoIn: [], agent: lc(sb.agentEmail || sb.createdBy || '')
      };
      prof.src.facts = factsOf(prof, 'submission', {});
      out.push(prof);
      remember(prof, f.contactNumber);
    }

    // 4. Seller leads with no card and no property — written in, not yet processed.
    for (const l of leads) {
      if (!isSellerLead(l) || P.isClosedLead(l)) continue;
      if (l.listingId && listingIdsCovered.has(String(l.listingId))) {
        // The card (or the property it became) stands for this lead: say so on it.
        const host = out.find(e => e.src.ids.listingId === String(l.listingId)) || out.find(e => e.src.alsoIn.some(a => a.type === 'listing' && a.id === String(l.listingId)));
        if (host && !host.src.alsoIn.some(a => a.type === 'lead' && a.id === String(l.id))) host.src.alsoIn.push({ type: 'lead', id: String(l.id), label: 'CRM seller lead' });
        continue;
      }
      if (l.listingId && listings.some(x => String(x.id) === String(l.listingId))) continue;   // card closed/dropped: so is the opportunity
      const code = (l.propertyCodes || [])[0];
      if (code && propById.get(String(code).toUpperCase())) continue;
      let prof;
      try { prof = P.ownerPropertyProfile(l); } catch (e) { continue; }
      // Nothing to match on at all (no place, no type, no price): not a property yet.
      if (!prof.localities.length && (!prof.type || prof.type === 'Other') && prof.priceLo == null) continue;
      prof.src = {
        kind: 'seller', label: SOURCE.seller.label, status: 'Not yet processed', statusKey: 'unprocessed',
        trust: 'seller', verified: false, link: { type: 'lead', id: String(l.id) },
        ids: { leadId: String(l.id) }, code: null, createdAt: ms(l.createdAt), updatedAt: ms(l.updatedAt),
        alsoIn: [], sellerName: l.name || '', agent: lc(l.assignedAgent || '')
      };
      prof.src.facts = factsOf(prof, 'seller', { lead: l });
      out.push(prof);
      remember(prof, l.phone);
    }

    // 5. One property, one row: the same owner's number in several places (a submission and a
    // card for the same flat) folds into the furthest-along record — but only when the two also
    // agree on what the property is (same type, and the same place or the same price), because one
    // owner can be selling two flats.
    const drop = new Set();
    for (const group of byPhone.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => SOURCE[b.src.kind].rank - SOURCE[a.src.kind].rank);
      const keep = group[0];
      for (const e of group.slice(1)) {
        if (e === keep || drop.has(e)) continue;
        const sameType = !e.type || !keep.type || e.type === keep.type || e.type === 'Other' || keep.type === 'Other';
        const samePlace = e.localities.some(k => keep.localities.includes(k));
        const samePrice = e.priceLo && keep.priceLo && Math.abs(e.priceLo / keep.priceLo - 1) <= 0.05;
        if (sameType && (samePlace || samePrice)) {
          drop.add(e);
          keep.src.alsoIn.push({ type: e.src.link.type, id: e.src.link.id, label: e.src.label });
        }
      }
    }
    const list = out.filter(e => !drop.has(e));
    list.raw = props.slice();
    return list;
  }

  // ── A lead, for a result row ─────────────────────────────────────────────
  function stageOf(lead, stages) {
    const st = (stages || []).find(s => s && s.id === lead.stageId) || null;
    return { name: (st && st.name) || String(lead.stageId || 'New'), kind: (st && st.kind) || (M().isClosedLead(lead) ? 'lost' : 'open') };
  }
  function lastTouch(lead) {
    const tt = lead.tt || {};
    return Math.max(ms(tt.lastMessageAt), ms(lead.lastNote && lead.lastNote.createdAt), ms(lead.contactAt), ms(lead.lastContactAt), ms(lead.updatedAt) || 0) || ms(lead.createdAt);
  }
  // A stage key (closed_lost / lost / won …) the engine understands, from the tenant's pipeline.
  function stageKeyFor(stages) {
    return lead => {
      const st = (stages || []).find(s => s && s.id === lead.stageId);
      if (st && st.kind === 'lost') return 'lost';
      if (st && st.kind === 'won') return 'won';
      return null;
    };
  }

  // ── Explaining a pair ────────────────────────────────────────────────────
  function budgetDiff(req, prop) {
    const P = M();
    if (!req || !req.budget || prop.priceLo == null || req.budget.mode !== prop.priceMode) return null;
    const max = req.budget.max;
    const d = prop.priceLo - max;
    const pct = Math.round(d / max * 100);
    const per = prop.priceMode === 'monthly' ? ' a month' : '';
    const under = max - prop.priceLo;
    // A single figure is a ceiling: below it is simply within budget (the inferred floor is the
    // engine's, not something they said). Only a range they stated has an "under their range".
    // Over a budget they called flexible ("around 3 Cr") by a fifth or less: a stretch to put to them, not a no.
    if (d > 0) return { pct, text: `${P.fmtMoney(d)}${per} over budget (${pct}%)`, within: false, soft: !!req.budget.flexible && pct <= 20 };
    if (under < max * 0.01) return { pct, text: 'Right at their budget', within: true };
    if (!req.budget.firm && !req.budget.minOnly && (prop.priceHi || prop.priceLo) < (req.budget.min || 0)) return { pct, text: `${P.fmtMoney(req.budget.min - (prop.priceHi || prop.priceLo))}${per} below the range they gave`, within: true };
    return { pct, text: `Within budget — ${P.fmtMoney(under)}${per} under`, within: true };
  }
  // The card's fit lines are facts; "little in common with how they describe…" is the semantic
  // layer's guess — it stays in "Why this score", not on the card.
  const SOFT_KEYS = new Set(['lifestyle', 'taste']);
  const summaryOnly = list => (list || []).filter(x => !SOFT_KEYS.has(x.key));
  function locationCompat(row) {
    const b = (row.breakdown || []).find(x => x.key === 'locality');
    if (!b) return { level: 'unknown', text: 'Not compared' };
    if (b.veto) return { level: 'excluded', text: b.why };
    if (b.unknown) return { level: 'unknown', text: b.why };
    const level = b.s >= 0.99 ? 'exact' : b.s >= 0.7 ? 'nearby' : b.s >= 0.4 ? 'reachable' : 'far';
    return { level, text: b.why };
  }
  // Two or more of the facts a match stands on unknown (their budget, the place, the kind, the
  // bedrooms, rent or buy): however high the number, it is "worth a call" to find out — not strong.
  const KEY_FACTS = ['budget', 'locality', 'type', 'bhk', 'deal'];
  function qualityOf(row) {
    const P = M();
    let band = P.band(row.pct, row.vetoed);
    const unknownKeys = (row.unknown || []).filter(u => KEY_FACTS.includes(u.key)).length;
    if (!row.vetoed && band.key === 'strong' && unknownKeys >= 2) band = { key: 'good', label: 'Worth a call', capped: true };
    const conf = row.confidence >= 0.8 ? 'High' : row.confidence >= 0.5 ? 'Medium' : 'Low';
    return { band, confidence: conf };
  }
  // The next thing a person should do about this pair, from what the score and the record say.
  function nextAction(row, prop, dir) {
    const src = (prop && prop.src) || {};
    const asks = (row.unknown || []).filter(u => u.ask).slice(0, 2).map(u => u.ask.replace(/\.$/, ''));
    if (row.vetoed) return 'Ruled out — ' + ((row.vetoes[0] && row.vetoes[0].why) || 'see why');
    if (src.kind === 'seller') return `Call the owner to get the details${asks.length ? ' (' + asks.join('; ').toLowerCase() + ')' : ''} — this buyer fits`;
    if (src.kind === 'listing' && /details|enquiry/i.test(src.status)) return 'Complete the details and book the shoot — a buyer is waiting';
    if (src.kind === 'listing' && /shoot pending/i.test(src.status)) return 'Prioritise the shoot — a buyer is waiting';
    if (src.kind === 'listing') return 'Share the photos and video — onboarding is under way';
    if (src.kind === 'submission') return 'Approve the submission so it can be shared';
    if (asks.length && row.confidence < 0.6) return asks.join('; ');
    if (row.pct >= 85) return dir === 'clients' ? 'Call today and offer a visit' : 'Share it and offer a visit';
    if (row.pct >= 70) return dir === 'clients' ? 'Send the details on WhatsApp' : 'Send the details — worth a call';
    return asks[0] || 'Keep as a back-up option';
  }

  function propertyRow(row) {
    const prop = row.property;
    const q = qualityOf(row);
    const src = prop.src || { kind: 'onboarded', label: SOURCE.onboarded.label, status: '', trust: 'verified', link: { type: 'property', id: String(row.p && row.p.id) }, facts: [] };
    return {
      id: src.link.type + ':' + src.link.id,
      name: prop.name, code: src.code || prop.code || null,
      type: prop.type, sub: prop.sub || null, deal: prop.deal, jv: !!prop.jv,
      bhk: prop.bhk, price: M().priceLabel(prop) || '', priceLo: prop.priceLo,
      // Land is a plot's size; for a flat project the "total land area" is the whole site, not the flat.
      area: prop.type === 'Plot' && prop.landLo != null ? M().fmtArea(prop.landLo, prop.landHi) + ' land' : prop.areaLo != null ? M().fmtArea(prop.areaLo, prop.areaHi) : (prop.landLo != null && ['House', 'Plot', 'Other'].includes(prop.type || 'Other') ? M().fmtArea(prop.landLo, prop.landHi) + ' land' : ''),
      areaLo: prop.type === 'Plot' && prop.landLo != null ? prop.landLo : prop.areaLo,
      dealLabel: prop.jvOnly ? 'Joint venture' : prop.jv ? (prop.deal === 'rent' ? 'For rent' : 'For sale · open to JV') : prop.deal === 'rent' ? (prop.priceMode === 'lumpsum' ? 'For lease' : 'For rent') : 'For sale',
      location: prop.localities && prop.localities.length ? prop.localities.map(k => G().label(k)).join(', ') : prop.locationText,
      source: src.kind, sourceLabel: src.label, status: src.status, statusKey: src.statusKey, trust: src.trust, trustLabel: TRUST_LABEL[src.trust] || '',
      verified: !!src.verified, facts: src.facts || [], alsoIn: src.alsoIn || [], link: src.link,
      createdAt: src.createdAt || 0, updatedAt: src.updatedAt || 0, agent: src.agent || '',
      pct: row.pct, vetoed: row.vetoed, vetoes: row.vetoes, band: q.band, confidence: q.confidence, confidenceValue: row.confidence,
      for: summaryOnly(row.for), against: summaryOnly(row.against), unknown: row.unknown, breakdown: row.breakdown,
      budget: budgetDiff(row.req, prop), location2: locationCompat(row), reqIndex: row.reqIndex || 0,
      next: nextAction(row, prop, 'properties'), rank: row.rank
    };
  }

  function clientRow(row, ctx) {
    const c = ctx || {};
    const l = row.lead, req = row.req;
    const q = qualityOf(row);
    const st = stageOf(l, c.stages);
    const P = M();
    const TL = root.PinSearch ? root.PinSearch.TYPE_LABEL : {};
    return {
      id: 'lead:' + l.id, leadId: String(l.id),
      name: l.name || '(no name)', phone: l.phone || '', email: l.email || '',
      owner: lc(l.assignedAgent || l.assignedTo || ''), ownerName: c.nameOf ? c.nameOf(l.assignedAgent || l.assignedTo) : '',
      budget: req.budget ? req.budget.stated : '', budgetMax: req.budget ? req.budget.max : null, budgetMode: req.budget ? req.budget.mode : null,
      locations: req.localities ? (req.localities.anywhere && !req.localities.keys.length ? ['Anywhere in Chennai'] : req.localities.zones && req.localities.zones.length && !req.localities.keys.length ? req.localities.zones.map(z => z.replace(/^Chennai (\w+)$/, '$1 Chennai')) : req.localities.keys.map(k => G().label(k))) : [],
      exclude: req.localities && req.localities.exclude ? req.localities.exclude.map(k => G().label(k)) : [],
      config: req.bhk ? req.bhk.values.join(' / ') + ' BHK' : '',
      types: req.types ? (req.types.residentialOnly ? ['Residential'] : req.types.values.map(t => TL[t] || t)) : [],
      sub: req.types && req.types.subs ? Object.values(req.types.subs).map(sb => P.SUB_LABEL[sb]).join(', ') : '',
      area: req.size ? (req.size.unit === 'land' ? `${Math.round(req.size.min / 2400 * 10) / 10} grounds` : P.fmtArea(req.size.min, req.size.max)) : '',
      deal: req.deal ? req.deal.values : [], dealLabel: req.deal ? req.deal.values.map(v => ({ sale: 'Buy', rent: 'Rent / lease', jv: 'Joint venture' }[v] || v)).join(' or ') : '',
      // What a property-side filter can test on a client: the kinds, bedrooms and money they want.
      type: req.types && req.types.values.length === 1 ? req.types.values[0] : null,
      bhk: req.bhk ? req.bhk.values.slice() : [], priceLo: null, areaLo: req.size ? req.size.min : null,
      reqText: req.reqText || '', reqIndex: row.reqIndex || 0, reqCount: row.reqCount || 1, reqSrc: req.reqSrc || 'lead',
      pct: row.pct, vetoed: row.vetoed, vetoes: row.vetoes, band: q.band, confidence: q.confidence, confidenceValue: row.confidence,
      for: summaryOnly(row.for), against: summaryOnly(row.against), unknown: row.unknown, breakdown: row.breakdown,
      budgetDiff: budgetDiff(req, row.property), location2: locationCompat(row),
      interest: row.interest ? row.interest.level : '', interestWhy: row.interest ? row.interest.why : [],
      lastTouch: lastTouch(l), reqUpdated: Math.max(ms(l.reqs && l.reqs.at), ms(l.ai && l.ai.at), ms(l.updatedAt)) || ms(l.createdAt),
      stage: st.name, stageKind: st.kind, leadSource: l.source || l.channel || (l.tt ? 'WhatsApp (TailorTalk)' : ''),
      next: nextAction(row, row.property, 'clients'), rank: row.rank
    };
  }

  // ── The two directions ───────────────────────────────────────────────────
  //
  // findProperties(lead | requirement profile | typed text, unified, opts) → rows, best first.
  function findProperties(who, unified, opts) {
    const o = opts || {};
    const P = M();
    const req = typeof who === 'string' ? P.briefProfile(who, { now: o.now }) : who;
    // 50 by default: below it is a long shot nobody would call about (the page can lower it).
    const rows = P.propertiesFor(req, unified, { area: areaFor(unified), now: o.now, minPct: o.minPct == null ? 50 : o.minPct, includeVetoed: !!o.includeVetoed, includeSeen: true, reqIndex: o.reqIndex });
    return rows.map(propertyRow);
  }
  // findClients(property profile | inventory property | typed details, leads, opts) → rows.
  function findClients(what, leads, opts) {
    const o = opts || {};
    const P = M();
    const prop = what && what.kind ? what : (what && what.__details ? propertyFromDetails(what) : P.propertyProfile(what));
    const rows = P.buyersFor(prop, leads, { inventory: o.inventory, now: o.now, minPct: o.minPct == null ? 50 : o.minPct, includeVetoed: !!o.includeVetoed, stageKeyOf: o.stages ? stageKeyFor(o.stages) : undefined, area: o.area || (o.unified ? areaFor(o.unified) : undefined) });
    return rows.map(r => clientRow(r, { stages: o.stages, nameOf: o.nameOf }));
  }

  // Typed property details (the "Find clients for a property" form) → a property profile, through
  // the same profiler an inventory property goes through.
  // d: { type, sub, bhk, location, area, areaUnit, price, priceUnit, deal, status, condition, amenities, notes }
  const UNIT_SQFT = { sqft: 1, sqm: 10.7639, grounds: 2400, ground: 2400, cents: 435.6, cent: 435.6, acres: 43560, acre: 43560 };
  function propertyFromDetails(d) {
    const x = d || {};
    const unit = UNIT_SQFT[lc(x.areaUnit) || 'sqft'] || 1;
    const sqft = Number(x.area) > 0 ? Math.round(Number(x.area) * unit) : null;
    const land = /plot|land/i.test(x.type || '') || ['grounds', 'ground', 'cents', 'cent', 'acres', 'acre'].includes(lc(x.areaUnit));
    const price = Number(x.price) > 0 ? Number(x.price) : null;
    const rent = x.deal === 'rent' || x.deal === 'lease';
    // A Chennai "lease" is usually a lump sum (₹5 L and up); a smaller figure is a monthly rent.
    const priceText = price ? (x.deal === 'lease' && price >= 500000 ? `${price} lease amount` : rent ? `Rent ${price} per month` : String(price)) : (x.priceText || '');
    const fake = {
      id: '__typed__', name: x.name || [x.bhk ? x.bhk + ' BHK' : '', x.sub || x.type || 'Property', x.location ? 'in ' + x.location : ''].filter(Boolean).join(' '),
      type: x.sub ? `${x.type || ''} ${x.sub}` : (x.type || ''), config: x.bhk ? x.bhk + ' BHK' : '', location: x.location || '',
      startingPrice: priceText, dealType: x.deal === 'jv' ? 'jv' : rent ? 'rent' : x.deal === 'sale' ? 'sale' : '',
      status: /ready/i.test(x.status || '') ? 'Ready to Move' : /under/i.test(x.status || '') ? 'Under Construction' : '',
      saleType: /resale/i.test(x.condition || x.status || '') ? 'Resale' : /new/i.test(x.condition || '') ? 'New' : '',
      sqftRange: !land && sqft ? sqft + ' sqft' : '', totalLandArea: land && sqft ? sqft + ' sqft' : '',
      amenities: x.amenities || '', highlights: [x.notes, x.deal === 'jv' ? 'Open for joint venture' : ''].filter(Boolean).join(' | '),
      facing: x.facing || '', furnishing: x.furnishing || ''
    };
    const prof = M().propertyProfile(fake);
    prof.src = { kind: 'typed', label: 'Typed property', status: '', trust: 'seller', link: { type: 'typed', id: '' }, facts: [] };
    return prof;
  }

  // The area model over the inventory plus every Shoot card, cached on the unified list.
  function areaFor(unified) {
    if (unified.__area) return unified.__area;
    const extra = unified.filter(e => e.src && e.src.kind === 'listing' && e.listing).map(e => e.listing);
    const a = M().areaModelFor(unified.raw || [], extra.length ? extra : null);
    try { Object.defineProperty(unified, '__area', { value: a, enumerable: false }); } catch (e) { /* frozen: rebuild next time */ }
    return a;
  }

  // ── Demand for un-onboarded stock ────────────────────────────────────────
  // "Show seller leads not yet onboarded that already have matching buyers": each un-onboarded
  // entry with how many live buyers fit it (≥ minPct), best first.
  function demandFor(unified, leads, opts) {
    const o = opts || {};
    const P = M();
    const kinds = o.kinds || ['listing', 'seller', 'submission'];
    const out = [];
    // One area model for the whole run, knowing every card's place — built per card it was most of
    // the time this took.
    const area = o.area || areaFor(unified);
    for (const e of unified) {
      if (!kinds.includes(e.src.kind)) continue;
      if (o.statusKeys && !o.statusKeys.includes(e.src.statusKey)) continue;
      // The same floor "See buyers" lists from (50%), uncapped, so the count on the card is the list.
      const rows = P.buyersFor(e, leads, { inventory: unified.raw, area, now: o.now, minPct: o.minPct == null ? 50 : o.minPct, stageKeyOf: o.stages ? stageKeyFor(o.stages) : undefined });
      if (!rows.length && !o.keepEmpty) continue;
      // "Strong" needs both a high score and enough known to trust it — a card that says only
      // "Anna Nagar, 2.3 Cr" fits everyone vaguely and nobody for certain.
      const best = rows.slice().sort((a, b) => b.pct - a.pct || b.rank - a.rank).slice(0, 3);
      out.push({ entry: e, buyers: rows.length, strong: rows.filter(r => r.pct >= 80 && r.confidence >= 0.6).length, ids: rows.map(r => String(r.lead.id)),
        top: best.map(r => { const ph = String(r.lead.phone || '').replace(/\D/g, ''); return { leadId: String(r.lead.id), name: r.lead.name || '', pct: r.pct, phoneEnd: ph ? '…' + ph.slice(-4) : '' }; }) });
    }
    out.sort((a, b) => b.strong - a.strong || b.buyers - a.buyers);
    return out;
  }

  // ── Reading a search box ─────────────────────────────────────────────────
  //
  // Which way a sentence asks: for properties, for clients, or for the un-onboarded stock that
  // already has buyers. Deterministic — the AI interpreter (api/_match.js) may refine the fields,
  // but the direction never depends on it.
  // Asking FOR clients, not about one: plural ("buyers looking for…", "clients who want…"), "any
  // buyer", "a buyer for…", "who wants…". "A 3 BHK for MY client in Anna Nagar" and a pasted remark
  // ("Client called yesterday, wants…") describe one person's requirement — properties.
  const CLIENT_WORDS = /\b(?:buyers|clients|customers|tenants|any\s+(?:buyer|client|tenant|customer)s?|(?:a\s+|find\s+(?:a\s+)?)?(?:buyer|tenant|client)s?\s+for\s+(?:a|an|the|this|our|my)?\s*(?:\d\s*bhk|flat|apartment|villa|house|plot|land|property|office|shop|showroom|space|[A-Z]{2,5}\d{3,4})|leads?\s+(?:looking|who|wanting|for)|who\s+(?:wants?|is\s+looking|are\s+looking|needs?)|people\s+(?:looking|who)|requirements?\s+(?:for|matching|that)|active\s+requirements?|demand\s+for)\b/i;
  const ABOUT_ONE = /\b(?:my|our|the|this)\s+(?:client|customer|buyer|tenant)\b(?!s)|\b(?:client|customer|buyer)\s+(?:called|said|wants|needs|is|was|has|asked|told|visited|liked)\b/i;
  const SELLER_WORDS = /\b(?:sellers?|owners?|seller\s*leads?|landlords?)\b/;
  const UNPROCESSED = /\b(?:unprocessed|not\s*(?:yet\s*)?(?:onboarded|processed|mapped)|un-?onboarded|pending\s*onboarding|in\s*the\s*crm\s*(?:that|which)?\s*(?:are\s*)?not)\b/;
  const SHOOT = /\bshoot(?:\s*(?:stage|board|pending|scheduled|done))?\b/;
  const WITH_BUYERS = /\b(?:that\s*match|matching|have\s*matching|with\s*matching|that\s*have|with|having|and\s*their)\s*(?:active\s*|matching\s*|interested\s*)?(?:buyers?|clients?|requirements?|demand)\b|\bactive\s*(?:buyer\s*)?requirements?\s*matching\b/;
  function parseSmartQuery(text) {
    const raw = String(text || '').trim();
    const s = lc(raw);
    let direction = 'properties';
    let scope = null;
    if ((UNPROCESSED.test(s) || SHOOT.test(s) || SELLER_WORDS.test(s)) && WITH_BUYERS.test(s)) {
      direction = 'demand';
      scope = SHOOT.test(s) ? 'shoot' : 'unprocessed';
    } else if (/\b(?:a\s+|any\s+|find\s+(?:a\s+)?)(?:buyer|tenant|client)s?\s+for\b/.test(s) || (CLIENT_WORDS.test(s) && !SELLER_WORDS.test(s) && !(ABOUT_ONE.test(s) && !/\b(?:buyers|clients|tenants|customers)\b/.test(s)))) direction = 'clients';
    else if (SELLER_WORDS.test(s) || UNPROCESSED.test(s)) { direction = 'properties'; scope = 'unonboarded'; }
    // The words that set the direction are not part of the requirement.
    const cleaned = raw
      .replace(/^\s*(?:find|show|list|get|search|give\s*me|any)\s+(?:me\s+)?(?:all\s+)?/i, '')
      .replace(/\b(?:buyers?|clients?|customers?|tenants?|people|leads?)\s+(?:who\s+(?:are|is)\s+)?(?:looking|searching|asking)\s+for\b/i, '')
      .replace(/\b(?:who\s+(?:want|wants|need|needs))\b/i, '')
      .trim();
    // "above ₹3 Cr" said of CLIENTS is a filter on their budget, not a property price.
    let budgetFilter = null;
    if (direction === 'clients') {
      const m = s.match(/\b(above|over|more\s*than|below|under|less\s*than|upto|up\s*to)\s*(?:rs\.?|₹|inr)?\s*([\d.,]+)\s*(cr|crore|crores|l|lakh|lakhs|k)?\b/);
      if (m) {
        const n = parseFloat(m[2].replace(/,/g, ''));
        const mult = /^cr/.test(m[3] || '') ? 1e7 : /^l/.test(m[3] || '') ? 1e5 : /^k/.test(m[3] || '') ? 1e3 : (n < 100 ? 1e7 : 1);
        budgetFilter = { cmp: /above|over|more/.test(m[1]) ? 'gte' : 'lte', value: Math.round(n * mult) };
      }
    }
    return { direction, scope, text: cleaned || raw, budgetFilter };
  }

  // A clients-direction sentence ("buyers looking for 3 BHK apartments in Adyar") → a property
  // profile to find them with: the sentence read as a brief, turned round into a property.
  // A property described in words — one that may be nowhere in our records yet ("a seller just
  // called: 3BHK in Anna Nagar, 2000 sqft, 3.2 Cr, east facing, covered parking, resale") — turned
  // into a property, so every client can be scored against it. Everything said is kept: the
  // facts the form has fields for, and the rest (facing, parking, floor, amenities, approvals,
  // furnishing, possession) as the property's own description, where the same readers find it.
  function propertyFromBrief(text) {
    const P = M();
    const raw = String(text || '');
    const r = P.briefProfile(raw, {});
    const f = r.facets || {};
    const s = raw.toLowerCase();
    const typeWord = r.types && !r.types.residentialOnly && r.types.values.length === 1 ? r.types.values[0] : (r.bhk ? 'Apartment' : '');
    const sub = r.types && r.types.subs ? Object.values(r.types.subs)[0] : null;
    const b = r.budget;
    const fm = n => P.fmtMoney(n);
    // The figure said is the property's price (a range, for a project with several units).
    const ranged = b && !b.firm && !b.minOnly && b.max > b.min * 1.02;
    const priceText = !b ? '' : b.mode === 'psf' ? `₹${Math.round(b.max)} per sqft`
      : b.mode === 'lumpsum' ? `${fm(b.max)} lease amount`
        : b.mode === 'monthly' ? `Rent ${Math.round(b.max)} per month`
          : ranged ? `${fm(b.min)} - ${fm(b.max)}` : fm(b.minOnly ? b.min : b.max);
    const floor = (s.match(/\b(\d{1,2})\s*(?:st|nd|rd|th)?\s*floor\b/) || [])[1] || (/\bground\s*floor\b/.test(s) ? '0' : '');
    const parking = /\b(?:covered|stilt|basement|closed|reserved)\s*(?:car\s*)?park/.test(s) ? 'Covered' : /\bopen\s*(?:car\s*)?park/.test(s) ? 'Open' : '';
    const ready = r.possession && r.possession.want === 'ready';
    const prof = propertyFromDetails({
      type: typeWord, sub: sub ? P.SUB_LABEL[sub] : '', bhk: r.bhk ? r.bhk.values[0] : '',
      location: r.localities ? r.localities.keys.map(k => G().label(k)).join(', ') : '',
      area: r.size ? (r.size.unit === 'land' ? r.size.min / 2400 : r.size.min) : '', areaUnit: r.size && r.size.unit === 'land' ? 'grounds' : 'sqft',
      priceText,
      deal: r.deal ? (r.deal.values.includes('jv') ? 'jv' : r.deal.values[0] === 'rent' ? (b && b.mode === 'lumpsum' ? 'lease' : 'rent') : 'sale') : '',
      status: ready ? 'ready' : /\bunder\s*construction|new\s*launch|pre\s*launch\b/.test(s) ? 'under construction' : '',
      condition: f.saleType === 'Resale' ? 'resale' : f.saleType === 'New' ? 'new' : '',
      facing: (f.facing || []).join(' '), furnishing: f.furnishing || '',
      amenities: raw, notes: raw
    });
    // What the form has no field for, set on the profile directly — the scorer reads these.
    if (floor !== '') prof.floorNo = Number(floor);
    if (parking) prof.parkingKind = [parking];
    if (f.approvals && f.approvals.length) prof.approvals = Array.from(new Set((prof.approvals || []).concat(f.approvals)));
    if (r.possession && r.possession.want === 'by' && r.possession.at) prof.possessionAt = r.possession.at;
    if (/\bvastu\b/.test(s) && !/\bno(?:t)?\s*vastu\b/.test(s)) prof.vastu = true;
    if (/\bcorner\b/.test(s)) prof.corner = true;
    prof.typedText = raw;
    return prof;
  }

  // ── Filters and sorting (the Match page and Eåsy share them) ─────────────
  const SORTS = {
    // "Highest match" means the percentage, in order; between equal scores, the surer and keener first.
    score: (a, b) => (b.vetoed ? 0 : 1) - (a.vetoed ? 0 : 1) || b.pct - a.pct || b.rank - a.rank,
    location: (a, b) => locRank(b) - locRank(a) || b.pct - a.pct,
    budget: (a, b) => budgetRank(a) - budgetRank(b) || b.pct - a.pct,
    recent: (a, b) => (b.updatedAt || b.reqUpdated || b.lastTouch || 0) - (a.updatedAt || a.reqUpdated || a.lastTouch || 0),
    newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    confidence: (a, b) => (b.confidenceValue || 0) - (a.confidenceValue || 0) || b.pct - a.pct
  };
  const LOC_RANK = { exact: 4, nearby: 3, reachable: 2, unknown: 1, far: 0, excluded: -1 };
  const locRank = r => LOC_RANK[(r.location2 || {}).level] || 0;
  const budgetRank = r => { const b = r.budget || r.budgetDiff; return b ? Math.abs(Math.min(b.pct, 0) * 0.3 + Math.max(b.pct, 0)) : 999; };
  function sortRows(rows, key) { return rows.slice().sort(SORTS[key] || SORTS.score); }
  // f: { minPct, sources:[..], statuses:[..], types:[..], deals:[..], bhk:[..], location, budgetMax, budgetMin, areaMin, areaMax, stages:[..], showRuledOut }
  function filterRows(rows, f) {
    const x = f || {};
    return rows.filter(r => {
      if (!x.showRuledOut && r.vetoed) return false;
      if (x.minPct && r.pct < x.minPct && !r.vetoed) return false;
      if (x.sources && x.sources.length && r.source && !x.sources.includes(r.source)) return false;
      if (x.statuses && x.statuses.length && r.statusKey && !x.statuses.includes(r.statusKey)) return false;
      if (x.types && x.types.length && r.type && !x.types.includes(r.type)) return false;
      if (x.types && x.types.length && !r.type && r.leadId && r.types && r.types.length && !r.types.some(t => x.types.some(w => String(t).toLowerCase().startsWith(w.toLowerCase().slice(0, 4))))) return false;
      if (x.deals && x.deals.length) {
        // A sale property whose owner is open to a JV answers both "Sale" and "JV".
        const d = r.deal ? (Array.isArray(r.deal) ? r.deal : (r.jv ? ['jv', r.deal] : [r.deal])) : [];
        if (d.length && !d.some(v => x.deals.includes(v))) return false;
      }
      if (x.bhk && x.bhk.length && Array.isArray(r.bhk) && r.bhk.length && !r.bhk.some(n => x.bhk.includes(n))) return false;
      if (x.location && !lc((r.location || '') + ' ' + (r.locations || []).join(' ')).includes(lc(x.location))) return false;
      if (x.budgetMax && r.priceLo != null && r.priceLo > x.budgetMax) return false;
      if (x.budgetMin && r.priceLo != null && r.priceLo < x.budgetMin) return false;
      if (x.clientBudget && r.budgetMax == null && r.leadId) return false;
      if (x.clientBudget && r.budgetMax != null) {
        if (x.clientBudget.cmp === 'gte' && r.budgetMax < x.clientBudget.value) return false;
        if (x.clientBudget.cmp === 'lte' && r.budgetMax > x.clientBudget.value) return false;
      }
      if (x.areaMin && r.areaLo != null && r.areaLo < x.areaMin) return false;
      if (x.areaMax && r.areaLo != null && r.areaLo > x.areaMax) return false;
      if (x.stages && x.stages.length && r.stage && !x.stages.includes(r.stage)) return false;
      return true;
    });
  }

  // ── A requirement, said back for review ──────────────────────────────────
  //
  // What the engine understood, as chips a person can check before searching — every value says
  // where it came from, and a spelling it corrected says so ("anna nagr → Anna Nagar").
  function explainReq(r) {
    const P = M(), geo = G();
    const TL = root.PinSearch ? root.PinSearch.TYPE_LABEL : {};
    const out = [];
    const put = (field, label, value, note) => { if (value != null && value !== '') out.push({ field, label, value, note: note || '' }); };
    if (r.deal) put('deal', 'Deal', r.deal.values.map(v => ({ sale: 'Buy', rent: 'Rent / lease', jv: 'Joint venture' }[v] || v)).join(' or '), r.deal.why);
    if (r.types) {
      const subs = r.types.subs ? Object.values(r.types.subs).map(x => P.SUB_LABEL[x]) : [];
      put('type', 'Type', subs.length ? subs.join(', ') : r.types.residentialOnly ? 'Residential (any)' : r.types.values.map(t => TL[t] || t).join(' or '));
    }
    if (r.bhk) put('bhk', 'Bedrooms', r.bhk.values.join(' or ') + ' BHK');
    if (r.localities) {
      const L = r.localities;
      if (L.keys.length) put('locations', 'Locations', L.keys.map(k => geo.label(k)).join(', '), (L.fuzzy || []).map(f => `read “${f.said}” as ${geo.label(f.key)}`).join('; '));
      else if (L.zones && L.zones.length) put('locations', 'Part of the city', L.zones.map(z => z.replace(/^Chennai (\w+)$/, '$1 Chennai')).join(', '));
      else if (L.anywhere) put('locations', 'Locations', 'Anywhere in Chennai');
      if (L.corridors && L.corridors.length) put('corridor', 'Corridor', L.corridors.join(', '));
      if (L.radiusKm) put('radius', 'Within', L.radiusKm + ' km');
      if (L.exclude && L.exclude.length) put('exclude', 'Not in', L.exclude.map(k => geo.label(k)).join(', '), 'they ruled these out');
    }
    if (r.budget) {
      const b = r.budget;
      const per = b.mode === 'monthly' ? ' a month' : b.mode === 'lumpsum' ? ' lease amount' : b.mode === 'psf' ? ' per sq ft' : '';
      // Said back the way they said it: "around ₹3 Cr", "up to ₹3 Cr" (a ceiling), "₹3 Cr", a range, "above".
      const amt = b.mode === 'psf' ? '₹' + Math.round(b.max).toLocaleString('en-IN')
        : b.minOnly ? 'above ' + P.fmtMoney(b.min)
          : !b.firm ? P.fmtMoney(b.min) + ' – ' + P.fmtMoney(b.max)
            : (b.flexible ? 'around ' : b.ceiling ? 'up to ' : '') + P.fmtMoney(b.max);
      put('budget', 'Budget', amt + per, b.flexible ? 'flexible' : b.ceiling ? 'their ceiling' : '');
    }
    if (r.size) put('area', r.size.unit === 'land' ? 'Land' : 'Size', r.size.unit === 'land' ? `${Math.round(r.size.min / 2400 * 10) / 10} grounds (${P.fmtArea(r.size.min, r.size.min)})` : P.fmtArea(r.size.min, r.size.max));
    if (r.possession) put('possession', 'Possession', r.possession.want === 'ready' ? 'Ready to move' : r.possession.want === 'upcoming' ? 'Under construction is fine' : 'By ' + (r.possession.label || ''));
    if (r.facets && r.facets.saleType) put('condition', 'New / resale', r.facets.saleType);
    const asks = ((r.specs && r.specs.keys) || []).map(k => (P.SPECS.find(x => x.key === k) || {}).label).filter(Boolean).concat((r.specs && r.specs.other) || []);
    if (asks.length) put('mustHave', 'Must have', asks.join(', '));
    const missing = [];
    if (!r.deal) missing.push('buy or rent');
    if (!r.types) missing.push('property type');
    if (!r.localities || (!r.localities.keys.length && !r.localities.anywhere && !(r.localities.zones && r.localities.zones.length))) missing.push('location');
    if (!r.budget && !(r.deal && r.deal.values.length === 1 && r.deal.values[0] === 'jv')) missing.push('budget');
    if (!r.bhk && r.types && r.types.values.some(t => ['Apartment', 'Villa', 'House'].includes(t))) missing.push('bedrooms');
    return { chips: out, missing };
  }

  // The engine's reading of a requirement → an editable ITEM (the review form's starting point
  // when no AI read is available).
  const TYPE_KEY = { Apartment: 'apartment', Villa: 'villa', House: 'independent_house', Plot: 'plot', Commercial: 'commercial' };
  function itemFromProfile(r) {
    const geo = G();
    const it = { status: 'active' };
    if (r.deal) it.deal = r.deal.values.includes('jv') ? 'jv' : r.deal.values.length > 1 ? 'either' : r.deal.values[0] === 'rent' ? (r.budget && r.budget.mode === 'lumpsum' ? 'lease' : 'rent') : 'buy';
    if (r.types && !r.types.residentialOnly) it.types = r.types.values.map(t => TYPE_KEY[t]).filter(Boolean);
    if (r.types && r.types.subs) { const sb = Object.values(r.types.subs)[0]; if (sb) it.sub = sb; }
    if (r.bhk) it.bhk = r.bhk.values.slice();
    if (r.localities) {
      it.locations = r.localities.keys.map((k, i) => ({ name: geo.label(k), pref: i === 0 ? 'primary' : 'secondary' }));
      if (r.localities.anywhere) it.anywhere = true;
      if (r.localities.exclude && r.localities.exclude.length) it.exclude = r.localities.exclude.map(k => geo.label(k));
      if (r.localities.radiusKm) it.radiusKm = r.localities.radiusKm;
    }
    if (r.budget) {
      const b = r.budget;
      it.budget = { min: b.firm || b.minOnly ? (b.minOnly ? b.min : null) : b.min, max: b.minOnly ? null : b.max,
        unit: b.mode === 'monthly' ? 'per_month' : b.mode === 'lumpsum' ? 'lease_amount' : b.mode === 'psf' ? 'per_sqft' : 'total',
        flex: b.minOnly ? 'minimum' : b.flexible ? 'approximate' : b.firm ? 'maximum' : 'fixed' };
    }
    if (r.size) it.area = r.size.unit === 'land' ? { min: Math.round(r.size.min / 2400 * 100) / 100, max: null, unit: 'grounds', kind: 'land' } : { min: r.size.min, max: r.size.max > r.size.min * 1.3 ? null : r.size.max, unit: 'sqft', kind: 'built' };
    if (r.possession && r.possession.want === 'ready') it.possession = 'immediate';
    if (r.facets && r.facets.saleType) it.condition = [r.facets.saleType === 'Resale' ? 'resale' : 'new'];
    const P = M();
    const asks = ((r.specs && r.specs.keys) || []).map(k => (P.SPECS.find(x => x.key === k) || {}).label).filter(Boolean).concat((r.specs && r.specs.other) || []);
    if (asks.length) it.mustHave = asks;
    return it;
  }

  // An ITEM from anywhere (the AI, a form, Eåsy) checked before it is used or stored: known values
  // only, plausible numbers, short strings. Returns null when nothing usable is left.
  const ENUM = {
    status: ['active', 'previous', 'closed'], deal: ['buy', 'rent', 'lease', 'jv', 'either'],
    types: ['apartment', 'villa', 'independent_house', 'plot', 'commercial'],
    unit: ['total', 'per_month', 'per_sqft', 'lease_amount'], flex: ['fixed', 'approximate', 'negotiable', 'maximum', 'minimum'],
    areaUnit: ['sqft', 'sqm', 'grounds', 'cents', 'acres'], kind: ['built', 'carpet', 'land'],
    condition: ['new', 'resale', 'ready', 'under_construction'], pref: ['primary', 'secondary']
  };
  function cleanItem(x) {
    if (!x || typeof x !== 'object') return null;
    const str = (v, n) => (typeof v === 'string' ? v.replace(/[<>]/g, '').trim().slice(0, n || 80) : '');
    const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
    const one = (v, list) => (list.includes(v) ? v : null);
    const it = { status: one(x.status, ENUM.status) || 'active' };
    if (x.id) it.id = str(x.id, 40);
    const deal = one(x.deal, ENUM.deal); if (deal) it.deal = deal;
    const types = (Array.isArray(x.types) ? x.types : []).filter(t => ENUM.types.includes(t)).slice(0, 4); if (types.length) it.types = types;
    if (x.sub && M().SUB_LABEL[x.sub]) it.sub = x.sub;
    const bhk = (Array.isArray(x.bhk) ? x.bhk : []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 8).slice(0, 4); if (bhk.length) it.bhk = bhk;
    const locs = (Array.isArray(x.locations) ? x.locations : []).map(l => (typeof l === 'string' ? { name: str(l, 60), pref: 'primary' } : { name: str(l && l.name, 60), pref: one(l && l.pref, ENUM.pref) || 'primary' })).filter(l => l.name).slice(0, 8);
    if (locs.length) it.locations = locs;
    const ex = (Array.isArray(x.exclude) ? x.exclude : []).map(v => str(v, 60)).filter(Boolean).slice(0, 8); if (ex.length) it.exclude = ex;
    if (x.anywhere === true) it.anywhere = true;
    const rad = num(x.radiusKm, 0.5, 60); if (rad) it.radiusKm = rad;
    if (x.budget && typeof x.budget === 'object') {
      const unit = one(x.budget.unit, ENUM.unit) || 'total';
      const hiCap = unit === 'per_month' ? 5e7 : unit === 'per_sqft' ? 2e5 : 5e10;
      const b = { min: num(x.budget.min, 1000, hiCap), max: num(x.budget.max, 1000, hiCap), unit, flex: one(x.budget.flex, ENUM.flex) || 'fixed' };
      if (b.min && b.max && b.min > b.max) [b.min, b.max] = [b.max, b.min];
      if (b.min || b.max) it.budget = b;
    }
    if (x.area && typeof x.area === 'object') {
      const a = { min: num(x.area.min, 0.01, 5e6), max: num(x.area.max, 0.01, 5e6), unit: one(x.area.unit, ENUM.areaUnit) || 'sqft', kind: one(x.area.kind, ENUM.kind) || null, flex: one(x.area.flex, ENUM.flex) || null };
      if (a.min && a.max && a.min > a.max) [a.min, a.max] = [a.max, a.min];
      if (a.min || a.max) it.area = a;
    }
    const cond = (Array.isArray(x.condition) ? x.condition : []).filter(c => ENUM.condition.includes(c)); if (cond.length) it.condition = cond;
    if (x.possession === 'immediate' || /^20\d\d-(0[1-9]|1[0-2])$/.test(String(x.possession || ''))) it.possession = x.possession;
    const must = (Array.isArray(x.mustHave) ? x.mustHave : []).map(v => str(v, 60)).filter(Boolean).slice(0, 10); if (must.length) it.mustHave = must;
    ['facing', 'furnishing', 'floor'].forEach(k => { const v = str(x[k], 30); if (v) it[k] = v; });
    const notes = str(x.notes, 300); if (notes) it.notes = notes;
    ['uncertain', 'missing'].forEach(k => { const v = (Array.isArray(x[k]) ? x[k] : []).map(f => str(f, 30)).filter(Boolean).slice(0, 10); if (v.length) it[k] = v; });
    const said = str(x.label, 80); if (said) it.label = said;
    const usable = it.deal || it.types || it.bhk || it.locations || it.budget || it.area || it.anywhere;
    return usable ? it : null;
  }

  const api = {
    buildUnified, explainReq, itemFromProfile, cleanItem, areaFor, findProperties, findClients, propertyFromDetails, propertyFromBrief, demandFor,
    parseSmartQuery, sortRows, filterRows, stageKeyFor, stageOf, lastTouch, isSellerLead, trackStatus, propertyStatus,
    budgetDiff, locationCompat, nextAction, propertyRow, clientRow, phoneKey,
    SOURCE, TRUST_LABEL, TRACK_STATUS
  };
  root.PinSources = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
