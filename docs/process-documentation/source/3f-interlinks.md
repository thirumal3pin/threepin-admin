## 3F · Every interconnection between modules

The **property code** (e.g. `TNAG0002`) is the thread that ties the modules together; the **lead id** and the **listing id** tie a person to a card. Every link below names the exact field that carries it and which way data flows.

### The connection matrix

| # | From → To | Carried by | Direction | When it happens | Rule |
| --- | --- | --- | --- | --- | --- |
| 1 | Customer chat → CRM lead | TailorTalk webhook / pull → `leads.tt`, name, interest, budget, enquiry type, conversation | In | Every message; nightly; every 5 min | A person's edit wins (`ttHold`) |
| 2 | CRM lead → AI → pipeline | `leads.ai`, `stageId`, `followUpAt`, site-visit fields | Both | 2 min after a chat goes quiet; after notes | Forward only, never Won, never over a person |
| 3 | Chat → property links | AI finds codes → `leads.propertyCodes` | In | Each AI read | Only codes that exist; never re-adds an unlinked one; **never maps a board card** |
| 4 | Seller lead → Shoot & Media card | `listings.leadId`, `sellerName`, `sellerPhone` ↔ `leads.listingId` | Both | Board open, or sync script | Every seller lead gets a card unless set aside |
| 5 | Board card → new CRM lead | "Create the lead" → `leads` (source board) | Out | By hand | Duplicate phone links the existing lead |
| 6 | Board card → inventory property | `listings.propertyCode` | Board reads property | **By hand only** | One property, one card; mapping fills blanks; unmap takes back only what it fetched |
| 7 | Board mapping → CRM lead | `leads.propertyCodes`, `listingCode` | Board → CRM | On mapping | Old mapped code removed on re-map |
| 8 | CRM "Not a seller" → board | `enquiryType`, `listingSkipped`, card delete | CRM → board | By hand | Card removed only if untouched |
| 9 | Inventory sheet → property | Sheet sync → `properties` (tier A) | In | Mac run / Sync button | Pending dashboard edits protected |
| 10 | Dashboard edits → sheet | `propertyChanges` worklist | By hand | Maintainer ticks | No automatic write-back, by design |
| 11 | Brochure request → property | Form → Queue → Cowork → Mac → `brochureLink`, `photosLink`, `detailsText` | In | ~30 min after request | Fills blanks on existing properties |
| 12 | Property → board brochure state | `brochureLink` → card `brochure.doneAt`, panel frozen | Dashboard → board | Within seconds of delivery | Only the card that asked for it |
| 13 | Property internal notes → board | `internalNotes` → card internal notes | Dashboard → board | On mapping | Fills a blank only |
| 14 | Board card ↔ Posting row | `propertyCode`, `reference`, edit gates, V/O tags, `finalLinks` | Both | Planning and posting | Schedule needs edit planned; live needs edit done; the final video link is optional |
| 15 | Posting → board | Confirm posted → card moves to **Live** | Posting → board | On Confirm posted | Forward only |
| 16 | Board / Posting → dashboard | `listings` + `postTracker` → "Shoot & Media and posts" block (by id or code) | Read only | When the block is opened | Shows each card's column, listing type and shoot, the seller lead, every post's status and URL; a delete warns about cards and leads still linked |
| 17 | Board → CRM Daily task | `forVoAsk`, `voiceByEmail` → "Voice-overs to make" | Board → CRM | Live | Marks "mine" for the voice-over person |
| 18 | CRM site visit → Google Calendar | Visit fields + property seller contact → private invitation | Out, RSVPs back | On save | Team agents only; stamped events |
| 19 | Board shoot → Google Calendar | `shootAt`, shooter → 60-minute event on the booker's calendar, `shootEventId`, `shootEventBy` | Out; moves, re-assignments and cancellations follow | On booking | Only with the Settings switch on (off by default); only the entry's owner may move it |
| 20 | Property ↔ matching | Match engine reads properties + leads + cards | Read only | On open | Same scores in all three consoles; sold out = ruled out |
| 21 | Dashboard → CRM filter | `crm.html?propertyId=` (Lead CRM button) | Link | By hand | Shows only leads linked to that property, matched by id or code |
| 22 | Property → Finance deal | `propertyCode`, `propertyName` copied once | Read once | Add a deal | Later renames not reflected |
| 23 | CRM Won → Finance | – | **None** | – | Deals and invoices entered by hand |
| 24 | Leads → digest / EOD email | Lead views + attention rules | Out | 09:00, 21:30 | Same rules as the board |
| 25 | Every lead write → `leadViews` row | `leads/{id}` + `leadViews/{tenant}__v{n}_{i}.rows[id]` (`_w` server stamp) | Same batch or transaction | Every save from any console or server job; rebuilt daily at 09:00 | All or nothing; a page writes one row per document per write; `scripts/lead-views.mjs off` is the kill switch |
| 26 | CRM seller lead → board card | `leads.listingId` → `propertytrack.html?listing=` ("Open its card") | Link | By hand | A seller without a card gets "Track this listing" instead |

### How the property code travels

1. A **brochure request** or **Inventory sheet row** creates the code (`properties.propertyCode`).
2. An agent **maps** a Shoot & Media card to it by hand → `listings.propertyCode`.
3. The board copies it to the seller's lead → `leads.propertyCodes`, `listingCode`.
4. The AI adds it to **buyer** leads that discussed the property → `leads.propertyCodes`.
5. Posting rows are keyed by it → `postTracker.propertyCode`; post URLs are saved there.
6. A **site visit** on that code pulls the seller's name, number and location into the calendar invitation.
7. A **Finance deal** copies it once.
8. The dashboard reads cards, posts and leads back by the same code.
