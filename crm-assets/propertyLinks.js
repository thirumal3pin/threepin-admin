// ═══════════════════════════════════════════════════════════════════════
// LEAD ↔ PROPERTY LINKS — which inventory properties a lead is about.
//
// Pure, dependency-free ES module shared by the CRM page (bridged onto window.propertyLinks in
// crm.html), the server-side lead automation (api/_lead-automation.js) and
// scripts/backfill-property-links.mjs.
//
//   lead.propertyCodes        inventory document ids — a property code such as ANR003, or the
//                             numeric id of an older inventory row — in the order they were linked
//   lead.unlinkedPropertyIds  ids a person removed; automation never links them again
//
// A person links and unlinks from the lead page. Automation only ever ADDS a link, and only for
// a code that exists in the inventory and appears in what the lead is about: the AI's visit
// property, TailorTalk's "properties discussed", or the lead's property / locality field.
// ═══════════════════════════════════════════════════════════════════════

export const PROPERTY_CODE = /\b[A-Z]{2,5}\d{3,4}\b/g;

// Every distinct code-shaped token in the given texts, upper-cased, in order of appearance.
export function codesIn(...texts) {
  const out = [];
  for (const t of texts) {
    for (const m of String(t == null ? '' : t).toUpperCase().match(PROPERTY_CODE) || []) {
      if (!out.includes(m)) out.push(m);
    }
  }
  return out;
}

// The ids to add to a lead: known to the inventory, not linked yet, not removed by a person.
export function linksToAdd(lead, candidates, knownIds) {
  const linked = new Set((lead && lead.propertyCodes) || []);
  const unlinked = new Set((lead && lead.unlinkedPropertyIds) || []);
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  return (candidates || []).filter((id, i, all) => known.has(id) && !linked.has(id) && !unlinked.has(id) && all.indexOf(id) === i);
}
