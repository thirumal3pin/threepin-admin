# Document 1 · Functional overview

The platform runs the whole property business in five consoles that share one sign-in, one navigation rail and one database. A property moves left to right through them: it is **found** (CRM), **listed and shot** (Shoot & Media), **described and stored** (Property dashboard), **posted** (Posting) and **sold and billed** (CRM and Finance).

## The five consoles

| Console | Page | What it does, in one line |
| --- | --- | --- |
| Home | `index.html` | Launcher tiles into every console, plus the customer-facing TailorTalk chat widget |
| Property dashboard | `dashboard.html`, `property.html` | The inventory: every property's facts, prices, links, map, matching buyers and data-quality worklists |
| CRM | `crm.html` | Every enquiry from first message to Won or Lost: pipeline, follow-ups, site visits, team calendar, AI placement, reports |
| Shoot & Media board | `propertytrack.html` | Every seller's property from "owner said yes" to "live online": details, documents, brochure, shoot, edits, voice-over, posting |
| Finance | `3pinfinance.html` | The agency's own double-entry books: deals, invoices, bills, GST, bank reconciliation, reports for the CA |

## Processes by module

### Property dashboard

| Process | What it does |
| --- | --- |
| Sync from the Inventory sheet | Copies property facts typed in the Google Sheet into the dashboard, protecting any edits made in the dashboard |
| Brochure pipeline | Turns a brochure request into a PDF, emails it to the team and adds or updates the property |
| Search, filters and client brief | Finds properties by natural language, 20+ filters, or a client's own words |
| Property detail | Shows facts, specs, sales pitch, notes, internal notes, matching buyers and a read-only **Shoot & Media and posts** block (the board card, its column and shoot, every post with its link) |
| Edit, sold out, interest, notes, delete | Keeps the working state of each property current; every edit is logged; a delete first says how many board cards and CRM leads still point at the property and keeps a full copy in the change log |
| Changes to apply | Lists dashboard edits so they can be copied back into the sheet by hand |
| Missing data, duplicates, area map | Data-quality worklists |
| Map | Positions, nearby places and travel times |
| Share | Sends plain details or the brochure to a client, or a login-only link to a colleague |

### CRM

| Process | What it does |
| --- | --- |
| Lead capture | Creates leads from TailorTalk chats, the Add Lead form or a board card; never duplicates a phone number |
| Pipeline | Moves each lead along New → Options sent → Send more details → Visit planned → Visited → Negotiating → Won (plus Sourcing, On hold, Lost); **Leads for property** (`crm.html?propertyId=`, by id or code) shows only the leads linked to one property |
| AI lead automation | Reads each chat and places the lead, sets its next step and follow-up, books visits, links properties |
| Follow-ups | Schedules when the team contacts each lead and reminds them |
| Site visits | Books visits with Google Calendar invitations to the chosen agents and collects their answers |
| Team calendar and meetings | Shows everyone's day; finds free time; books meetings; a repeating meeting is edited or dragged one occurrence at a time |
| Daily task | One "your day" screen: visits, meetings, calls due, @mentions, voice-overs |
| Attention rules | Flags every lead that needs a person, by severity |
| Matching | Ranks properties for a buyer, and buyers for a seller |
| Reports | Analytics tab, 09:00 follow-up digest, 21:30 day summary, Excel export |

### Shoot & Media board

| Process | What it does |
| --- | --- |
| Seller → card | Gives every seller lead a card automatically |
| Mapping | Links a card to its inventory property by hand (one property, one card; one card per lead) |
| Moving cards | Drag onto any part of a column, or the **Move to…** button on every card (works on phones) |
| Listing type and documents | Records Normal / Exclusive / Collab and the paper checklist (Have it / Applied for / Missing / Not needed); a record only — it gates nothing and never alerts |
| Brochure | Requests the brochure from the card and tracks it to delivery; reminds you to make a new version when the shoot came after the brochure |
| Shoot | Books, reschedules, runs (Shoots run sheet) and completes the shoot with the raw photos link; optionally puts the booked shoot on the team calendar (Settings switch, off by default) |
| Edits per outlet | Plans, starts and finishes one edit per outlet (Insta Story, Insta Reel, FB Reel, YouTube, Collab), with an optional final video link per cut |
| Voice-over | Asks for a V/O on the rough cut and routes it to the voice-over person |
| Media ready | Moves the card automatically once photos, edits, V/O and brochure are all done |
| Posting | Plans the week, schedules each channel, confirms posts live with their URL, tracks 99acres and the website |
| Configurations | Admin settings: editors, voice-over person, targets, tags, documents list, calendar switch |

### Finance

| Process | What it does |
| --- | --- |
| Record | ~35 plain-language actions that write balanced journal entries |
| Deal cycle | Token → registration → invoice each side → payment → settlement |
| Costs | Expenses, bills, payments, petty cash, salaries, assets |
| Recurring, loans, month-end | Monthly services, EMIs, depreciation and prepaid release |
| Bank reconciliation | Imports statements and matches them to the books |
| GST and TDS | Splits, credit, set-off order, returns registers |
| Reports and books | P&L, balance sheet, trial balance, cash flow, exports for the CA |
| Digest | 08:00 email: weekly, renewals, monthly P&L |

## Automations at a glance

| When | What runs |
| --- | --- |
| Every TailorTalk message | Lead created or updated; AI read 2 min after the chat goes quiet |
| Every save of a lead | The lead's row in `leadViews` is written in the same batch, so the CRM opens with about 39 reads instead of one per lead (760) |
| Every 5 min with the CRM open | Safety-net chat pull (resumes where the last one stopped) and due AI reads |
| Every Mac run | Brochure delivery, then Inventory sheet sync |
| 04:30 IST | TailorTalk nightly sync |
| 08:00 IST | Finance digest |
| 09:00 IST | Follow-up digest and lead-views rebuild |
| 21:30 IST | End-of-day summary email |
