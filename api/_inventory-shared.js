// Inventory-sheet → `properties` mapping, shared by BOTH callers:
//   - scripts/sync-inventory.js  (CLI, run on the Mac / by hand)
//   - api/sync-inventory.js      (the dashboard's "Sync from Sheet" button)
//
// It lives in one place deliberately. Two copies of this mapping would drift,
// and two writers disagreeing about which field means what is the exact bug
// this whole change set exists to eliminate.
//
// Nothing here reads credentials or touches the filesystem — the caller
// passes in an already-parsed service account object, because the CLI reads
// it from a file and the serverless function reads it from an env var.

import crypto from 'node:crypto';

export const INVENTORY_SHEET_ID = '1X53_F-S9ezL70Dy2c7a6DG06ljD7bGCb3HauysPMZ8I';
export const INVENTORY_RANGE = 'Inventory!A1:AZ1000';
export const TENANT_ID = 't_3pinrealty';

// Header text → canonical field. Keyed on the sheet's exact header, so
// inserting or reordering a column cannot silently start writing values into
// the wrong field. Anything absent from this map still reaches the dashboard
// through sheetExtras.
//
// Several columns are listed under TWO spellings. The sheet was re-headed at
// some point — parentheses became plain words ('Configuration_(BHK)' →
// 'Configuration_BHK', 'Car_Parking_(No)' → 'Car_Parking_as_No',
// 'UDS_(sq_ft)' → 'UDS_in_sq_ft') — and because an unmapped header silently
// falls through to sheetExtras rather than erroring, eleven fields quietly
// stopped populating: config, pricePerSqft, sqftRange, superBuiltupArea,
// carpetArea, uds, totalLandArea, parking, powerBackup, mapLink, approval.
// Nothing looked broken because rowToProperty drops empty values, so every
// property already carrying those fields simply kept its old ones — only
// newly-synced properties came out blank (a BHK config that never reaches
// `config` is also invisible to the dashboard search bar, which does not
// look inside sheetExtras).
//
// Both spellings are kept so the map works whichever way the sheet is
// headed. assertHeadersMapped() below turns any FUTURE rename into a loud
// failure instead of another silent one.
export const FIELD_MAP = {
  'Property_ID': 'propertyCode',
  'Property_Name_Project': 'name',
  'Zone': 'zone',
  'Location_Area': 'location',
  'Configuration_(BHK)': 'config',
  'Configuration_BHK': 'config',
  'Availability_Status': 'availability',
  'Price': 'startingPrice',
  'Rate_per_Sqft_(INR)': 'pricePerSqft',
  'Rate_per_Sqft_INR': 'pricePerSqft',
  'Total_Land_Area_(sq_ft)': 'totalLandArea',
  'Total_Land_Area_in_sq_ft': 'totalLandArea',
  'Built-up_Area_(sq_ft)': 'sqftRange',
  'Built-up_Area_in_sq_ft': 'sqftRange',
  'Super_Built-up_Area_(sq_ft)': 'superBuiltupArea',
  'Super_Built-up_Area_in_sq_ft': 'superBuiltupArea',
  'Carpet_Area_(sq_ft)': 'carpetArea',
  'Carpet_Area_in_sq_ft': 'carpetArea',
  'UDS_(sq_ft)': 'uds',
  'UDS_in_sq_ft': 'uds',
  'Total_Units': 'totalUnits',
  'Total_Towers': 'totalTowers',
  'Total_Floors': 'totalFloors',
  'Floor_No': 'floorNo',
  'Facing': 'facing',
  'Bathrooms': 'bathrooms',
  'Car_Parking_(No)': 'parking',
  'Car_Parking_as_No': 'parking',
  'Car_Parking_Type': 'parkingType',
  'Furnishing': 'furnishing',
  'Corner_Unit': 'cornerUnit',
  'Vastu_Compliant': 'vastu',
  'Power_Backup_(EB_Generator)': 'powerBackup',
  'Power_Backup_as_EB_Generator': 'powerBackup',
  'Nearby_Landmarks': 'nearbyLandmark',
  'Connectivity_Metro': 'connectivity',
  'Location_Pin_(Maps_URL)': 'mapLink',
  'Location_Pin_as_Maps_URL': 'mapLink',
  'Approval_(CMDA_DTCP)': 'approval',
  'Approval_as_CMDA_DTCP': 'approval',
  'Highlights': 'highlights',
  'Amenities': 'amenities',
  'Images_URL': 'photosLink',
  'Brochure_Link': 'brochureLink',
  'Owner_Builder_Contact': 'ownerContact',
  'Notes': 'sheetNotes'
};

// The canonical fields that must be reachable from SOME header in the live
// sheet. If a rename ever orphans one again, callers surface it instead of
// syncing a quietly hollowed-out property.
const REQUIRED_FIELDS = [
  'propertyCode', 'name', 'location', 'config', 'startingPrice',
  'highlights', 'amenities', 'brochureLink'
];

// Returns a list of human-readable problems (empty when the sheet is sane).
export function assertHeadersMapped(headers){
  const reachable = new Set();
  for(const h of headers){
    const f = FIELD_MAP[String(h || '').trim()];
    if(f) reachable.add(f);
  }
  return REQUIRED_FIELDS
    .filter(f => !reachable.has(f))
    .map(f => `no Inventory column maps to "${f}" — a header was probably renamed`);
}

// Column F packs five facts into one pipe-separated cell:
//   "Apartment | Resale | Ready to Move | - | 5 Years"
//   "Apartment | New | Under Construction | Dec 2031 | New"
// Split here so the dashboard's status filter gets a clean enum while every
// original part stays individually searchable.
export function parseCompound(raw){
  const parts = String(raw || '').split('|').map(s => s.trim());
  const blank = v => !v || v === '-' || v === '—';
  const stage = blank(parts[2]) ? '' : parts[2];
  return {
    type: parts[0] || '',
    saleType: blank(parts[1]) ? '' : parts[1],
    // Only two values pass the dashboard's status filters, so anything not
    // explicitly ready (including "Demolition stage" and "Pre-Launch") counts
    // as not ready — with the original wording kept in constructionStage so
    // nothing about it is lost.
    status: /ready\s*to\s*move/i.test(stage) ? 'Ready to Move' : 'Under Construction',
    constructionStage: stage,
    possession: blank(parts[3]) ? '' : parts[3],
    propertyAge: blank(parts[4]) ? '' : parts[4]
  };
}

// "Swaminathan 98848 83370" → name + number, keeping the original intact.
export function splitContact(raw){
  const s = String(raw || '').trim();
  if(!s) return { contactName:'', contactNumber:'' };
  const m = s.match(/(\+?\d[\d\s\-]{7,}\d)/);
  if(!m) return { contactName:s, contactNumber:'' };
  return { contactName: s.replace(m[1], '').replace(/[-,|]\s*$/,'').trim(), contactNumber: m[1].trim() };
}

function b64url(input){
  return Buffer.from(input).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

// Read-only Sheets token for the service account. Domain-wide delegation is
// NOT authorised on this project, so no `sub` / impersonation — the sheets are
// shared directly with the service account address instead.
export async function getSheetsToken(serviceAccount){
  const now = Math.floor(Date.now() / 1000);
  const signInput = `${b64url(JSON.stringify({ alg:'RS256', typ:'JWT' }))}.${b64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signInput); signer.end();
  const sig = signer.sign(serviceAccount.private_key).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion:`${signInput}.${sig}` })
  });
  const data = await res.json();
  if(!res.ok || !data.access_token) throw new Error(`Sheets token exchange failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

export async function readInventoryRows(token){
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${INVENTORY_SHEET_ID}/values/${encodeURIComponent(INVENTORY_RANGE)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if(!res.ok) throw new Error(`Inventory sheet read failed: ${JSON.stringify(data).slice(0,300)}`);
  return data.values || [];
}

// ── Queue sheet (brochure intake form responses) ──
// Column C holds the photo-folder link and column D the full WhatsApp-ready
// property description — data the Inventory sheet doesn't carry. Read-only,
// keyed by the Property ID parsed from column B ("MYLA002 - 6BHK Maha
// Palace" → MYLA002). Used to FILL BLANKS only: the pipeline owns
// photosLink/detailsText on delivered properties, so a value already present
// in Firestore is never overwritten from here.
export const QUEUE_SHEET_ID = '1MlepLxnA1-OzHHYd-8S1YKRPCk3Cvz8g1md3eWthsY4';
const QUEUE_RANGE = "'Form Responses 1'!A1:Z1000";

// Columns C and D were read by hardcoded index here. They happen to still be
// right, but an "Internal TEAM Instructions and Notes" column was inserted at
// E and shifted everything after it — so the same assumption was already
// wrong two columns to the right (see scripts/deliver-brochures.js). Resolve
// by header prefix instead, normalized for the stray double/trailing spaces
// Google Forms leaves in its question text.
//
// The internal-notes column is deliberately NOT listed. It must never be read
// here: this function feeds the property DOCUMENT, which the dashboard's
// "Sync from Sheet" button writes, and internal notes are required to stay out
// of that path. They live in a properties/{id}/internalNotes subcollection and
// are imported only by the brochure scheduler.
const QUEUE_FILL_COLUMNS = {
  idTitle:     'property id',
  photosLink:  'google drive photo folder',
  detailsText: 'property details'
};

export async function readQueueFill(token){
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${QUEUE_SHEET_ID}/values/${encodeURIComponent(QUEUE_RANGE)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  // The Queue sheet being unreadable must never block an Inventory sync —
  // it only enriches. Missing permission degrades to "no fill data".
  if(!res.ok) return new Map();
  const rows = data.values || [];
  const fill = new Map();
  const norm = (rows[0] || []).map(h => String(h || '').trim().toLowerCase().replace(/\s+/g, ' '));
  const col = prefix => norm.findIndex(h => h.startsWith(prefix));
  const cols = Object.fromEntries(Object.entries(QUEUE_FILL_COLUMNS).map(([k, pfx]) => [k, col(pfx)]));
  // Enriching is optional by design (see the !res.ok path above), so a header
  // we can't find degrades to "no fill data" rather than reading the wrong
  // column — which is the failure that started all of this.
  if(cols.idTitle === -1) return fill;

  for(let i = 1; i < rows.length; i++){
    const r = rows[i] || [];
    const id = String(r[cols.idTitle] || '').split(' - ')[0].trim();
    if(!id) continue;
    // Later rows win — the sheet is append-ordered by submission time, so a
    // re-submitted property's newer photos/details replace the older entry.
    fill.set(id, {
      photosLink: cols.photosLink === -1 ? '' : String(r[cols.photosLink] || '').trim(),
      detailsText: cols.detailsText === -1 ? '' : String(r[cols.detailsText] || '').trim()
    });
  }
  return fill;
}

// Builds the canonical property document from one sheet row.
export function rowToProperty(headers, row){
  const cell = i => { const v = row[i]; return v == null ? '' : String(v).trim(); };
  const propertyCode = cell(0);
  if(!propertyCode) return null;

  const out = { id: propertyCode, propertyCode, tenantId: TENANT_ID };
  const sheetExtras = {};

  headers.forEach((h, i) => {
    const header = String(h || '').trim();
    if(!header) return;
    const value = cell(i);

    if(header.startsWith('Property_Type_New_Resale')){
      Object.assign(out, parseCompound(value));
      return;
    }
    const field = FIELD_MAP[header];
    if(field){
      if(field === 'ownerContact'){
        Object.assign(out, splitContact(value));
        if(value) sheetExtras['Owner_Builder_Contact'] = value;
      } else {
        out[field] = value;
      }
      return;
    }
    // Unmapped column — kept verbatim and rendered in the dashboard's
    // "From the Inventory Sheet" block, so a new sheet column shows up with
    // no code change.
    if(value) sheetExtras[header] = value;
  });

  if(!out.sqftRange) out.sqftRange = out.superBuiltupArea || out.carpetArea || '';
  if(Object.keys(sheetExtras).length) out.sheetExtras = sheetExtras;

  // An empty sheet cell means "the sheet has nothing to say about this
  // field", NOT "clear it". Dropping empties stops a blank cell overwriting
  // richer data already in Firestore — without this, real possession dates
  // were being replaced by the placeholder "Contact for details".
  //
  // Consequence: blanking a sheet cell does not clear the dashboard. Clear
  // the value in the dashboard itself, which records it in the change log.
  for(const k of Object.keys(out)){
    if(out[k] === '' || out[k] == null) delete out[k];
  }

  out.source = 'inventory-sync';
  out.updatedAt = Date.now();
  return out;
}

// Applied ONLY when creating a property that does not exist yet — never on
// update, where they would clobber an existing value.
export function withCreateDefaults(prop){
  return {
    builder: 'Individual Owner',
    type: 'Property',
    startingPrice: 'Price on Request',
    possession: 'Contact for details',
    createdAt: Date.now(),
    ...prop
  };
}

// Compares only fields this sync owns, so dashboard-owned and pipeline-owned
// fields never show up as spurious differences.
export function diffProperty(before, after){
  const changes = [];
  for(const [k, v] of Object.entries(after)){
    if(k === 'updatedAt' || k === 'source') continue;
    const prev = before ? before[k] : undefined;
    if(k === 'sheetExtras'){
      if(JSON.stringify(prev || {}) !== JSON.stringify(v)){
        changes.push({ field:k, from:'(map)', to:`${Object.keys(v).length} keys` });
      }
      continue;
    }
    if(String(prev == null ? '' : prev) !== String(v == null ? '' : v)){
      changes.push({ field:k, from: prev == null ? '' : String(prev), to: String(v) });
    }
  }
  return changes;
}

// ── Pending-edit protection ──
// A dashboard edit that hasn't been carried into the Inventory sheet yet must
// NOT be overwritten by a sync — otherwise "edit in dashboard, forget to
// update the sheet, sync runs" silently reverts the agent's change (the exact
// class of bug this whole system exists to prevent). The un-applied entries
// in the propertyChanges worklist ARE the protection list: while an edit is
// pending there, its field belongs to the dashboard; ticking it "applied to
// sheet" is the explicit handover that lets the sheet govern the field again.
// A pending DELETE protects the whole property from being recreated.
export async function loadPendingProtections(db){
  const snap = await db.collection('propertyChanges')
    .where('tenantId', '==', TENANT_ID)
    .where('appliedToSheet', '==', false)
    .get();
  const fieldsByProp = new Map(); // propId -> Set(fieldKey)
  const deletedProps = new Set();
  snap.forEach(d => {
    const c = d.data();
    const id = c.propertyId;
    if(!id) return;
    if(c.kind === 'delete'){ deletedProps.add(id); return; }
    if(!c.field || c.field.startsWith('(')) return; // '(property)' create markers
    if(!fieldsByProp.has(id)) fieldsByProp.set(id, new Set());
    fieldsByProp.get(id).add(c.field);
  });
  return { fieldsByProp, deletedProps };
}

// Works out what a sync would do, without writing anything. Both callers use
// this so the dry run and the real run can never disagree. `queueFill` (from
// readQueueFill) supplies photosLink/detailsText for properties whose sheet
// row and Firestore doc both lack them — fill blanks, never overwrite.
// `protections` (from loadPendingProtections) keeps un-reconciled dashboard
// edits from being overwritten.
export function planSync(rows, existing, onlyId, queueFill, protections){
  const headers = rows[0] || [];
  const plan = { headers, creates: [], updates: [], unchanged: 0, writes: [], matchedIds: new Set(),
                 protectedFields: [], skippedDeleted: [], staleExtras: [] };

  for(let i = 1; i < rows.length; i++){
    let prop = rowToProperty(headers, rows[i] || []);
    if(!prop) continue;
    if(onlyId && prop.id !== onlyId) continue;
    plan.matchedIds.add(prop.id);

    // Deleted in the dashboard, delete not yet reflected in the sheet: do not
    // resurrect it. Removing the sheet row (or ticking the delete as applied)
    // hands control back.
    if(protections && protections.deletedProps.has(prop.id)){
      plan.skippedDeleted.push(prop.id);
      continue;
    }

    const before = existing.get(prop.id);
    if(queueFill && queueFill.has(prop.id)){
      const q = queueFill.get(prop.id);
      for(const k of ['photosLink','detailsText']){
        // Three-way blank check: the queue value only lands when the
        // inventory row didn't supply one AND the live document doesn't
        // already have one — so it can never displace pipeline-written data.
        const inSheet = prop[k] && String(prop[k]).trim();
        const inDb = before && before[k] && String(before[k]).trim();
        if(q[k] && !inSheet && !inDb) prop[k] = q[k];
      }
    }

    // Strip protected fields from the incoming row BEFORE diffing, so the
    // dashboard's value stays (merge write never touches an absent key) and
    // the field doesn't show up as a spurious sheet-vs-db difference.
    if(before && protections){
      const prot = protections.fieldsByProp.get(prop.id);
      if(prot && prot.size){
        const kept = [];
        for(const k of prot){
          if(k in prop && String(prop[k]) !== String(before[k] == null ? '' : before[k])){
            kept.push(k);
          }
          delete prop[k];
        }
        if(kept.length) plan.protectedFields.push({ id: prop.id, fields: kept });
      }
    }

    if(!before) prop = withCreateDefaults(prop);
    const changes = diffProperty(before, prop);

    // sheetExtras keys the sheet no longer produces. They matter because a
    // { merge: true } write deep-merges maps: it can add and overwrite keys
    // but never remove one, so a header that gets renamed (or newly mapped to
    // a real field, as eleven of them just were) leaves its old key behind
    // forever. The diff then sees 12 stored keys against 1 incoming key on
    // every single run and reports the property as changed in perpetuity.
    // Collected here and cleared explicitly in commitWrites.
    if(before && before.sheetExtras){
      const incoming = prop.sheetExtras || {};
      const stale = Object.keys(before.sheetExtras).filter(k => !(k in incoming));
      if(stale.length) plan.staleExtras.push({ id: prop.id, keys: stale });
    }

    if(!before){
      plan.creates.push({ id: prop.id, name: prop.name || '', changes });
    } else if(changes.length){
      plan.updates.push({ id: prop.id, name: prop.name || before.name || '', changes });
    } else {
      plan.unchanged++;
      continue;
    }
    plan.writes.push(prop);
  }

  // Reported for visibility only — these are never modified in any way. This
  // protects the older listings that carry random codes and were never
  // entered into the inventory sheet.
  plan.orphans = [...existing.keys()].filter(id => !plan.matchedIds.has(id));
  return plan;
}

export function unmappedHeaders(headers){
  return headers.filter(h => {
    const t = String(h || '').trim();
    return t && !FIELD_MAP[t] && !t.startsWith('Property_Type_New_Resale');
  });
}

// Chunked well under Firestore's 500-operation batch limit.
//
// `staleExtras` (from planSync) names sheetExtras keys that must be removed.
// They need a second pass because the set() above merges — the only way to
// drop a key from a map is to replace the whole field, and update() does
// exactly that for a top-level field, unlike set({merge:true}). It runs after
// its own set() so the document is guaranteed to exist by then.
export async function commitWrites(db, writes, staleExtras = []){
  for(let i = 0; i < writes.length; i += 400){
    const batch = db.batch();
    writes.slice(i, i + 400).forEach(p => batch.set(db.collection('properties').doc(p.id), p, { merge: true }));
    await batch.commit();
  }
  if(!staleExtras.length) return;
  const byId = new Map(writes.map(p => [p.id, p]));
  const pending = staleExtras.filter(st => byId.has(st.id));
  for(let i = 0; i < pending.length; i += 400){
    const batch = db.batch();
    pending.slice(i, i + 400).forEach(st =>
      batch.update(db.collection('properties').doc(st.id), { sheetExtras: byId.get(st.id).sheetExtras || {} }));
    await batch.commit();
  }
}

export async function loadExistingProperties(db){
  const snap = await db.collection('properties').where('tenantId','==',TENANT_ID).get();
  const map = new Map();
  snap.forEach(d => map.set(d.id, d.data()));
  return map;
}
