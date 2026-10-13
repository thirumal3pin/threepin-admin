## 3A · Property dashboard (Property Intelligence)

**Console:** `dashboard.html`, share page `property.html`. **Collections:** `properties` (+ `notes`, `internalNotes`), `propertyChanges`, `syncBackups`, `brochureLog`.

The Property dashboard is the agency's single shared list of properties for sale — builder projects and resale / owner listings. It answers an agent's questions: *what do we have, what exactly is it, what can I send the client now, who wants it, what fits this client, where is it, and is the data complete?*

### Screens

| Screen | Purpose |
| --- | --- |
| Property grid (List / Split / Map) | One card per property: code — name, location, agent, status badge, price, rate, area, resource chips (Brochure, Photos, Map Pin, Details), Call, View Details |
| Search box + Advanced Search | Natural search ("3 and 4 bhk in anna nagar under 1.5cr", "sqft:>2000", "builder:sobha") and 20+ filters with live counts |
| Client brief | Paste what the client said → the inventory is ranked for them (35 %+, top 40, with reasons for anything ruled out) |
| Map view | Price pins by precision, nearby places in 12 categories, properties within 5 km / 30 minutes, distance to a typed address; drop an exact pin |
| Property detail panel | Header actions (Share, Save, Lead CRM, Mark Sold Out, Print, Edit, Delete), agents, and tabs: Overview · Matching Buyers · Specifications · Sales Pitch · Notes & CRM · Internal Notes |
| **Shoot & Media and posts** (a block in the detail panel) | Read-only view of the property's marketing, read when the block is opened: each board card with its column, listing type (Exclusive / Collab) and shoot date, **Open card →** and **Seller lead →**; every post (Insta Story, Insta Reel, FB Reel, YouTube, 99 Acres, Website) with status, date and **Link →** or "no link", reposts marked. Changed only on the board and in Posting |
| Missing data | Properties with empty fields, worst first; type a value or mark **Not required** |
| Changes to apply | Every dashboard edit, from → to, who and when — tick once copied into the sheet; CSV export |
| Sync from sheet | Preview the sheet → dashboard changes, then apply all, selected or one |
| Area map | Audit of the Chennai geography the system has learned from the data |
| Duplicates | Pairs that look like one property entered twice — delete the spare by hand |
| Create brochure | Submit a brochure request (code assistant, photos folder, details, internal notes) and track recent brochures |
| Share page `property.html` | Fast one-property view for logged-in colleagues (Overview, Specifications, Sales Pitch only) |

### Process 1 — How a property gets in

| Route | Who / what | Record id | Notes |
| --- | --- | --- | --- |
| **Inventory sheet → Sync** (recommended) | The Mac every run, or **Sync from sheet** | Sheet column A `Property_ID` | Facts are typed in the Inventory master sheet; the dashboard reads it |
| **Brochure pipeline** | Create brochure / Google Form → Queue sheet → Cowork PDF → Mac delivery | First word of the Queue title | Creates the property if new; on an existing one only fills blanks and sets the three delivery links |
| **+ Add Property** | An agent | `p<timestamp>` (even if a code is typed) | Lives only in the dashboard; never synced — the usual source of duplicates |
| First-login seed | System | "1"…"46" | Sample data, once per tenant |

### Process 2 — Sync from the Inventory sheet

1. Read the Inventory sheet and the Queue sheet (columns found by **header text**, never by letter).
2. Build each row into a property. Column F packs *type | sale type | stage | possession | age*; the stage becomes the two-value **status** (Ready to Move / Under Construction) and the original wording is kept.
3. Unknown headers go to **From the Inventory Sheet** (`sheetExtras`) automatically — a new column needs no code change.
4. **Empty cells never clear a value.** Queue photos and details only fill blanks.
5. **Protection:** any field with an un-ticked dashboard change is skipped, so the dashboard's value stays; a pending delete stops the property being recreated.
6. Old properties with no sheet row are **never touched**.
7. Preview first; apply writes a backup (`syncBackups`, or `backups/` on the Mac) and then merges.

### Process 3 — Brochure pipeline (end to end)

1. **Submit** on Create brochure (or the Shoot & Media board's brochure panel): "CODE - Title", Drive photo folder, property details, internal notes. The code assistant suggests the next free code, flags existing codes and near-misses.
2. A row lands in the **Queue sheet**; the request is logged in `brochureLog`.
3. **Cowork** (Claude on the owner's Mac) builds the PDF and sets the row to *Done*.
4. The Mac's **deliver-brochures** job uploads the PDF to the photos folder in Drive, makes it link-readable, emails it to Thirumal, Swami and Pradeep ("Brochure ready: ID — title"), marks the Queue row *Brochure Emailed*, writes the link into the Inventory sheet's `Brochure_Link`, and creates / updates the property in the dashboard. Failures send a "[FAILED]" email (once per 24 h).
5. **Recent brochures** shows In queue / Generated — being sent / Delivered / Needs attention.
6. The Shoot & Media board sees the new property within seconds and links the card that asked for it.

Corrections: `scripts/replace-brochure.js CODE [--notify]` swaps the PDF everywhere.

### Process 4 — Editing, sold out, interest, notes

| Action | Where | What it does | Logged? |
| --- | --- | --- | --- |
| Edit | ✏️ Edit (26 fields, old → new shown inline) | Saves the property (merge); each changed field gets a change-log entry and is protected from the sync until ticked | Yes |
| Mark Sold Out | Header button | SOLD OUT overlay; **ruled out of matching for every buyer**; hidden from nearby; "sold" on CRM chips. The sync never un-sells | Yes |
| Interest level | Notes & CRM → 🔥 Hot / 🌡️ Warm / ❄️ Cold | Team-shared heat of interest (nothing else reads it yet) | Yes |
| Notes & Events | Notes & CRM | Note, Site Visit, Client Call, Price Update, Status Change, Booking — with a date | No (separate log) |
| Internal notes | 🔒 tab | Team-only instructions (owner's number, negotiation floor, access). Never on the share page. Imported ones (Queue, Cowork) become manual once edited | No |
| Agents | Header dropdowns | Property agent and Secondary | No |
| Map pin | Map → Drop the exact pin | Exact position; survives syncs | No |
| Missing data | Missing data panel | Fill a value, or **Not required** (stored in `naFields`) | Yes |
| Delete | 🗑️ | Says how many board cards and CRM leads still point at it (they keep the code but no longer find the property); saves a full copy in the change log **first** — no copy, no delete — then deletes. If the delete itself fails the property is put back, the "Property deleted" entry is set aside as done and a line says the delete did not go through | Yes (with snapshot) |

**Saves wait for the server.** A full save from the Edit form is refused with "Still connecting — your changes are kept here. Press Save again in a moment" until this device has received the server's property list, so a tab that opens on an hours-old local copy can never write it back over a Sync from sheet or a colleague's edit. Only partial saves — the exact map pin — go through before that.

### Process 5 — Copy dashboard edits back to the sheet (by hand, by design)

There is **no automatic write-back**. The maintainer opens **Changes to apply → Pending**, makes the same change in the Inventory sheet, then ticks the row. Ticking hands that field back to the sheet: from the next sync, the sheet's value wins. Entries can never be deleted.

### Process 6 — Matching buyers and client briefs

The **match engine** (shared with the CRM and the board) scores every buyer lead against the property in four layers: rule-outs (wrong type, a stated objection, sold out) → weighted attributes (Budget 28, Location 22, Configuration 16, Type 14, Size 10, Possession 9, Lifestyle 8, Amenities 6, Vastu 5, Approval 4, Facing 4, Builder 4, and smaller ones) → wording similarity → objection penalties. Bands: **85 %+ Strong match · 70 %+ Worth a call · 55 %+ Partial · below that Long shot**. Matching Buyers lists them with Open in CRM and Call.

### Process 7 — Sharing

| With | How | What they get |
| --- | --- | --- |
| A colleague | 🔗 Share Link | `property.html?id=…` — needs a login |
| The CRM | **Lead CRM** header button | `crm.html?propertyId=…` — the CRM filtered to the leads linked to this property, matched by its id or its code |
| A customer | 💬 Details → Copy → WhatsApp | The exact intake description (`detailsText`), no internal link |
| A customer | 📑 Brochure / 🖼️ Photos | The public PDF / the photo folder |
| Anyone | Print, JSON, Compare + CSV | Printable summary; raw record; side-by-side table |

### Field reference — property (`properties/{id}`)

Ownership tiers decide who may write each field: **A** = Inventory sheet (facts) · **B** = dashboard (working state) · **C** = brochure pipeline (delivery links) · **D** = system.

| Field | Label | Values | Tier | Sheet column | Read elsewhere / why |
| --- | --- | --- | --- | --- | --- |
| `propertyCode` / `id` | Property Code | Locality letters + number (TNAG0002, MYLA002, LUX049) | A / D | `Property_ID` | **The key that joins every module** — CRM leads, board cards, Posting rows, Finance deals, calendar invites |
| `name` | Property Name | Text | A | `Property_Name_Project` | Everywhere; board title; Finance deal name |
| `builder` | Builder | Text (default Individual Owner) | A | – | Search; matching (Builder 4) |
| `location`, `zone` | Location, Zone | Narrow → broad text; region | A | `Location_Area`, `Zone` | Search, matching, map, site-visit invite "Where" |
| `type`, `saleType` | Type | Apartment, Villa, Plot, House…; New / Resale | A | Column F parts 1–2 | Type rule-outs; New/Resale filter |
| `status` | Status | **Only** Ready to Move or Under Construction | A | Column F part 3 | Counters and filters — any other value drops out of both |
| `constructionStage`, `possession`, `propertyAge` | Stage, Possession, Age | Text | A | Column F parts 3–5 | Badge text; matching (Possession 9, Age 2) |
| `availability` | Availability | Available / Immediate / Sold | A | `Availability_Status` | Search filter (not a matching rule-out) |
| `config` | Configuration | "3 BHK", "2, 3 BHK" | A | Config column | Matching (Configuration 16) |
| `startingPrice`, `pricePerSqft` | Starting Price, Rate / Sqft | "₹1.25 Crores", "₹7999/Sqft" | A | `Price`, `Rate_per_Sqft_INR` | Matching (Budget 28), map price pills, board asking price, Finance picker |
| `sqftRange`, `superBuiltupArea`, `carpetArea`, `totalLandArea`, `uds` | Areas | Text sqft / cents / grounds | A | Area columns | Size matching; land search |
| `totalUnits`, `totalTowers`, `totalFloors`, `floorNo` | Project / building | Text | A | Matching columns | Specs; matching (Floor 3) |
| `facing`, `bathrooms`, `parking`, `parkingType`, `furnishing`, `cornerUnit`, `vastu`, `powerBackup`, `approval` | Key facts | Text | A | Matching columns | Filters and matching weights |
| `highlights`, `amenities` | Highlights, Amenities | Comma lists | A | `Highlights`, `Amenities` | Sales Pitch; 26 amenity tags |
| `nearbyLandmark`, `connectivity`, `mapLink` | Location & connectivity | Text; Maps link | A | Matching columns | Area model, map position |
| `contactName`, `contactNumber` | Contact | Text | A | `Owner_Builder_Contact` | Call buttons; **site-visit invitation "Seller: name · number"** |
| `sheetNotes`, `sheetExtras` | Notes; From the Inventory Sheet | Text; header → value | A | `Notes`; any unmapped column | Search; new columns appear without code |
| `brochureLink`, `photosLink`, `detailsText` | Brochure, Photos, Shareable Details | Drive links; text | C | `Brochure_Link`, `Images_URL`; Queue C / D | Resource chips; board brochure state; client WhatsApp text |
| `soldOut` | Mark Sold Out | Yes / No | B | – | **Matching rule-out**, map, CRM chips, board |
| `interestLevel` | Client Interest Level | hot / warm / cold | B | – | Team signal |
| `naFields` | Not required | List of fields | B | – | Missing data count |
| `assignedAgent`, `secondaryAgent` | Property agent, Secondary | Team emails | B | – | Agent filter |
| `geo`, `mapPinSnoozed` | Map pin | lat, lng, precision | B | – | Distances on the map |
| `createdAt`, `updatedAt`, `source`, `tenantId` | – | – | D | – | Sorting, audit, scoping |

**Never write** the eight dead names `propertyId`, `propertyType`, `price`, `priceInCr`, `readyToMove`, `newOrResale`, `possessionDate`, `builtupArea` — they once caused dashboard edits to silently revert.

**Missing data checks 30 fields:** core (config, area, price, rate, possession, availability), specs (land, UDS, units, floors, floor no., facing, bathrooms, parking, furnishing, vastu, power backup, approval, age), location (zone, map link, landmark, connectivity), marketing (highlights, amenities, photos, brochure, details) and contact (name, number).

### Related records

| Record | Contents | Why |
| --- | --- | --- |
| `properties/{id}/notes` | Kind (note, visit, call, price, status, booking), date, text, author | Shared history of what happened with this property |
| `properties/{id}/internalNotes` | Text, source (manual / queue-sheet / cowork-generation) | Team-only instructions; the board reads them when mapping |
| `propertyChanges` | Field, from → to, who, when, applied-to-sheet tick, full copy on delete | Reconciliation worklist and sync protection |
| `brochureLog` | Title, who, when | Recent brochures status |
