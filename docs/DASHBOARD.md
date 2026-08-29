# Property Dashboard — Complete Guide

**URL:** `https://admin.threepin.in/dashboard.html`
**Who it's for:** every agent and the owner. Same login as the CRM.
**What it does:** the searchable catalogue of every property you can sell, with
everything you need on a client call already loaded — price, specs, brochure,
photos, map pin and a ready-to-send WhatsApp blurb.

> Companion guides: [`CRM.md`](CRM.md) (leads), [`SOP.md`](SOP.md) (access, ops,
> incidents), [`PROPERTY-PIPELINE.md`](PROPERTY-PIPELINE.md) (how property data
> flows end to end).
> Verified against the live code on **27 Aug 2026**.

---

## Contents

1. [The 60-second version](#1-the-60-second-version)
2. [Getting in](#2-getting-in)
3. [Where property data comes from — the one rule](#3-where-property-data-comes-from--the-one-rule)
4. [The page, part by part](#4-the-page-part-by-part)
5. [Finding a property](#5-finding-a-property)
6. [The property card](#6-the-property-card)
7. [The detail panel and its four tabs](#7-the-detail-panel-and-its-four-tabs)
8. [Sharing — three different buttons, three different jobs](#8-sharing--three-different-buttons-three-different-jobs)
9. [Working state — Sold Out, Interest Level, Favourites](#9-working-state--sold-out-interest-level-favourites)
10. [Notes and Events](#10-notes-and-events)
11. [Adding and editing properties](#11-adding-and-editing-properties)
12. [🔄 Sync from Sheet](#12--sync-from-sheet)
13. [🕒 Changes — the reconciliation worklist](#13--changes--the-reconciliation-worklist)
14. [⚠️ Missing Data](#14-️-missing-data)
15. [📋 Create Brochure](#15--create-brochure)
16. [Compare and export](#16-compare-and-export)
17. [The shared property page](#17-the-shared-property-page)
18. [Daily and weekly routine](#18-daily-and-weekly-routine)
19. [Field reference](#19-field-reference)
20. [FAQ](#20-faq)
21. [Troubleshooting](#21-troubleshooting)
22. [Known limits](#22-known-limits)

---

## 1. The 60-second version

- Every property you can sell is a **card** in one searchable grid.
- Tap a card to open the **detail panel** — four tabs: Overview,
  Specifications, Sales Pitch, Notes & CRM.
- **The Inventory master sheet is the source of truth for property facts.** The
  dashboard reads from it; it never writes back.
- Edits you make here are real and immediate, and each one is written to the
  **🕒 Changes** worklist so someone can carry it into the sheet by hand.
- **⚠️ Missing Data** shows every gap before a client asks about it.
- **🔗 Share Link** is for colleagues. **💬 Details** is for clients. They are
  not the same thing.

---

## 2. Getting in

1. Open `https://admin.threepin.in/dashboard.html`.
2. Type your email and password. Tap **Login**.

The **same account** opens the Lead CRM at `/crm.html`. Account creation,
password resets and removals are in [`SOP.md`](SOP.md).

Everything you see is shared with the whole team in real time. There is no
view-only mode: anyone who can log in can edit or delete any property.

---

## 3. Where property data comes from — the one rule

**Every field has exactly one owner, and only its owner writes it.**

| Who owns it | Which fields |
|---|---|
| **Inventory master sheet** | All property *facts*: name, location, zone, type, config, status, possession, prices, areas, floors, facing, bathrooms, furnishing, vastu, approval, highlights, amenities, landmarks, connectivity, map pin, contact, availability, sheet notes |
| **You, in this dashboard** | *Working state*: Sold Out, Interest Level, "not required" markings, notes and events |
| **The brochure pipeline** | Brochure link, photos link, and the shareable WhatsApp details text |

Three consequences that explain almost every question people ask:

1. **The sheet is never written to automatically.** If you edit a price here,
   the sheet still has the old one until a person types it in. That is what the
   **🕒 Changes** list is for.
2. **A pending change here is protected from the sync.** While your edit sits
   un-ticked in Changes, a sheet sync will not overwrite that field. Ticking it
   off is the handover — from that moment the sheet governs that field again, so
   only tick it once the sheet really has the value.
3. **A property with no row in the sheet is never touched by the sync.**
   Manually added properties stay exactly as you left them.

An empty cell in the sheet means "nothing to say", not "clear it". To clear a
value, clear it here — which logs the change.

Full mechanics: [`PROPERTY-PIPELINE.md`](PROPERTY-PIPELINE.md).

---

## 4. The page, part by part

### Header

| Control | What it does |
|---|---|
| **Ready / Upcoming / Total** counters | Live counts across the whole catalogue |
| **🔄 Sync from Sheet** | Pulls the latest Inventory sheet data — always previews first |
| **⚠️ Missing Data** + badge | Properties with agent-facing fields still empty |
| **🕒 Changes** | The worklist of edits to carry into the sheet |
| **📋 Create Brochure** | New-listing intake form |
| **💬 Lead CRM** | Jumps to the CRM |
| **Logout** | |
| **☰** (phone only) | Reveals the buttons above |

### Search bar

One box, searches across property code, name, location, zone, builder,
configuration, amenities, highlights, type, sheet notes, the shareable details
text, furnishing and facing. Free-text facts are findable, not just structured
fields — searching `negotiable` or a seller's situation works if it is written
in the sheet notes.

### Filters and sort (the ⚙️ **Filters & Sort** bar on a phone)

- **Status:** All · ✓ Ready · ⏳ Upcoming
- **👁️ Hide Sold Out** — toggles to "✓ Only Active"
- **Type:** All Types, plus one button per property type actually present
- **★ Favorites** — show only your shortlist
- **Sort:** Recently Added (default) · Featured · Price Low→High · Price
  High→Low · Name A→Z · Oldest Added
- **+ Add Property**

Filters combine. The count line above the grid always reads "Showing X of Y".

---

## 5. Finding a property

| You want… | Do this |
|---|---|
| A specific building | Type its name or property code in search |
| Everything in an area | Search the locality or zone name |
| Ready-to-move only | Status filter → **✓ Ready** |
| Only what is actually sellable | **👁️ Hide Sold Out** |
| Under a budget | Sort **Price: Low → High** and read down |
| Just plots / just villas | Type filter |
| The ones you are working right now | **★ Favorites** |
| Newest additions | Sort **Recently Added** (the default) |

"Price on Request" always sorts to the bottom of a price sort — it is not a
price, it is a missing one, and **⚠️ Missing Data** counts it as such.

---

## 6. The property card

Each card shows, at a glance:

- **Property code and name**, and the location.
- **Status badge** — ✓ Ready to Move, or ⏳ with the possession date.
- **Configuration** badge.
- **Starting price**, and price per sqft if known.
- **Area** and **type**.
- **Builder**.
- **Resource chips** — 📑 Brochure · 🖼️ Photos · 📍 Map Pin · 💬 Details. Green
  means it is one tap away; dimmed means it is not on file yet. Check these
  *before* promising a client you will send something.
- **📞 Call** — dials the listed contact directly.
- **Compare** checkbox and the **★** / share icons.
- A **SOLD OUT** overlay if it has been marked so.

---

## 7. The detail panel and its four tabs

Tap a card to open it. The address bar changes to that property's own URL, so
whatever you are looking at is always the link worth pasting into chat. **Back**
returns you to the grid.

Header actions: **🔗 Share Link · ★ Save · 📋 Lead CRM · 🏷️ Mark Sold Out ·
🖨️ Print · ✏️ Edit · 🗑️ Delete.**

### Overview — *the call tab*

- **Key Facts** grid: configuration, area, possession, and whichever of floor,
  facing, bathrooms, furnishing, parking, total units, floors, vastu, age,
  approval and power backup are known.
- **📝 Notes (Inventory Sheet)** — the free-text notes cell from the sheet, line
  breaks intact. This is where pricing nuance, seller situation and per-typology
  breakdowns live. **Read this before a call.**
- **✨ Highlights** and **🏢 Amenities**.
- **📍 Location & Connectivity** — zone, a working Google Maps pin, nearby
  landmarks and connectivity notes.
- **💬 Shareable Details** — the exact WhatsApp text a client receives, with a
  copy button.
- **📋 From the Inventory Sheet** — every sheet column that has no dedicated
  field of its own, shown automatically. Add a column to the sheet and it
  appears here with no code change.
- **📤 Share & Export** — Share Link · Print · JSON · Brochure · Photos ·
  Details.

### Specifications — *the "client asked a specific question" tab*

One long table grouped into Identity, Location, Pricing & Status, Dimensions,
Building, and Resources & Contact. Everything stored is here, including super
built-up and carpet area, towers, corner unit, sale type and the owner/builder
contact when the sheet carries one.

### Sales Pitch — *the "I need words right now" tab*

An auto-written talking-points paragraph: what the property is, configurations
and area, price, possession and status, why-buy points from the highlights,
connectivity, and a closing line with the contact's name and number. Read it
verbatim or use it as a prompt.

### Notes & CRM — *the shared memory tab*

**Client Interest Level:** 🔥 Hot · 🌡️ Warm · ❄️ Cold. Tap to set, tap again to
clear. **This is shared with the whole team and saved on the property** — it is
how much interest *this property* is getting, not one client's rating.

**Notes & Events:** a chronological log everyone shares. Pick a kind, optionally
a date, type what happened, tap **Add**:

| Kind | Use it for |
|---|---|
| 📝 Note | Anything with no date — a fact you learned |
| 🏠 Site Visit | Visits done or scheduled |
| 📞 Client Call | A call about this property |
| 💰 Price Update | The builder or owner changed the price |
| 🔔 Status Change | Construction progress, approvals, availability |
| 🤝 Booking | A unit was booked |

Anything except a plain Note takes a date, so a back-dated site visit files
itself in the right place. Entries are newest-first, stamped with who added
them, and deletable with the **×**.

---

## 8. Sharing — three different buttons, three different jobs

This trips people up more than anything else in the app.

| Button | Produces | Send it to | Why |
|---|---|---|---|
| **🔗 Share Link** | A URL to this property's page on `admin.threepin.in` | **Colleagues only** | It requires a login. A client would just see a login screen |
| **💬 Details** | Plain WhatsApp text — the property's details, no link | **Clients** | Nothing to log into, nothing internal leaked |
| **📑 Brochure** | Downloads the PDF from Drive | Clients, as an attachment | Only works if a brochure is on file |

Also available: **🖼️ Photos** (opens the Drive photo folder), **🖨️ Print** (a
clean one-page print/PDF), and **📄 JSON** (the raw record, mainly for
duplicating a listing or handing to a developer).

On a phone, **Share Link** opens the OS share sheet so it goes straight into
WhatsApp. On a desktop it copies to the clipboard, because a share sheet is a
detour when the chat window is already open.

---

## 9. Working state — Sold Out, Interest Level, Favourites

| Marking | Shared with the team? | Survives a sheet sync? | What it is for |
|---|---|---|---|
| **🏷️ Sold Out** | Yes | Yes, always | Take a property out of circulation without deleting it |
| **Interest Level** | Yes | Yes, always | How hot this property is running |
| **★ Favourites** | **No — your browser only** | Yes | A personal shortlist for today's client |

**Sold Out** greys the card, stamps a SOLD OUT overlay and lets everyone filter
it away with **👁️ Hide Sold Out**. It is reversible — the button becomes
**✓ Marked Sold Out**; tap it again to reactivate. It is logged to Changes.

**Favourites are deliberately per-browser.** They are a personal shortlist, not
business data. Clearing site data or switching devices loses them; nothing else
does. If it matters to the team, it belongs in Notes & Events.

---

## 10. Notes and Events

Covered in [section 7](#notes--crm--the-shared-memory-tab). Two things worth
repeating:

- They are **shared and stored on the server**, so every teammate on every
  device sees the same log. (An older version kept them in one browser; those
  were migrated in automatically the first time each property was opened.)
- They are **not** the same as the Inventory sheet's notes column. Sheet notes
  are facts about the property maintained in the sheet; these are the running
  history of what your team did.

---

## 11. Adding and editing properties

### + Add Property

The form is grouped into **Basic Info · Pricing & Status · Specifications ·
Description · Contact**. Only **Property Name** and **Location** are required —
save a stub now and fill the rest in from ⚠️ Missing Data later.

Two shortcuts in add mode:

- **📄 Insert Template** — drops a blank JSON template with every field and an
  example value. Fill it in here or elsewhere, paste it back, then **⇩ Load JSON
  into form**.
- Pasting a property JSON from another source works too: the form maps common
  alternative field names (`propertyType`, `price`, `priceInCr`, `readyToMove`,
  `builtupArea`, …) onto the right fields for you.

**Use Add Property for:** a one-off listing that is not in the Inventory sheet.
Remember the sheet will not know about it, and a sync will never update it.

### ✏️ Edit

The same form, pre-filled. As you type, each changed field shows a live
**old → new** diff underneath it, and the field is highlighted — so you can see
exactly what you are about to change before saving. **↺ Discard changes** puts
everything back.

On save, every changed field becomes a row in **🕒 Changes**.

### 🗑️ Delete

Asks for confirmation, then removes the property from the dashboard. **The full
record is preserved as a snapshot in the change log**, so a delete is
recoverable by a developer — unlike a deleted CRM lead. A pending delete also
stops the sync from recreating the property from the sheet until it is ticked
off (or the sheet row is removed).

---

## 12. 🔄 Sync from Sheet

Pulls the latest Inventory master sheet data into the dashboard, on demand.
(The Mac scheduler also runs this automatically every 30 minutes.)

**It always previews first.** Tapping the button runs a dry run and shows you:

- how many properties would be **added**, **updated**, **already current**, and
  **not in the sheet — untouched**;
- the exact field-by-field before → after for each change;
- a **🛡 Your dashboard edits are kept** block listing every field the sync will
  *not* touch because it is still pending in 🕒 Changes.

Nothing is written until you tap **✓ Apply to dashboard**. The grid updates
itself the moment it does.

**What a sync can never do:** un-sell a property, clear an interest level, touch
a property that has no sheet row, or overwrite a pending edit of yours.

**Use it when:** someone has just updated the sheet and you want it now rather
than waiting for the next scheduled run.

---

## 13. 🕒 Changes — the reconciliation worklist

Every edit made in this dashboard, recorded with property, field, old value, new
value, time and who did it — grouped by day, newest first.

**This list exists because nothing writes back to the Inventory sheet.** It is
the bridge between the two.

**The loop:**

1. Filter to **Pending** (the default).
2. Make the same change in the Inventory sheet.
3. **Tick it off.** That hands the field back to the sheet — from then on the
   sync governs it again.

Also here: **Applied** and **All** filters, a search box across property, field,
value and person, and **📥 Export CSV**, which exports exactly what is on screen.
Filtering to Pending and exporting gives you precisely the list of edits still
to be made in the sheet — handy for whoever maintains it.

**Do not tick an edit off before the sheet actually has the value.** Ticking is
what removes the protection; do it early and the next sync overwrites your edit
with the sheet's stale value.

Nothing in this log is ever deleted — it is append-only, and it holds the only
surviving copy of a deleted property.

---

## 14. ⚠️ Missing Data

Every property listed with the agent-facing fields it still lacks, worst first,
with a "X/30 filled" progress marker. The header badge counts how many
properties have gaps.

The 30 fields it checks are grouped as **Core** (configuration, area, price,
rate/sqft, possession, availability), **Specs** (land area, UDS, units, floors,
floor no, facing, bathrooms, parking, furnishing, vastu, power backup, approval,
age), **Location** (zone, map pin, landmark, connectivity), **Marketing**
(highlights, amenities, photos link, brochure, share details) and **Contact**.

Placeholder values count as missing — "Price on Request" and "Contact for
details" usually mean nobody entered it, and you should know that before the
client asks.

**Two ways to clear a gap:**

- **Fill it in place** — tap the field chip, type the value, **✓ Save**. It
  saves to the property *and* lands in 🕒 Changes for the sheet.
- **Mark it "Not required"** — for fields that genuinely do not apply. A plot
  has no floor number. That field stops being counted for that property only.

**Use it when:** preparing for a client call, before a listing goes out, or as a
15-minute weekly tidy-up.

---

## 15. 📋 Create Brochure

The new-listing intake form. Fill in:

- **Property ID & Title** — e.g. `NOL002 - 3BHK in Velachery`
- **Google Drive Photo Folder Link**
- **Property Details** *(required)* — paste the full description: title, specs,
  highlights, price, nearby landmarks

Tap **✓ Submit**. It goes into the intake queue; the automation builds the
brochure PDF, uploads it to Drive, emails it, writes the link back into the
Inventory sheet, and the property appears in the dashboard — **within about 30
minutes**.

**Use it when:** a genuinely new listing comes in and you want it documented and
sellable without touching a spreadsheet. For a quick internal placeholder that
needs no brochure, **+ Add Property** is faster.

The submission is fire-and-forget — the confirmation means "sent", not "built".
If nothing appears after ~30 minutes, see
[`PROPERTY-PIPELINE.md`](PROPERTY-PIPELINE.md).

---

## 16. Compare and export

Tick **Compare** on two or more cards. A toolbar appears at the bottom:

- **📊 Compare** — a side-by-side table of starting price, price/sqft,
  configuration, area, status, possession, builder, location, total units and
  vastu. Ideal for a client choosing between shortlisted options.
- **📥 Export CSV** — name, builder, location, type, config, prices, area,
  status and possession for the selected properties. Good for a spreadsheet or
  an email.
- **Clear** — drops the selection.

Single-property exports (JSON, Print) live in the detail panel's **Share &
Export** block.

---

## 17. The shared property page

Every property has its own URL (`property.html?id=…`), which is what **🔗 Share
Link** copies. Opening it shows the same detail view as the panel — the same
code renders both, so a shared link can never drift from what you see.

It still requires a login, so it is for **colleagues, not clients**. It is
marked no-index so it will not turn up in search engines, and a property you
have opened before paints instantly from a local cache while the live data
loads.

---

## 18. Daily and weekly routine

**Before a client call**

1. Search the property, open it.
2. Read **📝 Notes (Inventory Sheet)** on the Overview tab — that is where the
   nuance is.
3. Check the **resource chips**: is the brochure actually on file?
4. Skim **Notes & Events** so you do not repeat a colleague's conversation.
5. Keep **Specifications** open for the detail questions.

**After the call**

- Log what happened in **Notes & Events**.
- Update the **Interest Level** if it moved.
- Create the lead in the [CRM](CRM.md) if there is one.

**When something changes about a property**

- Edit it here, then carry the change into the Inventory sheet and tick it off
  in **🕒 Changes**.

**Weekly**

- **⚠️ Missing Data** — fill the worst offenders.
- **🕒 Changes → Pending** — clear the backlog into the sheet.
- **🔄 Sync from Sheet** — confirm the dashboard matches the sheet.
- Mark anything sold as **Sold Out**.

---

## 19. Field reference

Fields the edit form exposes, by group:

- **Basic Info:** Property Code, Property Name\*, Builder, Location\*, Type,
  Configuration
- **Pricing & Status:** Status (Under Construction / Ready to Move), Possession,
  Starting Price, Price/Sqft, Availability
- **Specifications:** Total Units, Sqft Range, Total Land Area, UDS, Total
  Floors, Parking, Parking Type, Vastu
- **Description:** Highlights (comma-separated), Amenities (comma-separated),
  Nearby, Nearby Landmark, Connectivity
- **Contact:** Contact Name, Contact Number

\* required.

Additional fields displayed but maintained by the sheet or the pipeline: zone,
sale type, construction stage, floor no, facing, bathrooms, furnishing, corner
unit, power backup, approval, property age, super built-up area, carpet area,
total towers, map link, photos link, brochure link, shareable details text,
sheet notes, and anything else in the sheet, which appears under **From the
Inventory Sheet**.

Working-state fields: Sold Out, Interest Level, "not required" markings, and the
notes/events log.

---

## 20. FAQ

**I edited a price here — is the sheet updated?**
No. Nothing writes back to the sheet. Your edit shows in the dashboard
immediately, and it is listed in **🕒 Changes** so someone can type it into the
sheet and tick it off.

**Will a sync overwrite my edit?**
Not while it is still pending in Changes — that field is protected. Once you
tick it off, the sheet governs it again. So tick only after the sheet really has
your value.

**I marked something Sold Out. Can a sync un-sell it?**
No. Sold Out and Interest Level are yours; no sync ever touches them.

**Why do only I see my favourites?**
They are per-browser by design — a personal shortlist, not team data. Use Notes
& Events for anything the team should see.

**Can I send a client the Share Link?**
No. It needs a login; they would see a login screen. Use **💬 Details** for
clients.

**A property says "Price on Request" — is that the real price?**
Usually it means nobody entered one. **⚠️ Missing Data** treats it as a gap for
exactly that reason.

**I added a property manually and the sheet does not have it.**
Correct, and a sync will never update it. Add the row to the sheet if it should
be maintained there.

**I deleted a property by mistake.**
The full record is preserved as a snapshot in the append-only change log. A
developer can restore it — see [`PROPERTY-PIPELINE.md`](PROPERTY-PIPELINE.md).

**Someone added a column to the Inventory sheet. Do we need a code change?**
No. Unmapped columns appear automatically under **From the Inventory Sheet** on
the Overview tab.

**What does 📋 Lead CRM on a property do?**
It opens the CRM. The intended pre-fill of the property onto a new lead is not
wired up yet, so pick the property yourself in the Add Lead form.

**How long until a submitted brochure shows up?**
About 30 minutes — the scheduler runs on that cycle.

---

## 21. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Login rejected | Wrong password, or the account is disabled | [`SOP.md`](SOP.md) |
| Logged in, grid empty | Account has no tenant claim | Developer: re-run the add-team-member script |
| "Save failed — check your connection" | The write did not reach the server | The change is rolled back on screen; reconnect and redo it |
| Sync says "You appear to be signed out" | Session expired | Reload and log in again |
| Sync errors on the sheet | Sheet not shared with the service account, or a renamed tab | [`PROPERTY-PIPELINE.md`](PROPERTY-PIPELINE.md) |
| Brochure button says nothing is uploaded | No brochure PDF on file | Use 📋 Create Brochure, or check the pipeline |
| A sheet update is not visible | The scheduled sync has not run yet | **🔄 Sync from Sheet** and apply |
| Your edit reverted after a sync | The change was ticked off in 🕒 Changes before the sheet had it | Re-apply the edit here and update the sheet before ticking |
| Copy does nothing | Clipboard blocked | Select the text in the box and copy manually |

---

## 22. Known limits

- **No roles or permissions.** Everyone can edit and delete every property.
- **The sheet is never updated automatically.** Reconciliation via 🕒 Changes is
  manual and deliberate.
- **Favourites are per-browser** and are lost if site data is cleared.
- **Photos and brochures live in Google Drive**, not here — a Drive permission
  change breaks those buttons.
- **The 📋 Lead CRM button does not pre-fill the lead** yet.
- **Property pages require a login**, so links cannot be sent to clients.
