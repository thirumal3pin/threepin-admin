# Property Data Pipeline — Operations Manual

The complete workflow, dependencies, monitoring and troubleshooting for the
property-listing system: Inventory sheet → Firestore → Dashboard, plus the
brochure pipeline that feeds it. This is the operator/maintainer doc — the
phone-friendly team runbooks live in [`../User manual/SOP.md`](../User%20manual/SOP.md).

Last verified against the live system: **23 Aug 2026**.

---

## 1. The one rule everything follows

**Every field has exactly one owner. A writer only writes the fields it owns.**

| Tier | Owner | Fields |
|---|---|---|
| **A — Property facts** | Inventory master sheet | name, location, zone, type, config, status, possession, prices, areas, floors, facing, bathrooms, furnishing, vastu, approval, highlights, amenities, landmarks, connectivity, mapLink, contact, availability, sheetNotes |
| **B — Working state** | Dashboard (agents) | `soldOut`, `interestLevel`, `naFields`, notes & events subcollection |
| **C — Delivery artifacts** | Brochure pipeline (Mac) | `brochureLink`, `photosLink`, `detailsText` |
| **D — System** | Whichever writer creates the doc | `id`, `propertyCode`, `tenantId`, `createdAt`, `updatedAt`, `source` |

Consequences that follow from the rule:

- The Inventory sheet is **never written to** by any sync. Reconciliation of
  dashboard edits back into the sheet is **manual**, driven by the dashboard's
  **Changes** worklist.
- The sync **fills blanks but never overwrites** Tier C, and never touches
  Tier B at all. A re-run cannot un-sell a property or wipe a rating.
- A property with **no Inventory row is never touched** by the sync — the 53
  older listings with random codes stay exactly as they are.
- An **empty sheet cell means "nothing to say", not "clear it"**. To clear a
  value, clear it in the dashboard (which logs the change).

---

## 2. Complete workflow

```
                        ┌────────────────────────────┐
   Google Form intake   │  QUEUE SHEET               │
   ("Create Brochure"   │  Form Responses 1          │
   button or the form)  │  B: PropID+Title           │
          │             │  C: photo folder link      │
          └────────────►│  D: WhatsApp details text  │
                        │  E: Status (Cowork writes) │
                        │  F: Brochure Emailed       │
                        └──────────┬─────────────────┘
                                   │ read every 30 min
                                   ▼
   Cowork task builds   ┌────────────────────────────┐         ┌─────────────────┐
   brochure PDF on  ───►│  MAC SCHEDULER (launchd)   │ uploads │  GOOGLE DRIVE   │
   the Mac              │  deliver-brochures.js      │────────►│  brochure PDF   │
                        │  then                      │         │  + photo folder │
                        │  sync-inventory.js --apply │         └─────────────────┘
                        └──────────┬─────────────────┘
                                   │ writes (Admin SDK, bypasses rules)
                                   ▼
   INVENTORY MASTER     ┌────────────────────────────┐
   SHEET (36 cols A–AJ) │  FIRESTORE  `properties`   │
   ── where you type ──►│  + propertyChanges (log)   │
   read-only, keyed by  │  + properties/{id}/notes   │
   header text, via     │  + syncBackups (server)    │
   sync-inventory.js    └──────────┬─────────────────┘
                                   │ onSnapshot (client SDK, rules apply)
                                   ▼
                        ┌────────────────────────────┐
                        │  DASHBOARD  dashboard.html │
                        │  · grid + detail view      │
                        │  · 🔄 Sync from Sheet      │
                        │  · 🕒 Changes worklist     │
                        │  · ⚠️ Missing Data         │
                        │  · Notes & Events          │
                        │  property.html (share link)│
                        └────────────────────────────┘
```

**Data enters the system three ways:**

1. **A new row in the Inventory sheet** → next sync run (Mac, every 30 min, or
   the dashboard's Sync button) creates the property with all 36 columns
   mapped. Unmapped/new columns land in `sheetExtras` and display
   automatically — adding a column needs no code change.
2. **The brochure intake form** ("📋 Create Brochure" in the dashboard, or the
   Google Form directly) → Queue row → Cowork generates the PDF on the Mac →
   scheduler uploads it, emails it, writes the link to Inventory column
   `Brochure_Link` (resolved by header, not letter) and upserts the property.
3. **Manual add in the dashboard** ("+ Add Property") → Firestore only. Use for
   one-offs that aren't in the sheet; remember the sheet won't know about it.

**Dashboard edits** go to Firestore only, and every edit is recorded in the
**Changes** worklist (who, when, field, from → to) for manual transfer to the
sheet, tick-off when done.

---

## 3. External dependencies

| Dependency | Used for | Auth | Failure symptom |
|---|---|---|---|
| **Google Sheets API** | Inventory + Queue reads; Inventory `Brochure_Link` + Queue col F writes (Mac only) | Service account, **direct sharing** (see below) | Sync error, or scheduler `Sheets read failed` |
| **Google Drive API** | Brochure upload, photo folders | Same service account (Mac flow) | Delivery fails at `drive put` |
| **Firebase Firestore** | All property/lead data | Client SDK (rules) + Admin SDK (bypasses rules) | Dashboard empty / `Missing or insufficient permissions` |
| **Firebase Auth** | Dashboard/CRM login, `tenantId` claim | Email+password, custom claims | Login fails, or logged in but no data (no claim) |
| **Vercel** | Hosting, `api/*` serverless, auto-deploy on push to `main` | `FIREBASE_SERVICE_ACCOUNT_JSON` env var | Sync button 500s; site down |
| **Google Forms** | Brochure intake | Public form POST (no auth readable) | Submissions silently vanish if the form's field IDs change |
| **Mac (launchd)** | The 30-min scheduler; the **only** place brochure PDFs exist | Local key file | Nothing delivers; Inventory sync stops refreshing (button still works) |
| **Cowork task** | Generates brochure PDFs into `~/Downloads/Product brochure ` | — | Queue rows stuck at non-Done status |
| **Gmail (nodemailer)** | Digest emails | `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Digests stop; brochure email is separate (via brochure API) |

### The service account — the single most important credential

`firebase-adminsdk-fbsvc@pin-realty.iam.gserviceaccount.com`

- Key file: `api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json` — exists
  on the Mac and the Windows machine, **gitignored** (`*firebase-adminsdk*.json`),
  never committed. Same JSON is Vercel's `FIREBASE_SERVICE_ACCOUNT_JSON`.
- **Domain-wide delegation is NOT authorised** — impersonating
  `thirumal@threepin.in` fails by design. Access works by **sharing each sheet
  directly with the service-account address**. Both the Inventory and Queue
  sheets are shared today. **Any new sheet must be explicitly shared** or
  reads 403.
- If the key is ever compromised: create a new key in Google Cloud Console →
  IAM → Service Accounts → Keys (creating does not disable the old one),
  replace the file on both machines and the Vercel env var, **then** delete
  the old key. Deleting first breaks the Mac scheduler and every API endpoint
  at once.

### IDs pinned in code (`api/_inventory-shared.js`, `scripts/deliver-brochures.js`)

| What | ID |
|---|---|
| Inventory sheet | `1X53_F-S9ezL70Dy2c7a6DG06ljD7bGCb3HauysPMZ8I` |
| Queue sheet | `1MlepLxnA1-OzHHYd-8S1YKRPCk3Cvz8g1md3eWthsY4` |
| Tenant | `t_3pinrealty` |
| Firebase project | `pin-realty` |

---

## 4. The Inventory sheet contract

- **36 columns, A–AJ**, mapped **by header text** (`FIELD_MAP` in
  `api/_inventory-shared.js`) — columns can be **reordered** freely and
  **new columns can be added** (they surface via `sheetExtras`). What breaks
  the mapping is **renaming a header** — the old field stops updating and the
  column falls through to `sheetExtras` instead. If you must rename, update
  `FIELD_MAP` in the same change.
- **Column A `Property_ID`** is the identity — it becomes the Firestore
  document ID. Never reuse or change an ID; a changed ID creates a second
  property.
- **Column F** packs five facts pipe-separated:
  `Apartment | Resale | Ready to Move | - | 5 Years` →
  type · saleType · status · possession · propertyAge. `-` means blank.
  The status part maps onto the strict enum: anything that isn't literally
  "Ready to Move" (Demolition stage, Pre-Launch, Ready to Construct…)
  becomes **Under Construction**, with the original wording preserved in
  `constructionStage`.
- **Column AJ `Notes`** — free text, any length (longest today: 2,505 chars).
  Stored whole as `sheetNotes`, displayed with line breaks in the detail view.
- Scheduler writes **only** `Brochure_Link` (found by header) — nothing else,
  ever.

---

## 5. Monitoring — where to look

| What | Where | Healthy looks like |
|---|---|---|
| Brochure deliveries | **Inventory sheet → "Delivery Log" tab** (every run appends, including "No candidates") | A row every 30 min while the Mac is awake |
| Queue state | Queue sheet, cols E/F | `Done` rows all have col F filled |
| Sync activity | Dashboard **🔄 Sync from Sheet** → dry-run preview | "Everything already matches" when idle |
| Dashboard edits pending transfer | Dashboard **🕒 Changes** (Pending filter) | Reviewed and ticked off regularly |
| Data completeness | Dashboard **⚠️ Missing Data** badge/panel | Count trending down |
| Sync history / undo points | `backups/` on the Mac (last 40) · `syncBackups` collection (button runs) | Timestamped snapshots present after any run that changed data |
| Serverless errors | Vercel dashboard → project → Logs, filter `api/sync-inventory` | No repeated 500s |
| Firestore state | Firebase console → Firestore → `properties` | `source` field says who last wrote each doc |
| Rules deployments | `firestore.rules` in repo vs. Firebase console Rules tab | Identical (repo is source of truth) |

**Weekly 5-minute health check:** open the Delivery Log tab (rows appearing?),
open Changes → Pending (anything to carry to the sheet?), open Missing Data
(anything quick to fill?), run the Sync button preview (should say nothing to
do if the Mac schedule is healthy).

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Edited a property, value reverted | Historic bug (fixed 23 Aug 2026) — if it recurs, a writer is claiming a field it doesn't own | Check the doc's `source` and `updatedAt` in Firestore console; see §1 ownership and check recent code changes to any writer |
| Notes / Changes / sync always error "permission denied" | `firestore.rules` not deployed after a change | `node scripts/deploy-firestore-rules.js`, then verify in Firebase console |
| Sync button: "This sheet is not available for your account" | Logged-in user's `tenantId` ≠ `t_3pinrealty` | Expected for other tenants; for a teammate, provision via `scripts/add-team-member.js` |
| Sync button: 500 "missing FIREBASE_SERVICE_ACCOUNT_JSON" | Vercel env var lost/renamed | Re-add in Vercel → Settings → Env, redeploy |
| Sync error `Inventory sheet read failed … 403` | Sheet not shared with the service account (new sheet, or sharing removed) | Share the sheet with `firebase-adminsdk-fbsvc@pin-realty.iam.gserviceaccount.com` (Viewer) |
| Sheet edit not appearing in dashboard | Mac asleep / scheduler stalled; or you edited an **orphan** property (no sheet row ever syncs) | Press 🔄 Sync from Sheet; check Delivery Log for gaps; confirm the row's `Property_ID` matches the doc ID |
| New sheet column not showing as a proper field | It's in `sheetExtras` (unmapped) — displays under "From the Inventory Sheet" | Fine as-is; to promote it, add to `FIELD_MAP` **and** the pipeline handoff schema |
| Property invisible in both status filters | `status` isn't exactly `Under Construction` / `Ready to Move` | Fix the sheet's column F status part; sync; never hand-type other values |
| Property card unclickable | Doc missing the `id` field matching the doc path (legacy writer) | Set `id` = document ID in Firestore console |
| Duplicate property (two cards, same building) | Same property entered manually (`p<timestamp>` id) and via sheet (`CODE` id) | Copy any Tier B/C data onto the sheet-coded doc, delete the manual one (delete is logged with a full snapshot in Changes) |
| Brochure delivered but link not in the sheet | Header `Brochure_Link` renamed, or row's Property_ID mismatch | Restore the header text; check Delivery Log row for the error detail |
| Everything gone from dashboard | Auth/claim issue (not data loss — check Firestore console first) | Sign out/in; verify `tenantId` claim; check `firestore.rules` deployment |
| 46 sample properties appeared | `propertiesSeededFlags/t_3pinrealty` was deleted → re-seed ran | Delete the sample docs (ids `1`–`46` with `source` absent), recreate the flag doc `{done:true}` |
| Mac replaced / reformatted | Scheduler + PDFs + key live there | Restore: repo clone, key file into `api/`, `.env` with `WEBHOOK_SHARED_SECRET`, launchd job running `deliver-brochures.js` then `sync-inventory.js --apply`, brochure folder path intact |

### Undo / disaster recovery

- **Undo a bad sync (CLI):** `node scripts/sync-inventory.js --restore backups/<file>.json`
- **Undo a bad sync (button):** copy the `syncBackups/<runId>` doc's properties
  back via Firestore console, or run the CLI restore against an exported copy
- **Undo a property delete:** the Changes list keeps a full JSON `snapshot` on
  every delete entry — recreate the doc from it
- **Firestore has no point-in-time recovery on this plan** — the backups above
  are the recovery story. Don't disable them.

---

## 7. Maintenance rules for developers

1. **Never spread raw input into a property doc** (`{...data}`) — build
   key-by-key. The eight dead alt-schema names must never come back:
   `propertyId, propertyType, price, priceInCr, readyToMove, newOrResale,
   possessionDate, builtupArea`.
2. **All writers share one mapping** — `api/_inventory-shared.js`. Change field
   semantics there, nowhere else. The CLI, the button endpoint and the Mac
   pipeline must never have private copies.
3. **New field?** Assign its tier first (§1). Tier A → `FIELD_MAP` + detail
   view; Tier B → dashboard only, and add to the sync's never-write knowledge
   if applicable.
4. **`firestore.rules` deploys are manual** — pushing to git does nothing.
   `node scripts/deploy-firestore-rules.js` after any rules change.
5. **Writes to `properties` always use `{ merge: true }`** and set `updatedAt`.
6. **`propertyChanges` is append-only by rule** — never add a delete path; it's
   the audit trail and the delete-recovery store.
7. Sheet code must **resolve columns by header text** — a hardcoded column
   letter is how brochure links silently vanished into empty column AR.
8. Both Claude Code environments (Mac + Windows) push to this repo — **fetch
   and check `origin/main` and open merge branches before building**, and keep
   `docs/mac-scheduler-handoff.md` conventions when handing work across.
