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
export const FIELD_MAP = {
  'Property_ID': 'propertyCode',
  'Property_Name_Project': 'name',
  'Zone': 'zone',
  'Location_Area': 'location',
  'Configuration_(BHK)': 'config',
  'Availability_Status': 'availability',
  'Price': 'startingPrice',
  'Rate_per_Sqft_(INR)': 'pricePerSqft',
  'Total_Land_Area_(sq_ft)': 'totalLandArea',
  'Built-up_Area_(sq_ft)': 'sqftRange',
  'Super_Built-up_Area_(sq_ft)': 'superBuiltupArea',
  'Carpet_Area_(sq_ft)': 'carpetArea',
  'UDS_(sq_ft)': 'uds',
  'Total_Units': 'totalUnits',
  'Total_Towers': 'totalTowers',
  'Total_Floors': 'totalFloors',
  'Floor_No': 'floorNo',
  'Facing': 'facing',
  'Bathrooms': 'bathrooms',
  'Car_Parking_(No)': 'parking',
  'Car_Parking_Type': 'parkingType',
  'Furnishing': 'furnishing',
  'Corner_Unit': 'cornerUnit',
  'Vastu_Compliant': 'vastu',
  'Power_Backup_(EB_Generator)': 'powerBackup',
  'Nearby_Landmarks': 'nearbyLandmark',
  'Connectivity_Metro': 'connectivity',
  'Location_Pin_(Maps_URL)': 'mapLink',
  'Approval_(CMDA_DTCP)': 'approval',
  'Highlights': 'highlights',
  'Amenities': 'amenities',
  'Images_URL': 'photosLink',
  'Brochure_Link': 'brochureLink',
  'Owner_Builder_Contact': 'ownerContact',
  'Notes': 'sheetNotes'
};

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

// Works out what a sync would do, without writing anything. Both callers use
// this so the dry run and the real run can never disagree.
export function planSync(rows, existing, onlyId){
  const headers = rows[0] || [];
  const plan = { headers, creates: [], updates: [], unchanged: 0, writes: [], matchedIds: new Set() };

  for(let i = 1; i < rows.length; i++){
    let prop = rowToProperty(headers, rows[i] || []);
    if(!prop) continue;
    if(onlyId && prop.id !== onlyId) continue;
    plan.matchedIds.add(prop.id);

    const before = existing.get(prop.id);
    if(!before) prop = withCreateDefaults(prop);
    const changes = diffProperty(before, prop);

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
export async function commitWrites(db, writes){
  for(let i = 0; i < writes.length; i += 400){
    const batch = db.batch();
    writes.slice(i, i + 400).forEach(p => batch.set(db.collection('properties').doc(p.id), p, { merge: true }));
    await batch.commit();
  }
}

export async function loadExistingProperties(db){
  const snap = await db.collection('properties').where('tenantId','==',TENANT_ID).get();
  const map = new Map();
  snap.forEach(d => map.set(d.id, d.data()));
  return map;
}
