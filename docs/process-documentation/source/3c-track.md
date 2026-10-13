## 3C · Shoot & Media board and Posting

**Console:** `propertytrack.html` (formerly "Property & Media"). **Collections:** `listings`, `listings/{id}/history`, `trackPipelines/{tenant}`, `postTracker`, `settings/{tenant}.trackConfig`.

The CRM follows a *person* through a sale; this board follows a *property* from "the owner said yes" to "it is live in the market". Its founding rule, written in the code header: *a seller who never gets a card is revenue that silently evaporates* — so every CRM seller lead gets a card automatically.

### Views and who uses them

| View | Used by | Purpose |
| --- | --- | --- |
| Board / List | Agents, owner | Every listing in its column, with days-in-column against a target. A card moves by drag — dropped anywhere on the column, not only on a card — or with the **Move to…** button every card carries (the way to move on a phone) |
| Shoots (run sheet) | Shooter | Today's and upcoming shoots with Call, Directions and Done buttons |
| Editor | Editors | One card per outlet cut: plan → editing → done → scheduled → posted |
| Sellers | Agents | Every seller lead as a tile, and sellers still waiting for a card |
| Posting | Owner / poster | The posting plan, week calendar, sheet of channels and post URLs |
| Settings → Configurations | Admin | Editors, voice-over person, targets, tags, documents list, calendar switch |

The code has **no roles**: any signed-in team member can do everything. People are recognised by settings (editors list, voice-over person) and by a "this is me" switch on the shooter's phone.

**Saves wait for the server.** Until this device has received the server's list of cards, every change — a move, a dialog's Save, a delete — is refused with "Still connecting — this is the copy saved on this device. Try again in a moment" (a dialog stays open with what was typed). A phone that opens on an old local copy can therefore never write that copy over a colleague's newer work.

### Board columns

| Column | Kind | Target days | Rule shown under the header |
| --- | --- | --- | --- |
| New listing | open | 2 | Owner is on board — nothing collected yet |
| Details & docs | open | 3 | Chasing the write-up, price and papers |
| Shoot scheduled | open | 5 | Date fixed and the owner knows |
| Shoot done | open | 2 | Photos taken — upload, then generate the brochure |
| Media ready | open | 3 | Media, photos, voice-over and brochure all done |
| Live — marketing | open | 30 | Listed and being shown |
| Sold / Rented | won | – | Closed |
| On hold | hold | – | Reason and optional revisit date kept |
| Dropped | lost | – | Reason kept |

Lateness = days since `stageChangedAt` against the target (Settings can override each). Past target the pill turns amber; past twice the target it turns red, and "Needs attention" sorting pushes the card up (+2 over target, +3 over double, +3 more if the shoot is within 24 hours or already past).

### Process 1 — A card is created

1. **Automatically from a seller lead.** When the board is open, `reconcileSellers` gives a card to every lead that (a) is a seller — enquiry type *Seller Listing*, or the AI says intent *sell / rent out* with high confidence, (b) is not a business lead, (c) is not set aside, and (d) has no card yet. The card takes the owner's name and phone, a title from the lead's property interest and the asking price from the budget. **The property code is never filled from the lead.** One lead gets **one card**: a lead that already has a card is never given a second one, and linking a card to a lead that already has one is done only on purpose.
2. **Sellers view → Create now** for a seller still waiting.
3. **+ New listing** by hand (title or code required).
4. **From Posting** — Create brochure on a row with no card makes one (in Live if a post is live, else Media ready); a new series makes a series card.
5. **From the script** `scripts/sync-seller-listings.mjs` (same logic, run by hand; not scheduled).

To opt a seller out: **Set aside** (`listingSkipped`), **Delete listing** (also sets `listingSkipped`), or CRM **Not a seller** (deletes the card only if nobody has worked on it).

### Process 2 — Card and lead stay in step

| Direction | What moves | Rule |
| --- | --- | --- |
| Lead → card | Seller name and phone | Only until someone edits them on the card (`own.*` then wins) |
| Lead → card (once) | Title, location, asking price | Copied at creation, then the board owns them |
| Card → lead | `listingId`, `propertyCodes`, `listingCode` | The card's code is added to the lead; the code the sync added before is removed on re-map; codes a person unlinked in the CRM are respected |
| Card → CRM (new) | A whole Seller Listing lead | "Link a CRM lead → Not in the CRM? Create the lead" (name + phone; a duplicate phone offers the existing lead) |

### Process 3 — Map the card to inventory (by hand only)

Mapping ties a board card to a property in the Property dashboard by its **property code**. It is done only by a person — Map to a property, the Property ID box, the brochure panel's Link, or Posting's Create brochure. One property can sit on **only one** card.

- **Linking** fills only empty card fields from the property (title, location, configuration, price, description, photos link, internal notes), always takes the delivered brochure link, and records exactly what it fetched (`fetched`).
- **Unmapping** takes back only what the mapping fetched. If a brochure was requested from the card, all details stay and only the code is removed.
- **The one automatic link:** when a brochure requested from this card under this code reaches the dashboard, the card is linked to it.

| Typed in Property ID | Result |
| --- | --- |
| Empty, on a linked card | Unlinks |
| A code already in the dashboard and on another card | Refused |
| A code in the dashboard, free | Linked after saving |
| A code not yet in the dashboard | Kept as the brochure's draft code |

### Process 4 — Listing type and documents

- **Listing type** (`listingType`): Not set / Normal / Exclusive / Collab — a chip on the card, in the form and in the panel, and shown on the property's Shoot & Media block when Exclusive or Collab. It is recorded but **gates nothing yet**.
- **Documents checklist** (`docs`): Sale deed / title, Parent documents, Encumbrance certificate (EC), Patta, Approved plan, Property tax receipt, Owner ID & PAN — the list is edited in Settings → Configurations (remove every item to hide the checklist). Each is *Have it / Applied for / Missing / Not needed*; the panel's heading shows how many are in hand (or not needed) out of the total. It **never blocks and never alerts**.

### Process 5 — Details and brochure

1. In the brochure panel fill **Title**, **Photos link** (Google Drive folder), **Description** and **Internal notes**; the code must be code-shaped and free.
2. **Generate** posts to the brochure Google Form ("CODE - Title", folder, details, notes) and logs the request.
3. The Mac scheduler builds the PDF, emails the team and writes it into the inventory; about 30 minutes later the board links the card, fills blanks and **freezes the panel**. "Brochure created" is read from the queue, never ticked by hand.
4. **Redo brochure** unlocks it — in practice, the post-shoot brochure (the owner's "v2"). Versions are not labelled.
5. **Brochure v2 reminder.** When a shoot is completed *after* the brochure was made (for shoots from 13 Oct 2026), the panel shows "Shot on … after the brochure was made — it does not have these photos. Make a new version when the new ones are in." It stays until the brochure is redone or **Not needed** is pressed (`broV2Seen` remembers that for this shoot only).

### Process 6 — Shoot

| Step | Who | What is captured | Effect |
| --- | --- | --- | --- |
| Getting there | Agent | Address, map link, who opens it, occupancy (vacant / owner / tenant / construction), best time, access notes | Shown on the run sheet |
| Book the shoot | Agent | Date, time (30-minute steps, default 10:00), assigned shooter, site contact | Card moves to Shoot scheduled; clash within ±2 h warns |
| Owner told | Agent | ☐ Owner told we are coming | Required for "ready to send" |
| Reschedule | Agent | New date, reason | Counts "moved N×", resets Owner told |
| Cancel | Agent | Reason | Card goes back to Details & docs |
| Shoot done | Shooter | Media captured ticks, **Drive folder with the raw photos**, notes | Card moves to Shoot done, then automatically to Media ready when nothing is missing |
| Team calendar | System | A 60-minute event "Shoot — title" at the booked time on the calendar of whoever books it, with the shooter invited; the address, property code, who opens it, what to capture, access notes and a link to the card | Only when **Put booked shoots on the team calendar** is on in Settings (**off by default** — it sends real Google invitations). Moving, re-assigning, cancelling, completing or deleting the shoot moves or removes the event; only the person whose calendar holds it can move it (`shootEventId`, `shootEventBy`) |

The **brief** says what to capture: Photos, Video, Drone, Floor plan, Virtual tour (default needed: Photos + Floor plan).

### Process 7 — Shoot for, edits per outlet and voice-over

1. **Shoot for**: tick the outlets planned — Insta Story, Insta Reel, FB Reel, YouTube, Collab — and per outlet the voice-over: *With V/O* or *V/O Reqd. separately*.
2. **Plan the edit**: outlets, editor, edit day, deliver-by (must be on or after the edit day). Allowed before the shoot.
3. **Start editing**: only once the shoot is done.
4. **Edit done**: only after starting; ticks that outlet as made. Once done, **+ Final video link** (optional) records where the finished video is (Drive, YouTube…); it can be changed or removed, and a re-edit keeps the old link until a new one is pasted. It is never asked for and never required.
5. **Ask for V/O** appears once the cut is being edited (the rough cut). It lands in the voice-over person's **CRM Daily task**; **V/O made ✓** closes it.
6. **Edit again / Clear** moves the done edit to history (up to 50); a mistaken earlier edit can be removed.

FB Reel reuses the Insta Reel cut unless **FB Reel has its own cut** is ticked.

### Process 8 — Automatic move to Media ready

A card moves itself from Shoot done to **Media ready** when *all* of these hold: every needed brief item is done, the photos link is set, every planned outlet is made, every cut is done, every separate voice-over is made, and the brochure is created. Documents, listing type and approvals are **not** checked. The board never moves a card back out of Media ready.

### Process 9 — Posting plan, posting and the URL

1. **Paste week plan**: the owner's plan text (e.g. `Monday -S- Lux49 - 4Bhk`) becomes rows: a day, a Story, a YouTube item, or a series row.
2. **Schedule** each channel (Insta Story, Insta Reel, Facebook Reel, YouTube) with a date and time. *Gate:* that outlet's edit must be planned.
3. When the time passes the post shows as **Due** — nothing goes live by the clock alone.
4. **Confirm posted**: "went live at" (not in the future) and the **post URL**. *Gate:* the edit must be done. The card then moves forward to **Live**.
5. A live post without a link stays flagged until the URL is added.
6. **99acres** and **3 PIN website** listings have their own Not posted / Posted / N/A status and URL.
7. Posting the same property again creates a **repost** row with its own schedule and links.

The post URL lives on the Posting row (`postTracker.channels.*.url`) and is shown in Posting, on the Editor card and in the Property dashboard's Shoot & Media section.

### Field reference — listing card (`listings/{id}`)

| Field | Label / where | Values | Filled at | Why it exists |
| --- | --- | --- | --- | --- |
| `stageId`, `stageChangedAt/By`, `reached` | Column, days pill | Stage id, time | Every move | Where the property is and how long it has waited |
| `leadId` | Open in CRM | Lead id | Creation / Link a lead | Ties the owner's conversation to the property |
| `title` | Card name ✎ | Text | Creation, edits, mapping | The name everyone uses; sent with the brochure |
| `propertyCode` | Code chip, Property ID | Inventory code | **By hand** at mapping | The single link to inventory, Posting and the lead |
| `location`, `config`, `askingPrice` | One line | Text | Creation / mapping | Basics for matching and the brochure |
| `sellerName`, `sellerPhone`, `own` | Summary | Text / flags | From the lead, or typed | Owner contact; a typed edit beats the CRM |
| `listingType` | Chip | normal / exclusive / collab (or unset) | Onboarding | Mandate type; shown on the property's Shoot & Media block; gates nothing yet |
| `docs` | Listing & documents | document key → have / applied / missing / na | Details lane | Paper chase status; a checklist only |
| `address`, `mapLink`, `siteContact`, `occupancy`, `bestTime`, `accessNotes` | Getting there | Text / enum | Before the shoot | So the shooter arrives and gets in |
| `shootAt`, `shootAssignee(Email)` | Shoot | Time / person | Booking | The booking and who shoots |
| `shootEventId`, `shootEventBy` | – | Google event id; whose calendar holds it | Booking, with the calendar switch on | Keeps the shoot's calendar entry in step; only its owner may move it |
| `rescheduled`, `rescheduleReason`, `shootCancelled`, `cancelReason` | Shoot | Count / text | Changes | Spot owners who keep postponing |
| `ownerInformed` | ☐ Owner told | Yes/no | Before the shoot | Avoid wasted trips |
| `ownerApproved` | ☐ Owner approved photos / brochure | Yes/no | After media | The *property owner's* sign-off (not Swami's) |
| `need`, `media` | The brief | photos, video, drone, floorPlan, tour | Plan / shoot done | What to capture and what was captured |
| `shootDoneAt`, `shootNotes` | Shot date, notes | Time / text | Shoot done | Unlocks editing; records gaps |
| `photosLink` | Drive photos | URL | Shoot done / brochure | Raw photos folder; also the brochure's folder |
| `brochureLink`, `brochure{}`, `description`, `internalNotes` | Brochure panel | URL / state / text | Details lane | Brochure request, lock and source text |
| `broV2Seen` | Brochure v2 reminder → Not needed | The shoot-done time it was dismissed for | After a post-brochure shoot | Silences the "make a new version" reminder for that shoot only |
| `fetched` | – | Field → value | Mapping | Exact undo of a mapping |
| `forPlan`, `forDone` | Shoot for | Per outlet yes/no | Planning / edit done | Which outlets are planned and made |
| `forVoice`, `forVo`, `forVoAsk` | Voice over | live / vo; made; ask {at, by, note} | Planning / rough cut | Voice-over per outlet |
| `cuts` | Edit rows, Editor | planned / active / done + editor, dates, log | Editing | One edit per outlet, with history |
| `fbOwnCut` | ☐ FB Reel own cut | Yes/no | Planning | Whether FB reuses the Reel |
| `finalLinks` | Final video | cut → { url, at, by } | After Edit done, optional | Where the finished video is (Drive, YouTube…) |
| `tags` | Tags | Collab, New Dev., Resale, Plot + configured | Any time | Grouping and filters, shown everywhere |
| `dropReason`, `holdReason`, `holdUntil` | Why? | Enum / date | Drop or hold | Why it stopped, when to revisit |
| `kind`, `postingId` | Series | series | Posting | A card that groups several properties |

### Field reference — Posting row (`postTracker/{id}`)

| Field | Meaning |
| --- | --- |
| `propertyCode`, `propertyId` | Link to inventory and the board card (unique per non-repost row) |
| `title`, `reference` | Name; the plan's short name ("Lux49 4Bhk"), shared with the card |
| `plannedDate`, `weekOf` | From the week plan |
| `channels.igStory / igReel / fbReel / yt` | `{status: yet / scheduled / live / na, at, url, liveAt, day}` |
| `acres99`, `website` | `{status: pending / posted / na, url, at}` |
| `repostOf` | A later round of posts for the same property |
| `kind`, `members` | Series rows (two or more properties) |
| `tags`, `note`, `details`, `photosLink` | Notes; photos and details live on the card when there is one |

### Settings → Configurations (`trackConfig`)

| Setting | Default | Effect |
| --- | --- | --- |
| Editors | none | Listed first when planning an edit; editors open on their own Editor view |
| Voice-over by (+ email) | none | Owner of V/O requests; marks them "mine" in the CRM Daily task |
| Deliver by, when not typed | before the post day | Default delivery date for an edit |
| "Soon" within N days | 2 | Editor deadline chip |
| "series" lines become a series | on | Week-plan parsing |
| New series gets a board card | on | Creates a series card |
| Put booked shoots on the team calendar (`shootCalendar`) | **off** | A booked shoot goes on the booker's calendar with the shooter invited by Google; moving, re-assigning or cancelling the shoot follows. Sends real invitations — switch on deliberately |
| Stage targets | 2 / 3 / 5 / 2 / 3 / 30 days | Lateness colours and sort |
| Tags | none | Added to the four fixed tags |
| Documents checklist (`docItems`) | 7 defaults | The documents every card is checked for; add or remove items, **Starting list** restores the defaults; an empty list hides the checklist |
