# Lead CRM — Complete Guide

**URL:** `https://admin.threepin.in/crm.html`
**Who it's for:** every agent and the owner. One login each.
**What it does:** tracks every buyer/seller enquiry from first contact to
closed, with follow-ups that chase you instead of the other way round.

> Companion guides: [`DASHBOARD.md`](DASHBOARD.md) (property listings),
> [`SOP.md`](SOP.md) (access, ops, incidents),
> [`PROPERTY-PIPELINE.md`](PROPERTY-PIPELINE.md) (how property data flows).
> Verified against the live code on **27 Aug 2026**.

---

## Contents

1. [The 60-second version](#1-the-60-second-version)
2. [Getting in](#2-getting-in)
3. [The page, part by part](#3-the-page-part-by-part)
4. [The four views — and when to use each](#4-the-four-views--and-when-to-use-each)
5. [Leads — the full lifecycle](#5-leads--the-full-lifecycle)
6. [Follow-ups — the engine of the CRM](#6-follow-ups--the-engine-of-the-crm)
7. [Notes, history and the AI summary](#7-notes-history-and-the-ai-summary)
8. [Analytics — reading the numbers](#8-analytics--reading-the-numbers)
9. [Settings in the ⋮ menu](#9-settings-in-the--menu)
10. [Export](#10-export)
11. [Automatic emails and digests](#11-automatic-emails-and-digests)
12. [The AI Bot panel (currently off)](#12-the-ai-bot-panel-currently-off)
13. [Daily and weekly routine](#13-daily-and-weekly-routine)
14. [Field reference](#14-field-reference)
15. [FAQ](#15-faq)
16. [Troubleshooting](#16-troubleshooting)
17. [Known limits](#17-known-limits)

---

## 1. The 60-second version

- A **lead** is one enquiry. It has a **stage** (where it sits in the pipeline)
  and optionally a **next follow-up date/time**.
- You add leads with **+ Add Lead**. You move them by dragging the card on the
  **Board**, or with the dropdown inside the lead.
- The **Follow-ups** tab is your day. Work it top-down until it is empty.
- Every change is logged automatically — who, what, when. Nothing is silent.
- **Analytics** turns all of that into numbers: what came in, what is stuck,
  what closed, what is going cold.

Everything saves to the cloud instantly and appears on every teammate's screen
in real time. There is no "save the file" step and no local copy.

---

## 2. Getting in

1. Open `https://admin.threepin.in/crm.html`.
2. Type your email and password. Tap **Login**.

The **same account** opens the Property Dashboard at `/dashboard.html` — one
login, two apps. Getting an account, resetting a password, and removing access
are all covered in [`SOP.md`](SOP.md).

**What you can see:** everything your business has. Leads are shared across the
whole team — there is no private lead and no view-only mode. Whoever is logged
in can edit or delete anything. Your email is stamped on every change you make,
which is the only accountability layer that exists today.

**Staying logged in:** the session persists in the browser. Use **⋮ → Logout**
on a shared device.

---

## 3. The page, part by part

### Header (top bar)

| Control | What it does | Use it when |
|---|---|---|
| **← Property Intelligence** | Jumps to the property Dashboard | You need listing facts mid-call |
| **Follow-ups** + red badge | Opens the Follow-ups view. The badge counts **overdue + due today** | First thing every morning |
| **Analytics** | Opens the metrics view | Reviewing the day, week or month |
| **Board / List** dropdown | Switches between the two browse views | See [section 4](#4-the-four-views--and-when-to-use-each) |
| **+ Add Lead** | Opens the new-enquiry form | A call or message just came in |
| **Sun / moon toggle** | Light or dark theme | Personal preference, remembered per browser |
| **⋮ menu** | Everything else — settings, export, logout | See [section 9](#9-settings-in-the--menu) |
| **☰** (phone only) | Reveals the header buttons | On a narrow screen |

On a phone the round **+** button bottom-right is the fastest way to add a lead.

### Search bar

Live-filters as you type across **name, phone, email, property / locality,
enquiry type, budget and channel**. It applies to the Board, the List and the
Follow-ups view at the same time. The **×** clears it.

Search does *not* filter Analytics — those numbers are always the whole book.

### Lead detail panel

Tap any card or row to open it. This is where a lead actually gets worked:
stage, follow-up, notes, history, AI summary, and the WhatsApp and call buttons.

---

## 4. The four views — and when to use each

### Board (Kanban) — *default*

Columns are your pipeline stages; each lead is a card.

- **Drag a card** between columns to change its stage. The move is logged.
- Cards show name, channel, property interest, budget, a follow-up badge, a
  "details sent" chip, and time since the last update.
- **Use it for:** the visual state of the business. "How many are at Site
  Visit?" is a glance, not a query.

### List

A spreadsheet-style table: Name, Contact, Channel, Type, Interest, Stage,
Source, Follow-up, Updated, Updated By.

- **Click a column header** to sort by it; click again to reverse.
- **The filter icon on a column** opens an Excel-style checkbox list of the
  values present — tick the ones to keep. Filterable columns: Name, Channel,
  Type, Interest, Stage, Source, Updated By. Filters stack across columns.
- **Use it for:** anything that needs comparing or bulk-scanning — "show me
  every Rental Enquiry from Instagram that Ravi is carrying".

### Follow-ups

Every lead that has a follow-up date, grouped into five buckets:

| Bucket | Meaning |
|---|---|
| ⚠️ **Overdue** | The time has passed and you have not logged the follow-up |
| 📅 **Today** | Due before midnight tonight |
| 🌤️ **Tomorrow** | Due tomorrow |
| 🗓️ **This Week** | Due in the next 7 days |
| 📆 **Later** | Everything further out |

Leads with **no** follow-up date never appear here — which is exactly why the
Analytics "no follow-up date" hygiene count matters.

- **Use it for:** your working day. Start at the top; stop when Overdue and
  Today are empty.

### Analytics

The full metrics view — see [section 8](#8-analytics--reading-the-numbers).

---

## 5. Leads — the full lifecycle

### Adding a lead

**+ Add Lead** (or the mobile **+**). Required fields are marked `*`:

| Field | Required | Notes |
|---|---|---|
| **Channel** | yes | Direct Call / WhatsApp / Instagram — *how they reached you* |
| **Stage** | no | Defaults to your first stage |
| **Name** | yes | |
| **Phone** | yes | Drives the WhatsApp button and duplicate detection |
| **Email** | no | |
| **Enquiry Type** | yes | Property Enquiry / Seller Listing / General, or add your own |
| **Property / Locality** | yes | Becomes a searchable dropdown when the type is *Property Enquiry* |
| **Budget** | no | Free text: `1.5 Cr`, `85 L`, `3 to 4 Cr` all parse |
| **Sent details?** | no | Yes/No — feeds the "Details shared" journey step |
| **Follow-up date / time** | no | Must be in the future |
| **Notes** | no | Saved as the first note, stamped with today's date and your name |

Tap **✓ Save Enquiry**. A green toast confirms.

**The property dropdown.** When Enquiry Type is *Property Enquiry*, the Property
field becomes a searchable combo box listing every property already used on a
lead, plus any you have added by hand. Type a new name and pick **"+ Add …"** to
register it — it is selectable from then on. That is what keeps the
property-wise analytics from fragmenting across three spellings of the same
building.

**Adding an enquiry type on the fly.** Pick **+ Add new type…** in the Enquiry
Type dropdown, type it, tap **+ Add**. It is saved for everyone.

### The duplicate check

If the phone number already exists on another lead, saving does **not** create a
second one. A comparison dialog opens showing exactly which fields differ:

- **Cancel** — abandon what you typed.
- **👁 Open Lead** — go and look at the existing one first.
- **↻ Update with new details** — merge your entry into the existing lead.

The merge is a *patch*, not a replace: fields you left at their defaults (first
stage, Sent Details = No, blank budget, no follow-up) defer to whatever the
existing lead already has. Only values you actually changed win. So merging a
fresh enquiry into a lead already at Negotiation will not drag it back to New or
delete its scheduled follow-up.

### Editing

Open the lead → **✏️ Edit**. Every changed field is written into the lead's
history as a line such as *"Budget changed from 1 Cr to 1.5 Cr"*. Anything typed
into the Notes box is added as a new dated note.

### Moving between stages

Three equivalent ways — all logged identically:

1. **Drag the card** on the Board.
2. **Stage dropdown** at the top of the lead detail panel.
3. **Edit modal → Stage.**

### Deleting

Open the lead → **🗑️ Delete** → confirm. **This is permanent.** There is no undo
and no recycle bin for leads (unlike the Dashboard's property change log). If
you might want it back, move it to a *Not Interested* or *Spam* stage instead —
that also keeps it out of the Analytics conversion maths.

### Where leads come from

The **Source** column distinguishes:

- **✍️ Manual** — typed in by an agent. Today, effectively everything.
- **📱 Meta** — Facebook/Instagram Lead Ads. Such leads carry a raw-fields block
  shown under *"show / hide raw fields"* in the detail panel. **The Lead Ads
  webhook is not deployed right now**, so nothing new arrives this way.
- **🤖 WhatsApp Bot** — the AI bot. **Currently off**, see
  [section 12](#12-the-ai-bot-panel-currently-off).

---

## 6. Follow-ups — the engine of the CRM

A follow-up is a date **and optionally a time** attached to a lead. Set one and
the lead starts appearing in the Follow-ups view, the header badge, the daily
digest and the Analytics overdue count.

### Setting one

- On **Add / Edit Lead** — the Follow-up date and time fields.
- In the open lead — the date/time fields under the notes box.
- Via **✓ Followed Up**, which is the one you should use most.

A follow-up date in the past is rejected. If you mean "later today", set a time.

### Logging a follow-up — the ✓ Followed Up flow

This is the core loop. Open the lead → **✓ Followed Up**. The dialog asks:

1. **What happened?** (optional) — becomes a dated note *and* a history entry.
2. **When next?** — quick presets **Tomorrow · +3 days · +1 week · +2 weeks · No
   follow-up**, or a specific date and time.

Saving does four things at once: logs the note, records "followed up" in the
history, sets or clears the next follow-up, and stamps the lead as touched today
so it counts in *Followed Up Today* and drops out of *Cold Leads*.

**Use "No follow-up"** when the lead is finished — closed, dead, or genuinely
waiting on nothing. That is cleaner than leaving a stale date behind.

### Removing one

**✕ Remove** next to the follow-up fields. Logged as "Follow-up removed".

### Browser alerts

**⋮ → 🔕 Browser Alerts** turns on a native desktop notification about overdue
and due-today follow-ups, at most once an hour while the tab is open. It is a
**per-device** preference, not shared with the team.

Some mobile browsers (Chrome on Android in particular) report permission as
granted but cannot actually show one. The CRM detects that, falls back to an
in-app toast and switches the preference back off. On a phone, rely on the
Follow-ups tab and the daily digest instead.

---

## 7. Notes, history and the AI summary

### Notes — what *you* write

Free text, one line at a time, in the lead detail panel. Each is stamped with
the date, time and your name. Notes are the conversation record: budget
revealed, objection raised, what the client actually said.

The most recent note is shown on the lead's card, so the board reads as a status
board rather than a list of names.

### History — what the *system* writes

Automatic and read-only. Every stage move, field edit, follow-up set / changed /
removed, and "followed up" event, in order, with who did it. You cannot edit or
delete history. When two people disagree about what happened to a lead, this is
the answer.

### AI summary

A short Claude-generated paragraph at the top of the lead — the situation in
plain language, built from the lead's fields and notes.

- **Generated on demand only.** Tap **🔄 Regenerate** in the summary box. It does
  not run automatically on every save (that used to burn API calls on every drag
  and every note).
- It arrives back on its own a few seconds later; the panel updates itself.
- Model: `claude-haiku-4-5-20251001`.
- **⋮ → ✨ Backfill AI Summaries** generates one for every lead that does not
  have one yet, in batches, with a running progress toast. Safe to re-run — it
  skips leads that already have a summary. It does cost one API call per lead,
  so treat it as occasional housekeeping, not a daily action.

**Use it for:** picking a cold lead back up after two weeks without reading
fifteen notes, and for handing a lead to a colleague.

---

## 8. Analytics — reading the numbers

The **Analytics** tab computes everything live from your leads. The date picker
at the top sets which day counts as "today" — leave it alone for the live view,
or set it back a few days to reconstruct what a past day looked like.

### Top row — today's eight numbers

**New Today · Followed Up · Overdue · Cold Leads · Pending Site Visit · Site
Visits Today · Missed Calls · Closed Today.** Each is clickable and expands into
the actual list of leads behind it.

### Portfolio KPIs (all-time, spam excluded)

Total leads · Open pipeline value · Conversion % · Site-visit rate · Details
shared % · Overdue % · New per day (14-day average) · New this month.

Pipeline value comes from parsing the free-text Budget field — `1.5 Cr`,
`85 Lakhs`, `3 to 4 Cr` (a range is averaged). Anything unparseable is left out
of the sum rather than counted as zero, and Rental Enquiry budgets are never
mixed into sale value.

### Charts and tables

| Card | What it tells you |
|---|---|
| **New Leads — Last 14 Days** | Daily intake trend; toggle chart and table |
| **Lead Journey** | Total → Details shared → Site visit done → Closed, with carry-through % at each step |
| **New Leads by Month** | Last 6 months |
| **Leads by Channel / by Source** | Where enquiries come from |
| **Budget Distribution** | Bands, plus a "Not specified" bucket |
| **Pipeline by Stage** | Current spread across your stages |
| **Open Leads by Owner** | Who is carrying the book |

### Expandable sections

Property-wise Leads Today · Property Performance (all-time) · Other Enquiries
Today · Enquiry Type Performance · Followed Up Today · Overdue Follow-ups ·
Today's Action Log · Stage Changes Today · Pending Site Visit · Site Visits Done
· Missed Calls · Moved to Closed Today · Moved to Not Interested/Spam Today ·
New Today No Action Yet · New Leads Today · Tomorrow's Follow-up Plan · Cold
Leads (7+ days silent) · Owner Activity Detail · **Data Hygiene**.

**Property Performance** is the one worth a weekly look: every property that has
had a Property Enquiry, with total demand, open leads, site visits, closed
deals, conversion % and pipeline value. It is how you tell a property that
generates calls from one that generates deals.

**Data Hygiene** lists leads missing a phone, missing a budget, with no
follow-up date, with no AI summary, and any duplicate phone numbers that slipped
through. Work that list down and every other number gets more honest.

### The stage-name rule — read this once

Analytics classifies stages by their **name**, not by their position:

| Counted as | The stage must be named (case and spacing ignored) |
|---|---|
| Closed / won | `Closed` |
| Dead | `Not Interested`, `Spam` |
| Site visit done | `Site Visit Done` |
| Site visit pending | `Site Visit` |
| Missed calls | `Missed Calls` |

Anything else is treated as an **open** lead. The default seeded pipeline ships
with `Closed Won` and `Closed Lost`, which do **not** match — so if your board
still uses those names, Conversion reads 0%. Rename the stage to exactly
**Closed** in **⋮ → Manage Stages** and every closed-deal number starts working.
Spam is excluded from almost every total; "Not Interested" leads still count
towards a property's demand.

---

## 9. Settings in the ⋮ menu

| Item | What it does |
|---|---|
| **Browser Alerts** | Per-device follow-up notifications |
| **Compact / Comfortable rows** | Row density; remembered per browser |
| **⚙️ Manage Stages** | Rename, recolour, reorder, add and delete pipeline stages |
| **🔔 Follow-up Digest** | Daily WhatsApp and email digest settings |
| **📊 Dashboard Summary Email** | Daily analytics email settings |
| **🤖 AI Bot** | The bot editor panel (currently inactive) |
| **⬇️ Export Leads** | Excel export |
| **✨ Backfill AI Summaries** | Bulk-generate missing summaries |
| **Logout** | |

### Manage Stages

Rename in place, tap the colour swatch to cycle its colour, use the arrows to
reorder (this is the Board's column order), **+ Add** for a new one, **✕** to
delete.

**Deleting a stage moves every lead in it to your first stage.** You are warned
and asked to confirm. You must keep at least one stage. Renaming a stage keeps
all its leads — nothing is lost — but remember the name rule in
[section 8](#the-stage-name-rule--read-this-once).

---

## 10. Export

**⋮ → ⬇️ Export Leads** produces an `.xlsx` file. Choose a scope:

| Scope | Contents |
|---|---|
| **All Leads** | Everything in the CRM |
| **Created Today** | Added today |
| **Has Movement Today** | Any change today — stage, note, follow-up, edit |
| **Date Range** | Created between two dates |

The count updates live before you commit. Each row carries name, phone, email,
channel, enquiry type, property, budget, stage, source, sent-details, time of
contact, follow-up, added and updated timestamps with by-whom, note count, and
the **full note history** in one cell.

**Use it for:** sharing with someone who has no login, month-end reporting, and
as an occasional offline snapshot of the book.

---

## 11. Automatic emails and digests

### Follow-up digest — *what to do today*

**⋮ → 🔔 Follow-up Digest.** Sends at **09:00 IST daily** (03:30 UTC cron).

- **WhatsApp** — tick *enabled* and add recipient numbers (bare 10-digit numbers
  are treated as +91). **Requires a connected WhatsApp Business number**, which
  is not connected today — see [section 12](#12-the-ai-bot-panel-currently-off).
- **Email** — tick *enabled* and add addresses. This path works today.
- **📤 Send Digest Now** — fires it immediately, for testing.

Contents: overdue follow-ups, then one section each for today, tomorrow and the
day after. The send is idempotent per day, so a retry cannot double-send.

### Dashboard summary email — *how the business is doing*

**⋮ → 📊 Dashboard Summary Email.** Sends at **21:30 IST daily** (16:00 UTC).
Same recipient mechanics, plus **📤 Send Now**. On first open it pre-fills from
your digest email list; after the first save the two lists are independent.

The email is built from the *same* metrics code as the Analytics tab, so the two
can never disagree.

---

## 12. The AI Bot panel (currently off)

**⋮ → 🤖 AI Bot** opens a full editor: a workflow canvas, a WhatsApp connection
card, a knowledge base (Google Sheet/Doc links, PDF/TXT upload, pasted text),
persona settings (role, welcome message, required info, conversation steps,
guardrails, tone) and a live test chat.

**Its current state, honestly:**

- **Bot replies are switched off in code.** The test chat returns a fixed
  "turned off" message; no live WhatsApp bot is answering anyone.
- **"Connect WhatsApp via Meta" does not work.** The endpoint it calls
  (`/api/whatsapp-embedded-signup`) is not deployed, so the popup fails. No
  WhatsApp number is connected to this tenant.
- **Knowledge base editing does work** — sources save and sync. They simply have
  no bot consuming them yet.

**What this means day to day:** the digest cannot send over WhatsApp (use the
email digest), and no leads arrive from a bot. Everything else in the CRM is
unaffected. Re-enabling is a developer task — see [`SOP.md`](SOP.md).

---

## 13. Daily and weekly routine

**Morning (10 minutes)**

1. Open **Follow-ups**. Clear ⚠️ Overdue first, then 📅 Today.
2. For each: call or message → **✓ Followed Up** → note what happened → set the
   next date.
3. Check **Analytics → New Today, No Action Yet** and give each one a first
   touch.

**During the day**

- Every new enquiry goes in **immediately** via **+ Add Lead** — a lead in your
  head is a lead that does not exist.
- Move cards on the Board as things progress.
- Log a note after every meaningful conversation.

**End of day**

- Follow-ups: Overdue and Today empty.
- Glance at **Tomorrow's Follow-up Plan** so tomorrow is not a surprise.

**Weekly**

- **Analytics → Cold Leads (7+ days silent)** — revive them or close them out.
- **Analytics → Data Hygiene** — fill missing phones and budgets, merge
  duplicates.
- **Property Performance** — which properties are actually converting.
- Export a snapshot if you want an offline copy.

---

## 14. Field reference

| Field | Type | Feeds |
|---|---|---|
| `name` | text, required | Cards, search, export |
| `phone` | text, required | WhatsApp and call buttons, duplicate detection, hygiene |
| `email` | text | Export, hygiene |
| `channel` | Direct Call / WhatsApp / Instagram | Channel mix chart |
| `enquiryType` | list, extendable | Enquiry-type performance; *Property Enquiry* switches on the property picker |
| `propertyInterest` | text or picker, required | Property-wise analytics |
| `budget` | free text | Pipeline value, budget distribution |
| `stageId` | pipeline stage | Board columns, and all won/dead/site-visit classification |
| `detailsSent` | Yes / No | "Details shared" journey step and KPI |
| `followUpAt` | date + time | Follow-ups view, badge, digest, overdue KPI |
| `source` | manual / meta / whatsapp_bot | Source mix |
| `notes[]` | dated entries | Card preview, AI summary, export |
| `history[]` | automatic | Audit trail |
| `aiSummary` | generated | Detail panel |
| `createdBy` / `updatedBy` | your email | Owner activity, accountability |

---

## 15. FAQ

**Do other people see my leads?**
Yes. Every lead is shared with the whole team, in real time. Your name is
stamped on what you add and change.

**Can I make a lead private, or give someone view-only access?**
No. There is one access level. Anyone who can log in can edit or delete
anything.

**I added the same person twice — what now?**
By phone number you cannot: the CRM catches it and offers to merge. If two
entries exist with *different* numbers, copy the useful notes across and delete
the spare. **Analytics → Data Hygiene → duplicate phones** finds ones that
slipped through.

**I deleted a lead by mistake.**
It is gone — leads have no recycle bin. Ask your developer whether a Firestore
backup covers that window ([`SOP.md`](SOP.md)). Prefer a *Not Interested* or
*Spam* stage over deleting.

**Why is my Conversion 0% when we have closed deals?**
Your won stage is not named exactly `Closed`. See
[the stage-name rule](#the-stage-name-rule--read-this-once).

**Why is a lead not in the Follow-ups tab?**
It has no follow-up date. Only dated leads appear there.

**Why did the WhatsApp digest not arrive?**
No WhatsApp number is connected — see
[section 12](#12-the-ai-bot-panel-currently-off). Turn on the **email** digest
instead.

**Does search affect the numbers in Analytics?**
No. Analytics always uses the whole book.

**Can I undo a stage move?**
Just move it back — both moves stay in the history.

**What happens to a lead's history if I rename its stage?**
Nothing is lost. Old history entries keep the old stage name, which is correct —
that is what it was called at the time.

**Is the AI summary automatic?**
No, on demand only. Tap **🔄 Regenerate**, or bulk-fill via **⋮ → ✨ Backfill**.

**Can a client see any of this?**
No. Every page requires a login.

**What does the 📋 Lead CRM button on a Dashboard property do?**
It opens the CRM. It is *meant* to pre-fill a lead for that property, but the
pre-fill is not wired up yet — you will still pick the property yourself in the
Add Lead form.

---

## 16. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Login rejected | Wrong password, or the account is disabled | [`SOP.md`](SOP.md) → password reset |
| Logged in, board empty | Account has no tenant claim (half-provisioned) | Developer: re-run the add-team-member script |
| A change did not stick | Connection dropped mid-save | Reload; the CRM shows live server state, so what you see after a reload is the truth |
| "Export library failed to load" | The CDN script was blocked | Check the connection, disable blockers, retry |
| Browser alerts do not fire | The mobile browser cannot show them | Use the Follow-ups tab and the email digest |
| Board blank on a phone after an error | Rendering aborted mid-refresh | Reload the page; report it if it repeats |
| Summary fails | API key or quota | Developer: check `ANTHROPIC_API_KEY` in Vercel |
| Digest never arrives | Cron, mail credentials, or WhatsApp not connected | **📤 Send Now** to see the real error |

Whole site down, nobody can log in, or data is not saving for anyone → see
[`SOP.md`](SOP.md).

---

## 17. Known limits

- **No roles or permissions.** Everyone has full edit and delete rights.
- **No lead assignment.** "Owner" in Analytics means *whoever last touched it*,
  derived from `updatedBy` — not a deliberate assignment.
- **Deleting a lead is permanent.** No recycle bin, unlike Dashboard properties.
- **The AI bot and the WhatsApp connection are not operational.**
- **Lead Ads intake is not deployed** — the Meta source exists in the data model
  but nothing feeds it.
- **Analytics classifies stages by exact name**, so renaming a stage can
  silently change your metrics.
- **No in-app user management.** Adding and removing people is a script or
  console task for a developer.
