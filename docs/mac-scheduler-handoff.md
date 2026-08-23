# Handoff prompt — update `scripts/deliver-brochures.js` on the Mac

The Inventory sheet columns were changed on 22 Aug 2026, and the dashboard's
property schema was reworked on 23 Aug 2026. `deliver-brochures.js` has not
caught up with either. It runs on the Mac (launchd, every 30 min), so it has
to be updated there.

**Copy everything between the two rulers into Claude Code on the Mac, in the
`threepin-admin` repo.**

---
---

## Scope — read this first

**This script stays exactly where it is and keeps doing its job.** It runs on
this Mac under launchd every 30 minutes and that is not changing. The Mac is
the only machine holding the generated brochure PDFs, so it must remain the
thing that uploads and emails them. Nothing below moves, replaces, disables
or reduces the schedule.

Every change requested here is about **which fields it writes into Firestore**
and **which spreadsheet cell it writes the brochure link to**. The delivery
pipeline itself — reading the Queue sheet, finding the local PDF, uploading to
Drive, sending the email, marking column F — is correct and must keep working
unchanged.

Do not refactor the delivery logic. Do not move anything to a server. If a
change you are considering would stop a brochure being delivered, it is the
wrong change.

---

There are three problems in `scripts/deliver-brochures.js`. Please fix all
three.

## Problem 1 — brochure links are written to a column that no longer exists

Line 40 hardcodes a column letter:

```js
const INVENTORY_BROCHURE_LINK_COL = 'AR'; // 44th of 46 columns, see the Cowork task spec
```

The Inventory sheet was changed and now has **36 columns, A–AJ**. `AR` is the
44th column — eight past the end. The real column is **AH, headed
`Brochure_Link`**. I verified this against the live sheet: 27 rows have AH
populated, and **zero rows have any data at AR or anywhere past AJ**.

The consequence is silent: the Sheets API accepts a write to any cell, so
every future delivery would drop its Drive link into empty space while the
real `Brochure_Link` column stays blank. Nothing errors.

**Do not just change `'AR'` to `'AH'`.** That re-arms the identical trap the
next time a column moves. Instead, resolve the column by its header text at
run time:

- Read `Inventory!A1:BZ1` once per run.
- Find the index of the header exactly equal to `Brochure_Link`.
- Convert that index to a column letter and use it for the write.
- If the header is not found, **skip the write and log a clear warning** —
  never fall back to a hardcoded letter, because writing to the wrong column
  is worse than not writing at all.

Do the same for the Property ID lookup: find the column headed `Property_ID`
rather than assuming `A`. It is currently column A, but the same reasoning
applies.

## Problem 2 — the dashboard upsert writes a second, conflicting schema

`mapToDashboardProperty()` (around line 63) does `{ ...data, ... }` — it
spreads the raw brochure JSON into the Firestore document and then layers
computed fields on top. That means every property carries **both** naming
schemes forever: `readyToMove` alongside `status`, `propertyType` alongside
`type`, and so on.

This caused a real, user-visible bug. The dashboard recomputed `status` from
the invisible `readyToMove` field on every save, silently discarding the
user's edit. Editing the Firestore document by hand was the only thing that
worked. Four more fields had the same fault. The dashboard side is fixed —
the canonical field now always wins — but the pipeline must stop writing the
dead names.

**Rewrite `mapToDashboardProperty()` to build its output key by key. Never
spread the raw input.**

### Never emit these eight field names

```
propertyId  propertyType  price  priceInCr
readyToMove  newOrResale  possessionDate  builtupArea
```

Map them to their canonical equivalents instead:

| Dead name | Use instead |
|---|---|
| `propertyId` | `id` and `propertyCode` (same value) |
| `propertyType` | `type` |
| `price`, `priceInCr` | `startingPrice` (format `priceInCr` as `"₹1.25 Cr"`) |
| `readyToMove`, `newOrResale` | `status` |
| `possessionDate` | `possession` |
| `builtupArea` | `sqftRange` |

Note: `superBuiltupArea` and `carpetArea` are **legitimate** fields — the
sheet has real columns for both. Keep them. `sqftRange` should fall back
through `builtupArea` → `superBuiltupArea` → `carpetArea`.

### Never emit these two fields

`soldOut` and `interestLevel` are owned by the dashboard. Writing either
would un-sell a sold property or wipe a lead rating on the next run.

`availability` is owned by the Inventory sheet (column G) — the pipeline
should not write it either.

### `status` is a strict two-value enum

Exactly `"Under Construction"` or `"Ready to Move"`. Any other string drops
the property out of **both** dashboard status filters, making it invisible.

If the source describes something else — `"Demolition stage"`, `"Pre-Launch"`,
`"Ready to Construct"` — map it to `"Under Construction"` and preserve the
original wording in a separate `constructionStage` field so nothing is lost.

### The full document shape

Every value is a string unless marked. Omit a key entirely rather than
writing `null` or `""` — an empty value must never overwrite existing data.

```jsonc
{
  // identity — all three required; id === propertyCode === Inventory col A
  "id": "MYLA002",
  "propertyCode": "MYLA002",
  "tenantId": "t_3pinrealty",

  // basic
  "name": "...", "builder": "...", "location": "...",
  "type": "Apartments", "config": "2BHK / 3BHK", "zone": "Chennai South",

  // status — see the enum rule above
  "status": "Under Construction",
  "constructionStage": "Pre-Launch",
  "saleType": "New",
  "possession": "Q1 - 2028",
  "propertyAge": "Brand New",

  // pricing
  "startingPrice": "₹1.25 Crores",
  "pricePerSqft": "₹7999/Sqft",

  // specs
  "sqftRange": "1250-2000 Sq.Ft",
  "superBuiltupArea": "", "carpetArea": "", "uds": "600 Sqft UDS",
  "totalUnits": "71", "totalTowers": "1", "totalFloors": "Stilt + 5",
  "floorNo": "2nd Floor", "facing": "East", "bathrooms": "3",
  "parking": "1", "parkingType": "Covered", "furnishing": "Unfurnished",
  "cornerUnit": "", "vastu": "100% Vaastu Compliance",
  "powerBackup": "YES", "approval": "CMDA",

  // comma-separated — the dashboard renders each item individually
  "highlights": "One,Two,Three",
  "amenities": "Pool,Gym,Clubhouse",

  // location
  "nearbyLandmark": "...", "connectivity": "...", "mapLink": "https://...",
  "contactName": "Swaminathan", "contactNumber": "98848 83370",

  // delivery artifacts — the pipeline owns these
  "brochureLink": "https://drive.google.com/file/d/FILE_ID/view",
  "photosLink": "https://drive.google.com/drive/folders/FOLDER_ID",
  "detailsText": "the pasted intake description, verbatim",

  // free-text notes from the sheet's Notes column, kept whole
  "sheetNotes": "...",

  // any other source field with no canonical home, keyed by its label.
  // The dashboard renders all of it automatically — nothing is dropped.
  "sheetExtras": { "Any Label": "any value" },

  // audit — numbers, epoch milliseconds
  "createdAt": 1755950000000,
  "updatedAt": 1755950000000,
  "source": "pipeline"
}
```

### Write rules

1. Document ID **must** equal the Property ID, so a re-delivery updates the
   existing record instead of creating a duplicate.
2. Always `{ merge: true }`.
3. Set `updatedAt` on every write.
4. Never delete a property document — the dashboard owns deletion and logs it.

## Problem 3 — two writers claim the same fields

This is the most important one, and it is not visible from reading
`deliver-brochures.js` alone.

There are now **two** writers into the `properties` collection:

| Writer | Trigger | Reads from |
|---|---|---|
| `deliver-brochures.js` (this file, on the Mac) | launchd, every 30 min | Queue sheet + local brochure JSON |
| `scripts/sync-inventory.js` | run manually | Inventory master sheet |

They currently overlap on **25 properties** and on every descriptive field:
`name`, `type`, `status`, `possession`, `startingPrice`, `sqftRange` and
more. Whichever runs last wins, so a brochure delivery can silently revert a
correction made in the Inventory sheet. That is the same class of bug as
Problem 2, one level up.

Firestore itself is safe — merge writes are atomic per document, so there is
no corruption or crash risk. The problem is purely *who owns which field*.

### The rule to implement

**The Inventory sheet is the source of truth for descriptive fields. This
script owns only the delivery artifacts.**

So, in `upsertDashboardProperty()`:

1. `get()` the existing document first.
2. **If it does not exist** — write the full document, descriptive fields
   included. This covers a brochure being delivered before the property has
   been entered into the Inventory sheet, so the card is never blank.
3. **If it already exists** — write **only** these, and nothing else:
   - `brochureLink`, `photosLink`, `detailsText`
   - `updatedAt`, `source: 'pipeline'`
   - any descriptive field that is currently **missing or empty** on the
     document (fill blanks, never overwrite)

Never overwrite a descriptive field that already has a value. The Inventory
sync is responsible for those, and it will refresh them from the sheet.

This rule is deliberately ordering-independent: it does not matter whether
the Mac or the sync ran most recently, and neither needs to know about the
other. Do not attempt to coordinate the two by timing or by a lock.

### A note on `brochureLink`

Once Problem 1 is fixed, the brochure link is written to the Inventory
sheet's `Brochure_Link` column. The Inventory sync then reads it back into
Firestore. So the sheet becomes the shared record and both writers converge
on the same value — no conflict. Keep writing `brochureLink` to Firestore
directly as well; it makes the link available immediately rather than after
the next sync.

## Context you may find useful

- `scripts/sync-inventory.js` in this repo already reads the Inventory sheet
  and maps all 36 columns to exactly this schema. **Reuse its `FIELD_MAP`,
  `parseCompound()` and `splitContact()` rather than reimplementing them** —
  matching behaviour between the two writers is the whole point.
- Column F of the Inventory sheet packs five facts into one pipe-separated
  cell: `Apartment | Resale | Ready to Move | - | 5 Years` →
  type, saleType, status, possession, propertyAge. `parseCompound()` handles
  this, including treating `-` as blank.
- Both the Inventory and Queue sheets are now shared directly with
  `firebase-adminsdk-fbsvc@pin-realty.iam.gserviceaccount.com`. Domain-wide
  delegation for `thirumal@threepin.in` is **not** authorised on this project,
  so the impersonated token path fails — the bare service account works. If
  the impersonation fallback is still in the auth code, keep it, but expect
  the bare path to be the one that succeeds.

## Please verify before finishing

1. **Delivery still works.** This matters more than everything else here. A
   brochure must still upload to Drive, email correctly, and mark Queue
   column F. If in doubt, test end to end on one property.
2. The brochure link lands in **column AH**, under the `Brochure_Link`
   header — resolved by header lookup, not a hardcoded letter.
3. The written Firestore document contains **none** of the eight dead field
   names, and **neither** `soldOut` nor `interestLevel`.
4. `status` is one of the two allowed strings.
5. The document ID equals the Property ID.
6. Re-delivering a property that already exists does **not** change its
   `name`, `status`, `possession` or `startingPrice` — only its
   `brochureLink`, `photosLink`, `detailsText` and `updatedAt`.

Point 6 is the one that proves Problem 3 is actually fixed. Worth testing
explicitly: note a property's `status` before, re-run delivery for it, confirm
the status is untouched afterwards.

---
---

## Part 2 — also run the Inventory sync on this Mac

`scripts/sync-inventory.js` reads the Inventory master sheet and updates the
dashboard's `properties` collection. It is currently run by hand. It should
run on this Mac, on the same 30-minute schedule, **immediately after**
`deliver-brochures.js`.

### Why it belongs here

The two scripts read different sheets and do different jobs:

- `deliver-brochures.js` reads the **Queue** sheet and acts on one property
  per brochure delivery.
- `sync-inventory.js` reads the **Inventory** sheet and refreshes all rows.

Nothing currently notices when someone edits the Inventory sheet — the Mac
only reads the Queue. Without this sync, sheet edits never reach the
dashboard. It runs here rather than on a server because this Mac already has
the service account key, network access and a working scheduler.

### Wiring it up

Run it **after** the brochure job in the same launchd invocation, sequentially,
not as a second parallel job:

```sh
node scripts/deliver-brochures.js
node scripts/sync-inventory.js --apply
```

Order matters, but only mildly: the Inventory sheet is the source of truth for
descriptive fields, so it should have the last word. Once Problem 3 is fixed
the two no longer overwrite each other's fields, so either order is safe —
this order is just belt and braces.

### What to know before scheduling it

- **It is idempotent.** Verified: an apply followed immediately by another run
  reports `0 create / 0 update / 45 unchanged`. A run with nothing to do
  writes nothing at all.
- **It never writes to any sheet.** Read-only scope on the Sheets API.
- **It never touches a property with no Inventory row.** 53 older listings
  with random codes are protected by this rule — they must stay untouched.
- **It never writes `soldOut` or `interestLevel`.**
- **It backs up before every apply** to `backups/`, keeping the most recent
  40 files. Restore with
  `node scripts/sync-inventory.js --restore <file>`.
- **An empty sheet cell never clears an existing value.** Blank means "the
  sheet has nothing to say", not "delete this".

### Verify after wiring

Run `node scripts/sync-inventory.js` (no `--apply`) by hand first. It prints
the full diff and writes nothing. Confirm the untouched count is 53 and that
nothing unexpected appears, then add the `--apply` line to the schedule.

## After the Mac is updated

The eight dead field names still exist on properties written by earlier runs.
Once the pipeline stops emitting them, they can be stripped with a one-off
script — but only after confirming nothing else reads them. Ask before running
anything that rewrites existing documents in bulk, and take a backup first
(see `scripts/sync-inventory.js`, which snapshots to `backups/` before every
apply).
