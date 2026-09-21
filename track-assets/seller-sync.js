// ═══════════════════════════════════════════════════════════════════════
// SELLER LEAD  ⇄  PROPERTY LISTING — the one definition of how they stay
// in step.
//
// Pure, dependency-free ESM, imported by BOTH writers:
//   • track-assets/app.js       reconciles live, while the board is open
//   • scripts/sync-seller-listings.mjs   backfills and re-reconciles server-side
//
// It lives in one file for the reason _pipeline-shared.js does: two copies of
// a mapping drift, and two writers disagreeing about which side owns a field
// is how a pipeline quietly corrupts itself. Everything below is a pure
// function of (lead, listing) → the patch to write, so both callers produce
// byte-identical results and tests can run it with no Firestore at all.
//
// ── WHO OWNS WHAT ──────────────────────────────────────────────────────
// "Two-way sync" without ownership is just two writers fighting, and the
// loser is whoever saved first. So each field has exactly one owner:
//
//   The CRM lead owns the PERSON.
//     name, phone → sellerName, sellerPhone. Correct a number in the CRM and
//     the listing follows, because the CRM is where contact details are kept
//     current (TailorTalk writes them, the team edits them there).
//
//   The listing owns the PROPERTY and the WORK.
//     stage, shoot date, assignee, media checklist, owner approval,
//     deliverables, remarks. The CRM never writes any of it — a lead's sales
//     stage ("Negotiating") and a listing's production stage ("Shot") are
//     orthogonal, and collapsing them would make both meaningless.
//
//   Seeded once, then the listing owns it.
//     title, location, askingPrice start from the lead's propertyInterest and
//     budget because that is all anyone knows on day one — but they get
//     corrected on the board ("Adambakkam 2BHK" → "2BHK Flat, Adambakkam
//     Main Road"), and a later CRM edit must not undo that.
//
//   propertyCode — filled from the lead's linked property if the listing has
//     none, never overwritten. Mapping on the board is the deliberate act.
//
// ── OVERRIDES ──────────────────────────────────────────────────────────
// Editing an owner's name or phone ON THE BOARD sets own.<field> = true, and
// this stops pushing the CRM's value into it from then on. Same idea as
// ttHold in the TailorTalk sync: a person's deliberate edit outranks an
// automatic one, permanently, and silently reverting it would be the worst
// possible behaviour.
//
// ── WHICH SELLERS GET A CARD ───────────────────────────────────────────
// Every lead isSellerLead() recognises — the same two-signal rule the CRM
// uses, so an owner the keyword classifier missed is still caught. Two
// deliberate exceptions, both reversible by a person:
//   • lead.listingSkipped === true — someone dismissed them on the board, or
//     deleted their card. Without this a deleted card reappears on the next
//     reconcile, which is the single most infuriating bug this design could
//     have.
//   • a listing already exists for that leadId.
// A lead being Lost in the CRM is NOT an exception: a seller who went cold on
// a purchase may still be listing their property, and the owner's instruction
// was to miss none of them.
// ═══════════════════════════════════════════════════════════════════════

// Both signals, either is enough. Mirrors isSellerLead() in crm-assets/app.js
// and the re-tag rule in api/_lead-policy.js.
export function isSellerLead(lead) {
  if (!lead) return false;
  const t = String(lead.enquiryType || '').trim().toLowerCase();
  if (t === 'seller listing') return true;
  return !!(lead.ai && (lead.ai.intent === 'sell' || lead.ai.intent === 'rent_out'));
}

// Vendors and collaborations are not sales leads at all — same exclusion the
// CRM and the lead automation apply before anything else.
export function isBusinessLead(lead) {
  return !!(lead && lead.tt && lead.tt.id && lead.tt.category && String(lead.tt.category).toLowerCase() !== 'sales')
    || !!(lead && lead.enquiryType === 'Vendor / Collaboration');
}

export function wantsListing(lead) {
  return isSellerLead(lead) && !isBusinessLead(lead) && lead.listingSkipped !== true;
}

const clean = v => (v === undefined || v === null) ? '' : String(v).trim();

// The fields the CRM keeps current, and which listing field each lands in.
const PERSON_FIELDS = [['name', 'sellerName'], ['phone', 'sellerPhone']];

/**
 * The listing document to CREATE for a seller lead that has none.
 * @param {object} lead
 * @param {object} firstStage  the board's first column
 * @param {number} now
 * @param {string} by          who is doing this ('sync', an email, …)
 */
export function newListingFor(lead, firstStage, now, by) {
  const stageKey = firstStage.key || 'new_listing';
  return {
    id: 'lst_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    leadId: lead.id,
    stageId: firstStage.id,
    // Person — the CRM's, and kept in step from here on.
    sellerName: clean(lead.name),
    sellerPhone: clean(lead.phone),
    // Seeded from what the lead knows, then the board's to correct.
    title: clean(lead.propertyInterest) || clean(lead.name) || 'New listing',
    location: clean(lead.propertyInterest),
    askingPrice: clean(lead.budget),
    propertyCode: (lead.propertyCodes && lead.propertyCodes[0]) || '',
    // The board's own, untouched by anything here.
    media: {}, own: {}, ownerInformed: false, ownerApproved: false,
    stageChangedAt: now, stageChangedBy: by,
    reached: { [stageKey]: now },
    createdAt: now, createdBy: by, updatedAt: now, updatedBy: by,
    source: 'seller-sync'
  };
}

/**
 * The patch to apply to an EXISTING listing so it agrees with its lead, or
 * null when it already does. Only ever touches fields the CRM owns.
 * @returns {?object} a sparse patch, never a whole document
 */
export function listingPatchFor(lead, listing) {
  if (!lead || !listing) return null;
  const own = listing.own || {};
  const patch = {};
  for (const [leadField, listField] of PERSON_FIELDS) {
    if (own[listField]) continue;                 // edited on the board — leave it alone
    const want = clean(lead[leadField]);
    if (!want) continue;                          // the CRM knows nothing; keep what we have
    if (clean(listing[listField]) === want) continue;
    patch[listField] = want;
  }
  // Fill a blank property mapping from the lead's own link; never overwrite.
  const code = (lead.propertyCodes && lead.propertyCodes[0]) || '';
  if (code && !clean(listing.propertyCode)) patch.propertyCode = code;
  return Object.keys(patch).length ? patch : null;
}

/**
 * The patch to apply to the LEAD so the CRM can point at its listing, or null.
 * Deliberately tiny: the listing's own state never flows back into the lead —
 * only the link itself, plus the property code once the board has mapped one,
 * since that is genuinely the same fact in both places.
 */
export function leadPatchFor(lead, listing) {
  if (!lead || !listing) return null;
  const patch = {};
  if (lead.listingId !== listing.id) patch.listingId = listing.id;
  const code = clean(listing.propertyCode);
  if (code) {
    const have = lead.propertyCodes || [];
    const unlinked = lead.unlinkedPropertyIds || [];
    // Never re-add a property a person deliberately unlinked in the CRM —
    // same rule propertyLinks.js follows for the automation.
    if (!have.includes(code) && !unlinked.includes(code)) patch.propertyCodes = [...have, code];
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * The whole reconcile, as data. Give it every lead and every listing; it says
 * what to create, what to patch, and why — without touching anything.
 *
 * @param {Array}  leads
 * @param {Array}  listings
 * @param {object} firstStage  the board's first column (for new cards)
 * @param {number} now
 * @param {string} by
 * @returns {{create: Array, updateListings: Array, updateLeads: Array}}
 */
export function planSync(leads, listings, firstStage, now, by) {
  const byLead = new Map();
  for (const l of listings || []) if (l.leadId) byLead.set(l.leadId, l);

  const create = [], updateListings = [], updateLeads = [];
  for (const lead of leads || []) {
    const existing = byLead.get(lead.id) || null;
    if (!existing) {
      if (!wantsListing(lead) || !firstStage) continue;
      const doc = newListingFor(lead, firstStage, now, by);
      create.push({ lead, listing: doc });
      updateLeads.push({ id: lead.id, patch: { listingId: doc.id } });
      continue;
    }
    const lp = listingPatchFor(lead, existing);
    if (lp) updateListings.push({ id: existing.id, patch: lp, lead });
    const dp = leadPatchFor(lead, existing);
    if (dp) updateLeads.push({ id: lead.id, patch: dp });
  }
  return { create, updateListings, updateLeads };
}
