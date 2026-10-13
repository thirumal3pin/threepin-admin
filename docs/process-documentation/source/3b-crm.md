## 3B · CRM — leads, follow-ups, site visits and calendar

**Console:** `crm.html`. **Main collections:** `leads` (+ `notes`, `history`, `tailortalk/state`, `aiRuns`), `pipelines/{tenant}`, `settings/{tenant}`, `leadViews`.

The CRM holds every enquiry — buyers and tenants looking for a property, owners who want to sell or rent out (the source of new listings), and vendors or collaborators kept apart. It does four jobs: run the **pipeline**, drive **daily execution** (follow-ups, site visits, mentions), turn **chats into leads** automatically, and **report** on all of it.

### Screens

| Screen | Where | What it is for |
| --- | --- | --- |
| Board | CRM → Board | One column per stage; drag, Alt+←/→ or "→ next" to move; days-in-stage chip turns amber then red |
| List | CRM → List | Excel-style table, 14 columns, column filters, bulk Move / Set follow-up / Clear follow-up |
| Follow-ups | CRM → Follow-ups | "Needs a person" queue (Do now / Today / This week) and the follow-up calendar (Overdue → Later) |
| Analytics | CRM → Analytics | Stat cards, trends, funnel by milestone, pipeline by stage, owner load, today's drill-downs, data hygiene |
| Daily task | Rail → Daily task | "Your day": site visits, meetings, calls due, @mentions asked of you, voice-overs to make |
| Team calendar | Rail → Team calendar | Everyone's day side by side, Find a time, New meeting, answer invitations. A repeating meeting is listed as single occurrences: the edit form says "Repeats — this change is for this one only", and one occurrence may be dragged to a new time (the series as a whole may not) |
| Lead panel | Click a lead | Everything about one lead (see below) |
| Alerts bell | Header | Unanswered invitations, today's items, leads that need a person |

**Lead panel, top to bottom:** AI summary · Stage and Sent Details · Lead agent and Secondary · Site visit · Log a note (with @mentions and next follow-up) · Where this lead stands (milestones, next step, attention reasons, AI suggestion / AI moved with Undo) · Follow-up spotlight · Lead info (incl. linked Properties, each opening the dashboard, and on a seller the **Listing** row, which opens the property's card on the Shoot & Media board — or "Track this listing" when it has none yet) · Properties for this buyer / Buyers waiting (matching) · TailorTalk section (status, Overview, Conversation) · Timeline.

**Navigation rules.** The search box and the filter chips act on a list of leads, so they are hidden on Daily task, Team calendar and Analytics (Analytics counts every lead). `crm.html?propertyId=…` — from a property's **Lead CRM** button — shows only the leads linked to that property, matched by its id or its code, as a "🏠 Leads for CODE" chip with a count. A lead or card panel owns one history entry while open: **Back** (phone or browser) closes the top dialog first, then the panel, never the page; a lead opened from a link (`?lead=`) is not reopened once closed.

### The pipeline

| # | Stage | Meaning (rule shown under the column) | Target days |
| --- | --- | --- | --- |
| 0 | New | Nothing specific sent yet | 2 |
| 1 | Options sent | Sent a property, details or location; they are weighing it up | 7 |
| 2 | Send more details | They asked for something we have not sent yet | 2 |
| 3 | Visit planned | Visit asked for or agreed, not done yet | 5 |
| 4 | Visited | They have seen the property | 4 |
| 5 | Negotiating | Talking price, token or documents | 14 |
| 6 | Won | Token paid, signed or rented — **only a person sets this** | – |
| side | Sourcing | We know what they want and have nothing to show yet | 3 |
| side | On hold | Interested, but paused — reason + optional revisit date | – |
| side | Lost | Stopped — reason required | – |

**Lost reasons:** not interested, bought elsewhere, budget, no match, unreachable, spam, not a fit, other. **Hold reasons:** postponed, budget, other.

Every move records who moved it and when, and the first date each milestone was reached (`reached`) — this powers the funnel. Moving to Lost or Won clears the follow-up; a hold with a revisit date turns that date into the follow-up.

### Process 1 — A lead arrives

| Source | How | What happens |
| --- | --- | --- |
| **TailorTalk** (WhatsApp, Instagram, website chat) — the main source | Webhook on every message, plus safety-net pulls (nightly 04:30 IST, every 5 min while the CRM is open — a pull that runs out of time resumes where it stopped — and the Sync TailorTalk button) | The lead is found by TailorTalk id, then by phone (`phoneKey` = 91XXXXXXXXXX), or created; the full conversation is mirrored; name, interest, budget and enquiry type are filled until a person edits them (`ttHold`); the default agent is assigned |
| **Add Lead** form | Channel, Name, Phone, Enquiry type, Property/Locality required | If the phone already exists, the Duplicate dialog offers Open or Update — a second lead is never created |
| **Shoot & Media card** | "Link a CRM lead → Not in the CRM? Create the lead" | A Seller Listing lead in New, linked to the card; a phone already in the CRM offers the existing lead instead |

A person's edit always outranks TailorTalk: once a shared field is edited it is held, and the panel shows "TailorTalk now says X — use it?".

### Process 2 — Assignment

Each lead has a **Lead agent** and a **Secondary** agent, chosen by a person (new leads get the default agent from settings). A newly assigned person gets an @mention-style task in "Asked of you", on the card and in their digest email. Site-visit agents are chosen separately per visit.

### Process 3 — Follow-ups (when *we* contact the lead)

1. Set **Next follow-up** from the note row, the Log follow-up dialog, the Add/Edit form, a bulk action or an On hold revisit date. Presets: +2 h, +4 h, Tomorrow, +3 days, +1 week, +2 weeks. Times step in 30 minutes; a date alone means 10:00.
2. After tapping Call or WhatsApp, returning to the tab within 5 s–30 min asks **"What happened on the call?"**.
3. **✓ Followed Up** logs it and sets the next date (or none).
4. Reminders: the bell, the Follow-ups badge, optional browser notifications (every 15 min, at most hourly), Daily task "Calls due" and the **09:00 IST digest**.

### Process 4 — Site visits (when everyone meets at the property)

1. **Schedule** on the lead: day, time, minutes (30/60/90/120), in person or by phone, **who is going** (with live free / busy / on leave from Google), property, notes for the agent, status (Asked for / Agreed / Done / Cancelled).
2. *Gates:* no date → status must be Asked for or Cancelled; Agreed with a date → at least one agent.
3. Saving sends a **private Google Calendar invitation** to the chosen team agents only (client and seller numbers never leave the team). The event carries client name and phone, what they want, budget, the seller's name and number from the property, the location and a link back to the lead.
4. Agents answer in Gmail/Calendar or in the CRM ("I can go / Can't make it" + reason). A decline raises **"Agent cannot make the site visit"** on the board, bell and digest.
5. Moving the time asks everyone again; **Call it off** deletes the event and tells everyone.
6. Three hours after the visit, **"Did the site visit happen?"** appears; **They visited** moves the lead to Visited and asks "How did the visit go?". After two silent days in Visited, "Get feedback on the visit" appears.

### Process 5 — AI lead automation

When switched on (⋮ → Lead automation), an AI reads each lead after its chat goes quiet for 2 minutes (at most 10), after every note, or on **Re-check**. Default model Gemini 3.5 Flash-Lite; Claude Haiku can be switched in (capped at 100 reads per day).

| The AI decides | Values | What the CRM does with it |
| --- | --- | --- |
| Intent | buy, rent, sell, rent out, invest, vendor, unclear | A confident sell / rent-out re-tags the lead **Seller Listing** → a board card appears |
| Stage | one of the 10 keys + confidence + quoted evidence | Moves **forward only**, never to Won, never over a person's choice unless the lead wrote since; uncertain moves become a **suggestion** (Move / Dismiss); every AI move can be **undone** for 7 days |
| Next step | owner (team / lead), action, kind, due date | Sets the follow-up inside 09:30–19:30 IST; shown as the card's next-step line |
| Site visit | requested / scheduled / done / cancelled, time, property | Writes the visit fields unless a person set them after the lead's last message |
| Hold / lost reason | reason + revisit date | Lost only for not interested, bought elsewhere or spam at high confidence |
| Status line | ≤ 80 characters | Shown on the card |
| Property codes mentioned | codes that exist in inventory | Added to the lead's linked properties |

Phones and emails are masked before anything is sent to the model, and every read is logged (`aiRuns`).

A separate **AI summary** (Claude Haiku, on demand via Regenerate or Backfill) writes a 3–4 line summary from the lead's details, last 25 notes and 40 history lines.

### Process 6 — What needs a person (attention rules)

One rule book drives the board, bell, queue, digest and browser alerts. A reason stays open until anyone on the team touches the lead.

| Reason | Severity | When |
| --- | --- | --- |
| Promise overdue | critical | The team's next step is past due |
| WhatsApp window closing | critical | We owe a reply and under 3 h remain of the 24 h window |
| Team owes a reply | high / medium | Our next step is open |
| Follow-up overdue | high | Follow-up time has passed |
| Waiting for team / escalated / flagged | high | TailorTalk handed the chat to a person |
| Visit declined | high | An agent declined a visit |
| Did the visit happen? | high | 3 h after a planned visit |
| Details owed | high | In Send more details for over a day |
| Sourcing stale | high | In Sourcing for over 3 days |
| Feedback due / negotiation stalled / hold due | medium | Visited 2+ days silent; negotiating 3+ days silent; revisit date reached |
| Lead silent / stale / AI suggestion | low | Waiting on the lead 3+ days; untouched 21 days; AI suggests a move |

### Process 7 — Matching and property links

- **Properties for this buyer:** the match engine reads the requirement (BHK, type, budget, localities, size, possession, objections) and scores the whole inventory — 40 % or more is shown, top 40, with vetoed properties and reasons.
- **Buyers waiting:** on a seller lead, the same engine scores every open buyer against the owner's property.
- **＋ Link / Link to this lead** adds a property code to `propertyCodes`; a person's unlink is remembered and never re-added by the AI or the board.

There is **no brochure-sending button** in the CRM; details reach clients through TailorTalk or WhatsApp, and the CRM records the fact with **Sent Details**, the Options sent column and the linked properties.

### Process 8 — Seller leads and the Shoot & Media board

A lead is a **seller** when its enquiry type is Seller Listing, or the AI reads sell / rent out with high confidence. The board then gives it a card automatically. The CRM owns the person (name, phone); the board owns the property. The property code is mapped **only by hand on the board** and then copied back to the lead. **Not a seller? Move back to leads** re-tags the lead, locks the type and removes the card only if nobody has worked on it.

### Process 9 — Reports and emails

| What | When (IST) | Content |
| --- | --- | --- |
| Follow-up digest | 09:00 daily (and Send Digest Now) | Needs action now, overdue, today, tomorrow, day after; each recipient's own @mentions. Email (WhatsApp delivery is configured but unreliable) |
| EOD dashboard summary | 21:30 daily (and Send Now) | Escalations first, then the day's metrics; AI-phrased reasons for leads lost today |
| Export Leads | On demand | `.xlsx` with 25 columns and all notes |

### Field reference — lead (`leads/{id}`)

| Field | Label | Values | Written by | Read by / why |
| --- | --- | --- | --- | --- |
| `name`, `phone`, `email` | Name*, Phone*, Email | Text | Person, TailorTalk, board | Everywhere; invitations; digest |
| `phoneKey` | – | 91XXXXXXXXXX | Every save | Dedupe across TailorTalk, form and board |
| `channel` | Channel* | call, whatsapp, instagram, website | Person, TailorTalk | How they reached us; analytics |
| `source` | Source badge | manual, tailortalk, board (legacy meta, whatsapp_bot) | Create path | Intake origin; analytics |
| `enquiryType` | Enquiry Type* | Property Enquiry, Seller Listing, General, Vendor / Collaboration, + custom | Person, TailorTalk, AI re-tag | Buyer / seller / vendor routing; seller → board card |
| `propertyInterest` | Property / Locality* | Text or "CODE · Name" | Person, TailorTalk, board | What they want; matching; invitation |
| `budget` | Budget | Text ("1.5 Cr") | Person, TailorTalk | Pipeline value; matching |
| `detailsSent` | Sent Details | Yes / No | Person, AI | Did we share details |
| `stageId`, `prevStageId`, `stageChangedAt/By`, `reached` | Stage, milestone trail | Stage ids, times | Person, AI | Column, stage age, funnel |
| `lostReason`, `holdReason`, `holdUntil` | Why lost / on hold, Revisit on | Enums, date | Person, AI | Loss analysis; revisit |
| `followUpAt`, `followUpBy`, `followUpSetAt`, `followUpNote` | Next follow-up | Time, who, why | Person, AI, TailorTalk booking | When we call next and why |
| `assignedAgent`, `secondaryAgent` | Lead agent, Secondary | Team emails | Person, default | Ownership; filters; digest |
| `mentions` | @ you | Per teammate: by, at, text, done | Person | Asks between teammates |
| `siteVisitAt`, `siteVisitStatus`, `siteVisitProperty`, `siteVisitAgents`, `siteVisitReplies`, `siteVisitNotes`, `siteVisitMinutes`, `siteVisitMode` | Site visit | Time; requested / scheduled / done / cancelled; agents; RSVPs | Person, AI, calendar | The viewing and who goes |
| `calendarEventId`, `calendarEventOwner` | – | Google ids | Calendar API only | Keeps the invitation in step |
| `propertyCodes`, `unlinkedPropertyIds` | Properties | Inventory codes | Person, AI, board | Lead ↔ property link; matching "already shared" |
| `listingId`, `listingCode`, `listingSkipped` | Listing | Card id, code, flag | Board, person | Seller ↔ board card |
| `tt`, `ttHold` | TailorTalk section | Snapshot; held fields | TailorTalk; person | Chat status, escalation, ad, signals |
| `ai` | Where this lead stands | Verdict, suggestion, last move | AI | Placement, next step, Undo |
| `aiSummary` | ✨ AI summary | Text | AI summary | Quick read |
| `lastNote`, `noteCount`, `lastActionType` | – | – | Person | Cheap reporting without extra reads |
| `createdAt/By`, `updatedAt/By` | Added / Updated | Time, who | Create / person only | Audit; `updatedAt` = "a person last worked this lead" |

**Sub-records:** `notes` (text, by, mentions) · `history` (every change; by a person, AI, TailorTalk or a migration) · `tailortalk/state` (AI profile, bookings, payments, full chat) · `aiRuns` (every AI read, server only).

### Lead views (`leadViews`) — how the CRM opens cheaply

Firestore bills one read per document, so a list of 760 leads used to cost 760 reads on every open. Since 13 Oct 2026 every lead also lives as a **row** inside a view document holding about 20 of them: `leadViews/{tenant}__meta` (layout: version, shard count, count, built time, `off` switch) and `leadViews/{tenant}__v{n}_{i}` (`rows: { leadId: lead + _w }`). The CRM, dashboard and board read the views — **39 reads instead of 760** — and then one read per change, as before.

- A row **is** the lead (same fields; notes and history stay in their sub-collections), so every screen reads it exactly as it read the lead.
- Every writer — CRM, board, dashboard, TailorTalk sync, AI, calendar — writes the lead and its row **in the same batch or transaction**, stamped with the server's time (`_w`). A page saves only the fields it changed, so a row that was behind can never carry an old value back into a lead.
- The **09:00 digest rebuilds** the views from the leads themselves, keeping any row written after the leads were read; when the leads outgrow the documents a larger set is prepared and switched to a day later.
- Switches: `node scripts/lead-views.mjs verify` (must print "IN STEP"), `build`, `off` (every page reads the leads directly again, within seconds — the kill switch), `on`.

### Settings the CRM uses (`settings/{tenant}`)

| Setting | Where set | Effect |
| --- | --- | --- |
| Enquiry types, property names | Add Lead form | Dropdown options |
| Follow-up digest (WhatsApp / email, recipients) | ⋮ → Follow-up Digest | 09:00 digest |
| Dashboard summary email (recipients) | ⋮ → Dashboard Summary Email | 21:30 email |
| Lead automation (on/off, model) | ⋮ menu; script for model | AI placement |
| Saved views | ☆ Views | Team-wide filter sets |
| Team list | **Script only** | Who can be mentioned, invited, shown in the calendar |
| Default lead agent, TailorTalk workspace | **By hand in Firestore** | New-lead owner; TailorTalk links |
| Lead views on / off | **Script only** (`node scripts/lead-views.mjs off` / `on`) | Whether pages read the packed views or the `leads` collection directly |
