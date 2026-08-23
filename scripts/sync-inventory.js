// Syncs the Inventory master sheet into the dashboard's `properties`
// collection. This is the read path that makes the sheet the single source of
// truth — it does NOT depend on the Mac's 30-minute brochure scheduler, and
// can run from anywhere the service account key is available.
//
// Usage:
//   node scripts/sync-inventory.js              # dry run — prints the diff, writes nothing
//   node scripts/sync-inventory.js --apply      # actually writes to Firestore
//   node scripts/sync-inventory.js --apply --id NGMA001   # single property
//
// SAFETY RULES, all deliberate:
//   1. The sheet is never written to. Read-only scope, no exceptions.
//   2. A property with no matching sheet row is NEVER touched — not updated,
//      not flagged, not deleted. That protects the older listings that carry
//      random codes and were never entered into the sheet.
//   3. Dashboard-owned fields (soldOut, interestLevel) are never written, so a
//      re-run cannot un-sell a property or wipe a lead rating.
//   4. Writes use { merge: true }, so pipeline-written fields (brochureLink,
//      photosLink, detailsText) survive untouched.
//   5. Nothing is ever deleted.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const INVENTORY_SHEET_ID = '1X53_F-S9ezL70Dy2c7a6DG06ljD7bGCb3HauysPMZ8I';
const INVENTORY_RANGE = 'Inventory!A1:AZ1000';
const TENANT_ID = 't_3pinrealty';
const SA_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  || path.join(import.meta.dirname, '..', 'api', 'pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json');

const APPLY = process.argv.includes('--apply');
const ONLY_ID = (() => { const i = process.argv.indexOf('--id'); return i > -1 ? process.argv[i + 1] : null; })();

// ── Header → canonical field. Keyed on the sheet's exact header text.
// Matching by header rather than column position means inserting or
// reordering a column in the sheet cannot silently start writing values into
// the wrong field — the usual way a sheet integration corrupts data quietly.
// Anything not listed here still reaches the dashboard via sheetExtras.
const FIELD_MAP = {
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

// Column F packs five facts into one pipe-separated cell, e.g.
//   "Apartment | Resale | Ready to Move | - | 5 Years"
//   "Apartment | New | Under Construction | Dec 2031 | New"
// Split here rather than in the dashboard so the grid's status filter gets a
// clean enum value and every part stays individually searchable.
const COMPOUND_HEADER = 'Property_Type_New_Resale_Construction_Status';
function parseCompound(raw){
  const parts = String(raw || '').split('|').map(s => s.trim());
  const blank = v => !v || v === '-' || v === '—';
  const stage = blank(parts[2]) ? '' : parts[2];
  return {
    type: parts[0] || '',
    saleType: blank(parts[1]) ? '' : parts[1],
    // Only two values pass the dashboard's status filters, so anything that
    // isn't explicitly ready (including "Demolition stage") counts as not
    // ready — with the original wording preserved in constructionStage so
    // nothing about it is lost.
    status: /ready\s*to\s*move/i.test(stage) ? 'Ready to Move' : 'Under Construction',
    constructionStage: stage,
    possession: blank(parts[3]) ? '' : parts[3],
    propertyAge: blank(parts[4]) ? '' : parts[4]
  };
}

// "Swaminathan 98848 83370" -> name + number, without losing the original.
function splitContact(raw){
  const s = String(raw || '').trim();
  if(!s) return { contactName:'', contactNumber:'' };
  const m = s.match(/(\+?\d[\d\s\-]{7,}\d)/);
  if(!m) return { contactName:s, contactNumber:'' };
  return { contactName: s.replace(m[1], '').replace(/[-,|]\s*$/,'').trim(), contactNumber: m[1].trim() };
}

function b64url(input){
  return Buffer.from(input).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function getSheetsToken(){
  const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const signInput = `${b64url(JSON.stringify({ alg:'RS256', typ:'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signInput); signer.end();
  const sig = signer.sign(sa.private_key).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion:`${signInput}.${sig}` })
  });
  const data = await res.json();
  if(!res.ok || !data.access_token) throw new Error(`token exchange failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

function getDb(){
  if(!getApps().length) initializeApp({ credential: cert(JSON.parse(fs.readFileSync(SA_PATH,'utf8'))) });
  return getFirestore();
}

// Builds the canonical property document from one sheet row.
function rowToProperty(headers, row){
  const cell = i => {
    const v = row[i];
    return v == null ? '' : String(v).trim();
  };
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
    // Unmapped column — preserved verbatim, rendered in the dashboard's
    // "From the Inventory Sheet" block. A new sheet column needs no code
    // change to show up.
    if(value) sheetExtras[header] = value;
  });

  // Area falls back through the sheet's three area columns, so a row that
  // only fills Super Built-up or Carpet still shows an area on the card.
  if(!out.sqftRange) out.sqftRange = out.superBuiltupArea || out.carpetArea || '';
  if(Object.keys(sheetExtras).length) out.sheetExtras = sheetExtras;

  // An empty sheet cell is treated as "the sheet has nothing to say about
  // this field", NOT as "clear it". Dropping empties means a blank cell can
  // never overwrite richer data already in Firestore — the dry run caught
  // this overwriting real possession dates ("Immediate / Ready to Move")
  // with the placeholder "Contact for details".
  //
  // Consequence worth knowing: blanking a sheet cell does not clear the
  // dashboard. Clear the value in the dashboard itself, which logs it.
  for(const k of Object.keys(out)){
    if(out[k] === '' || out[k] == null) delete out[k];
  }

  out.source = 'inventory-sync';
  out.updatedAt = Date.now();
  return out;
}

// Defaults applied ONLY when creating a property that does not exist yet —
// never on update, where they would clobber an existing value.
function withCreateDefaults(prop){
  return {
    builder: 'Individual Owner',
    type: 'Property',
    startingPrice: 'Price on Request',
    possession: 'Contact for details',
    createdAt: Date.now(),
    ...prop
  };
}

// Only the fields this sync owns are compared — soldOut/interestLevel and the
// pipeline's own fields are excluded so they never appear as spurious diffs.
function diff(before, after){
  const changes = [];
  for(const [k, v] of Object.entries(after)){
    if(k === 'updatedAt' || k === 'source') continue;
    const prev = before ? before[k] : undefined;
    if(k === 'sheetExtras'){
      if(JSON.stringify(prev || {}) !== JSON.stringify(v)) changes.push({ field:k, from:'(map)', to:`${Object.keys(v).length} keys` });
      continue;
    }
    if(String(prev == null ? '' : prev) !== String(v == null ? '' : v)){
      changes.push({ field:k, from: prev == null ? '' : String(prev), to: String(v) });
    }
  }
  return changes;
}

const trunc = (s, n = 40) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// Puts back exactly what a pre-sync backup file recorded. Only touches the
// properties named in that file — anything else is left alone.
async function restore(file){
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const db = getDb();
  console.log(`restoring ${snap.properties.length} propert${snap.properties.length===1?'y':'ies'} from ${snap.takenAt}\n`);
  for(let i = 0; i < snap.properties.length; i += 400){
    const batch = db.batch();
    snap.properties.slice(i, i + 400).forEach(({ id, data }) =>
      batch.set(db.collection('properties').doc(id), data));
    await batch.commit();
  }
  console.log('✓ Restore complete.');
}

async function main(){
  const ri = process.argv.indexOf('--restore');
  if(ri > -1){
    const f = process.argv[ri + 1];
    if(!f || !fs.existsSync(f)){ console.error('Pass an existing backup file: --restore <file>'); process.exit(1); }
    return restore(f);
  }
  if(!fs.existsSync(SA_PATH)){
    console.error(`Service account key not found at:\n  ${SA_PATH}\nSet FIREBASE_SERVICE_ACCOUNT_PATH or place the key there.`);
    process.exit(1);
  }
  console.log(APPLY ? '── APPLY MODE — changes will be written ──\n'
                    : '── DRY RUN — nothing will be written. Re-run with --apply to commit. ──\n');

  const token = await getSheetsToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${INVENTORY_SHEET_ID}/values/${encodeURIComponent(INVENTORY_RANGE)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if(!res.ok) throw new Error(`sheet read failed: ${JSON.stringify(data).slice(0,300)}`);

  const rows = data.values || [];
  const headers = rows[0] || [];
  const unmapped = headers.filter(h => {
    const t = String(h||'').trim();
    return t && !FIELD_MAP[t] && !t.startsWith('Property_Type_New_Resale');
  });
  console.log(`sheet: ${rows.length - 1} rows, ${headers.length} columns`);
  if(unmapped.length) console.log(`unmapped → sheetExtras: ${unmapped.join(', ')}`);
  console.log();

  const db = getDb();
  const snap = await db.collection('properties').where('tenantId','==',TENANT_ID).get();
  const existing = new Map();
  snap.forEach(d => existing.set(d.id, d.data()));
  console.log(`firestore: ${existing.size} properties for ${TENANT_ID}\n`);

  let created = 0, updated = 0, unchanged = 0;
  const matchedIds = new Set();
  const writes = [];

  for(let i = 1; i < rows.length; i++){
    let prop = rowToProperty(headers, rows[i] || []);
    if(!prop) continue;
    if(ONLY_ID && prop.id !== ONLY_ID) continue;
    matchedIds.add(prop.id);

    const before = existing.get(prop.id);
    if(!before) prop = withCreateDefaults(prop);
    const changes = diff(before, prop);
    if(!before){
      created++;
      console.log(`  + CREATE ${prop.id.padEnd(10)} ${trunc(prop.name, 46)}`);
    } else if(changes.length){
      updated++;
      console.log(`  ~ UPDATE ${prop.id.padEnd(10)} ${trunc(prop.name, 46)}`);
      changes.slice(0, 6).forEach(c =>
        console.log(`      ${c.field.padEnd(18)} ${trunc(c.from, 28)}  →  ${trunc(c.to, 28)}`));
      if(changes.length > 6) console.log(`      …and ${changes.length - 6} more field(s)`);
    } else {
      unchanged++;
      continue;
    }
    writes.push(prop);
  }

  // Rule 2 in the header block: these are reported for visibility only and
  // are never modified in any way.
  const orphans = [...existing.keys()].filter(id => !matchedIds.has(id));

  console.log(`\n── summary ──`);
  console.log(`  create   : ${created}`);
  console.log(`  update   : ${updated}`);
  console.log(`  unchanged: ${unchanged}`);
  console.log(`  untouched (no sheet row): ${orphans.length}`);
  if(orphans.length){
    console.log(`    ${orphans.slice(0,12).map(id=>{
      const p = existing.get(id) || {};
      return `${id}${p.name ? ' ('+trunc(p.name,24)+')' : ''}`;
    }).join('\n    ')}`);
    if(orphans.length > 12) console.log(`    …and ${orphans.length - 12} more`);
  }

  if(!APPLY){
    console.log(`\nDry run complete — nothing written. Re-run with --apply to commit.`);
    return;
  }
  if(!writes.length){ console.log('\nNothing to write.'); return; }

  // Full snapshot of every property this run is about to modify, written
  // BEFORE the first write. The dashboard's change log only records edits
  // made by a person, so without this a sync would overwrite existing values
  // with no way back. Restore with: node scripts/sync-inventory.js --restore <file>
  const backupDir = path.join(import.meta.dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `properties-before-sync-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  const backup = writes
    .filter(p => existing.has(p.id))
    .map(p => ({ id: p.id, data: existing.get(p.id) }));
  fs.writeFileSync(backupFile, JSON.stringify({
    takenAt: new Date().toISOString(),
    tenantId: TENANT_ID,
    note: 'Pre-sync snapshot of every property this run modified. Newly created properties are absent by design — they had no prior state.',
    properties: backup
  }, null, 2));
  console.log(`\nbackup: ${backup.length} existing propert${backup.length===1?'y':'ies'} snapshotted to`);
  console.log(`        ${backupFile}`);

  // On a 30-minute schedule these would accumulate indefinitely, so keep only
  // the most recent 40 (roughly the last 20 hours of runs that changed
  // something — runs with no changes never reach this point and write nothing).
  const kept = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('properties-before-sync'))
    .sort()
    .reverse();
  kept.slice(40).forEach(f => {
    try { fs.unlinkSync(path.join(backupDir, f)); } catch {}
  });

  // Chunked well under Firestore's 500-op batch limit.
  for(let i = 0; i < writes.length; i += 400){
    const batch = db.batch();
    writes.slice(i, i + 400).forEach(p => batch.set(db.collection('properties').doc(p.id), p, { merge: true }));
    await batch.commit();
  }
  console.log(`\n✓ Wrote ${writes.length} propert${writes.length === 1 ? 'y' : 'ies'}. ${orphans.length} left untouched.`);
}

main().catch(e => { console.error('sync-inventory failed:', e); process.exit(1); });
