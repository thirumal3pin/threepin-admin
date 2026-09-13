# TailorTalk → 3 PIN Realty CRM
## Complete API & Webhook Integration Analysis

Prepared for: admin.threepin.in (Firebase + Vercel)
Source: TailorTalk public documentation (guide, API reference, webhook, tools sections)

---

## 0. Executive map — everything TailorTalk exposes

TailorTalk's integration surface is bigger than the "API Reference" page suggests. That page lists only 3 endpoints. The real surface is **7 REST endpoints + 6 webhook triggers + 1 reverse-call mechanism (API Tool) + 6 no-code bridge tools.**

There are **four directions of data flow**. Most people only build direction A. Directions C and D are where the leverage is for your business.

| Direction | Mechanism | What it does |
|---|---|---|
| **A. TailorTalk → your CRM (pull)** | 4 REST endpoints | You poll for leads, contacts, templates, message status |
| **B. TailorTalk → your CRM (push)** | Webhooks, 6 triggers | Real-time lead events + full chat history |
| **C. Your CRM → TailorTalk (command)** | 3 REST endpoints | Mark converted, send WhatsApp template, add match image |
| **D. TailorTalk agent → your CRM (live)** | **API Tool** | The agent calls *your* endpoints mid-conversation |

Two different base hosts are used. This matters when you configure your client:

- `https://service.tailortalk.ai/api/v1/` → `get_leads`, `get_contacts`, `add_match_image`
- `https://api.tailortalk.ai/api/v1/` → `mark_converted`, `send_whatsapp_template_message`, `message_status`, `get_whatsapp_templates`

Auth is identical everywhere: header `Authorization: Agent <agent_token>`, taken from the **Developer page → API Keys tab**. One token per agent. The token itself determines which agent context applies — you never pass `agent_id`.

---

## 1. `POST /get_leads` — the pipeline table

`https://service.tailortalk.ai/api/v1/get_leads`

### Request

| Param | Req | Notes |
|---|---|---|
| `start_after` | no | ISO 8601 w/ timezone. Returns leads who messaged **before** this time (backwards pagination) |
| `lead_status` | no | `cold`, `warm`, `hot` (statuses also include `converted`, `dead`) |
| `lead_source` | no | `whatsapp_dm`, `instagram_dm`, `web_chat` |
| `limit` | no | max 200 |

### Response fields
`lead_name`, `lead_contact`, `lead_status`, `last_message_time`, `joined`, `total_followups`, `integration`, `id`
Plus `count`, wrapped in `data`, with `success: true`.

The docs state the response shows only the most important fields and that additional fields may be present. Do not hard-code a schema — store the raw JSON blob alongside your parsed columns.

### Strategic scopes for 3 PIN

1. **Drift reconciliation (the real job).** Webhooks are your live feed, but any missed webhook = a permanently lost record. Run `get_leads` nightly and diff against Firestore. This is the audit layer that makes a webhook-first architecture safe.
2. **Day-1 backfill and post-outage recovery.** Paginate backwards through the full history to seed your CRM.
3. **Channel ROI at source level.** `lead_source` splits WhatsApp DM vs Instagram DM vs website chat. You shoot property videos and post on Instagram and YouTube — this is the number that tells you whether Instagram actually produces enquiries or just views.
4. **Funnel snapshot metrics.** Daily counts by status → cold/warm/hot trend chart on your dashboard. You currently have zero pipeline visibility; this is the cheapest fix.
5. **`total_followups` as a fatigue signal.** High follow-up count + still cold = kill or hand to a human. High follow-up count + hot = the AI is nagging a serious buyer; intervene.
6. **Lead age and velocity.** `joined` vs `last_message_time` gives time-in-pipeline. Compute median days-to-hot per source. Use it to set realistic follow-up SLAs for your Realtor Club partners.
7. **Stale-lead rescue queue.** Query `lead_status=hot` or `warm`, then filter client-side for `last_message_time` older than N days. This directly attacks your stated #1 pain: losing leads when conversations go cold.
8. **Realtor Club distribution feed.** Pull hot leads, apply your own zone logic, assign to one of the 6 partners. Keeps allotment logic in your code, not theirs.
9. **`id` as a stable external key.** The format is composite (`<agent>_<integration>_<contact>`). Use it as `external_id` in Firestore so a lead re-appearing on a second channel doesn't create a duplicate record.
10. **Cost and quota discipline.** One batched pull per schedule beats per-record lookups. Max 200 per request.

### Constraints you must design around

- **Pagination is backwards-only.** `start_after` fetches *older* leads. There is no "changed since X" forward cursor. You cannot do a clean incremental sync — you must fetch the newest page and walk backwards until you hit records you already have.
- **`lead_contact` appears masked in the documented response** (`91********`). This may be doc redaction, but if the API genuinely masks it, `get_leads` cannot supply your primary key and you must depend on webhooks. **Verify before you write a line of code.**
- No chat content. This endpoint gives you status, not conversation.
- No `updated_at`. Status changes without a new message may not move `last_message_time`.

---

## 2. `POST /get_contacts` — the master contact database

`https://service.tailortalk.ai/api/v1/get_contacts`

### Request
`start_after` (ISO 8601, paginate on `created_at`), `limit` (max **500**).

### Response fields
`name`, `phone_number`, `created_at`, `updated_at`, plus **every custom attribute flattened as a top-level field** (their example shows `city`, `membership`).

Covers everyone the agent has interacted with **plus contacts uploaded manually or via API** — a superset of leads.

### Strategic scopes for 3 PIN

1. **This is where your property-enquiry schema lives.** `get_leads` cannot tell you which property a lead wants. Configure custom attributes on the agent — `budget_min`, `budget_max`, `locality`, `configuration` (2BHK/3BHK), `intent` (buy/rent/sell), `timeline`, `loan_required`, `nri` — and they arrive here as first-class fields. **This single move converts TailorTalk from a chat log into a qualified lead source.**
2. **Real change cursor.** `updated_at` exists here and not in `get_leads`. Use this endpoint when you need "what changed" semantics.
3. **Seller/owner-side registry.** Upload your listing owners as contacts with attributes like `property_code`, `listing_expiry`, `exclusive_yes_no`. You then have buyers and sellers in one addressable database — and can broadcast listing performance updates to owners.
4. **Segment builder for campaigns.** Pull contacts where locality = Adyar and budget > 1 Cr, export to CSV, feed into an AI Campaign or loop the Template API. Replaces manual list-building.
5. **Re-marketing on new launches.** Every past enquirer is retrievable. When a Shirdi Shelters-style phase launches, you already have a warm list segmented by budget and area.
6. **Dedupe and enrich against Firebase.** `phone_number` is your natural join key to existing contacts.
7. **Recovering the "Name_Property" convention.** You used to encode property into the contact name in WhatsApp Business. Custom attributes replace that hack properly — and are queryable.

### Constraints

- Same masking question applies to `phone_number`.
- The docs describe custom attributes being added **via CSV or API**, but no write endpoint for contacts is documented in the public API reference. **Ask TailorTalk whether a create/update-contact endpoint exists** — if it does, your CRM becomes the master and pushes attributes down.

---

## 3. `POST /mark_converted` — the only status write-back

`https://api.tailortalk.ai/api/v1/mark_converted`

`contact_ids` (required): a **list** of WhatsApp numbers with country code, or Instagram usernames. Returns `updated_count`.

### Strategic scopes for 3 PIN

1. **Close the loop on offline conversions.** Site visit → negotiation → registration all happen outside chat. Without this, TailorTalk's view of your funnel is permanently wrong.
2. **Suppression list.** `is_converted` is a permanent flag that never turns itself off. Use it as your "never send marketing blasts to this person again" marker — a buyer who just registered a flat should not receive a new-launch broadcast.
3. **Makes TailorTalk's own analytics honest.** The dashboard's "Ask Me" insights ("why are my leads not converting?") are only as good as the conversion data you feed back.
4. **Referral cohort.** Your converted list is your highest-value referral audience. Tag it, then run a referral template campaign against exactly that set.
5. **Batch-friendly.** Accepts a list → run it as a nightly job from your finance/deal module rather than one call per closure.
6. **Cross-channel identity.** It accepts Instagram usernames as well as phone numbers, which confirms Instagram leads are keyed by username, not phone. Your CRM's contact model needs to handle both key types.

### Constraint — treat as irreversible

`is_converted` never resets. `lead_status` keeps being re-read from the ongoing conversation, so a converted customer asking a support question will show a different `lead_status` while remaining flagged converted. **Never wire this to an automatic or loosely-defined rule.** Fire it only from a confirmed deal record.

---

## 4. `POST /send_whatsapp_template_message` — your outbound engine

`https://api.tailortalk.ai/api/v1/send_whatsapp_template_message`

This is the most under-documented-in-importance endpoint. It is the mechanism that lets your CRM *act*, not just observe.

| Param | Req | Why it matters |
|---|---|---|
| `lead_contact` | yes | Target number |
| `lead_name` | no | |
| `template_name` | yes | Must be APPROVED in WhatsApp |
| `template_params` | no | List (positional) **or** object (named) |
| `website_button_params` | no | Dynamic URL suffixes for `{{1}}` buttons, in button order |
| `copy_code_button_params` | no | Coupon/code string |
| `header_media_url` | no | **Image, document or video header** |
| `header_media_name` | no | Filename the user sees on download |
| `lock_lead` | no | **Locks the lead when they reply → AI stops responding** |

Returns `message_id` (a `wamid.…`). Messages are written into the lead's chat history, so the agent retains context if the lead replies.

### Strategic scopes for 3 PIN

1. **Branded brochure delivery, automated.** `header_media_url` + `header_media_name` sends a document header. Point it at your Drive-hosted PDF and the buyer receives `3PIN_Nanganallur_2BHK.pdf`. This automates one of your most time-expensive manual tasks and preserves brand presentation.
2. **Poster and price-drop pushes.** Image header + a one-line template = your WhatsApp poster workflow, triggered from the CRM instead of hand-forwarded.
3. **Site-visit reminders.** T-24h and T-2h utility templates driven by your CRM's visit calendar. Reduces no-shows without you chasing anyone.
4. **Re-opening the 24-hour window.** WhatsApp only permits free-form replies inside a 24h session. Once a conversation goes cold, a template is the *only* legal way back in. Your CRM's "Follow up now" button is literally this endpoint.
5. **`lock_lead: true` is the reassignment mechanism you have been missing.** When you hand a lead to an employee or a Realtor Club partner, send a template with `lock_lead: true`. The instant the lead replies, the AI stops and the human owns the conversation — with full history intact. This solves your "no history when someone else takes over" problem at the protocol level.
6. **Per-lead deep links with attribution.** `website_button_params` appends to a `{{1}}` URL. Send `threepin.in/p/{{1}}` with the property code, and you get click-level tracking per lead per property.
7. **Legal document dispatch.** Exclusive listing agreements, title-deed copies, partition deed extracts — all as document-header utility templates, logged in chat history as proof of delivery.
8. **Owner-side reporting.** Monthly "your listing got N enquiries, M site visits" template to property owners. Almost nobody in Chennai brokerage does this; it is a retention weapon.
9. **Outbound audit log.** Persist `message_id` per lead — your CRM gains a complete record of every outbound touch, which WhatsApp Business never gave you.

### Constraints

- Template must be APPROVED in WhatsApp first.
- WhatsApp conversation charges apply — every send costs money. Rate-limit from your side.
- One lead per call. Bulk = your own loop with backoff, or use the Campaign/Broadcast UI.

---

## 5. `GET /message_status` — delivery intelligence

`https://api.tailortalk.ai/api/v1/message_status?message_id={message_id}`

Returns `sent` | `delivered` | `read` | `failed`. **Retained only 14 days**; invalid or older IDs return 400.

### Strategic scopes for 3 PIN

1. **Read-receipt as an intent signal — the non-obvious one.** `read` with no reply within a few hours = interested but hesitant → generate a "call this person" task for you. `delivered` but never `read` = dormant number. `failed` = bad data. Three different actions from one field.
2. **Data hygiene queue.** Repeated `failed` → flag the contact for correction. Your database quality compounds over 40+ active properties and hundreds of enquirers.
3. **Template A/B testing.** Send brochure template A to half your warm segment and B to the other half, compare read rates. Optimise the message that carries your brand.
4. **Build your own permanent log.** 14-day retention means you must poll inside the window and persist. Do this in a scheduled job an hour after each send, then again at 24h.
5. **Campaign health monitoring.** A sudden drop in delivery rate usually means a Meta quality-rating problem — catch it before your number gets restricted.

---

## 6. `GET /get_whatsapp_templates` — template registry

`https://api.tailortalk.ai/api/v1/get_whatsapp_templates` (optional `?template_name=`)

Returns `template_name`, `template_status` (`APPROVED` / `PENDING` / `REJECTED` / `PAUSED` / `DISABLED`), `template_type` (`MARKETING` / `UTILITY` / `AUTHENTICATION`), `language`. Up to 100 when unfiltered.

### Strategic scopes for 3 PIN

1. **Pre-flight guard.** Check APPROVED before sending. Prevents silent failures inside automated flows.
2. **Mobile-safe template picker.** Sync this into your CRM and render a dropdown of only approved templates. You and your team work from phones — this stops anyone picking a broken template under pressure.
3. **Cost and compliance routing.** MARKETING templates cost more and are subject to Meta's per-user marketing limits; UTILITY is for transactional. Have your CRM auto-select UTILITY for site-visit confirmations and reserve MARKETING for launches. This is a real money saving at volume.
4. **Template health alerting.** Poll daily and alert when any template flips to REJECTED, PAUSED or DISABLED — before a scheduled campaign fails.
5. **Tamil/English routing.** The `language` field lets you maintain parallel templates and pick per-lead. Meaningful in Chennai; most competitors send English-only.

---

## 7. `POST /add_match_image` — the sleeper endpoint

`https://service.tailortalk.ai/api/v1/add_match_image`

| Param | Req | |
|---|---|---|
| `image_url` | yes | Must be **publicly accessible** — TailorTalk fetches it directly |
| `metadata` | no | Arbitrary object (their example: sku, name, colour, price) — **returned when a match is found** |

Requires a Match Image tool already configured on the agent with `source_type: CUSTOM`.

### Strategic scopes for 3 PIN — reframed for real estate

Documented purpose is product-image matching for retail. For brokerage it is something more interesting.

1. **Screenshot-to-listing identification.** Buyers constantly send screenshots from 99acres, Housing, MagicBricks or your own Instagram and ask "is this available?". Index every listing photo with `metadata: {property_code, locality, configuration, price, status, owner_id}`. The agent identifies the exact property and the match metadata comes back attached. **This solves the single biggest gap in `get_leads` — it does not tell you which property a lead wants. Now the image does.**
2. **Instagram post → lead attribution at the post level.** Index your own poster creatives with `metadata: {post_id, campaign, property_code, posted_date}`. When a lead sends back the creative that brought them in, you learn which specific post converts. That is content ROI at a granularity almost no realtor has.
3. **Floor plan matching.** Index floor plans separately. Buyers circulate floor plans among family; when one comes back, the agent knows the unit.
4. **Competitor intelligence.** Index screenshots of competing listings in your zones. When leads send them, you learn what you are being compared against and at what price.
5. **Auto-sync from your property dashboard.** Your Firebase property collection already holds images. On listing creation, fire `add_match_image` with the hero image and metadata. The agent's visual index stays current with zero manual work — exactly the structural fix you prefer over pushing harder.
6. **Site-photo verification.** Index interior shots per unit so the agent can confirm "yes, that's the 3rd floor unit in Mahalingapuram".

### Constraints

- One image per call → loop with rate limiting during bulk indexing.
- Images must be publicly reachable. Your Vercel-hosted or Drive-shared images qualify; private Firebase Storage URLs may not.
- The Match Image tool must exist with `source_type: CUSTOM` first — configure in the dashboard before any API call.

---

## 8. Webhooks — the real backbone

Configured at **Developer → Webhooks**. **Multiple webhooks per agent**, each with its own endpoint URL, its own event set, and its own custom trigger prompt. Plan determines how many.

### Delivery mechanics

Headers sent: `Content-Type: application/json`, `User-Agent: TailorTalk-Webhook/1.0`, `X-Webhook-Version: v1`, `X-Webhook-Timestamp` (unix epoch seconds).

Envelope: `webhook_trigger`, `event_type` (always `lead`), `event_version`, `occurred_at` (agent timezone), and `data`.

`data` contains: **contact details, status, chat summary, chat history, bookings and payments, plus all custom attributes.**

Response contract: return `200`/`201`/`204`. `5xx` or unreachable → retried with backoff. `400`/`401`/`403`/`404`/`422` → **permanent failure, never retried.**

Firing rules: every webhook is evaluated independently and matching ones deliver simultaneously; each sends at most one request per conversation update even if several of its events match; a failure on one does not affect the others.

### Per-trigger strategic scopes

**`first_message`**
- Create the lead record in Firestore the instant it exists. Replaces saving a contact as "Name_Property" by hand.
- Capture `lead_source` at birth for clean attribution.
- Start a response-time SLA clock.
- Run a returning-enquirer check against your contact history — a repeat buyer should never be treated as a fresh cold lead.
- Auto-assign an owner via your Realtor Club zone logic.

**`on_warm`**
- Move to nurture stage; enqueue automated brochure send via Template API.
- Schedule a day-2 and day-5 follow-up task.
- Begin capturing qualification attributes.

**`on_hot`**
- Real-time push notification to you and/or the zone partner. This is what replaces "tracking follow-up dates in your head".
- Auto-create a site-visit task.
- **SLA escalation chain**: if no human contact within 15 minutes, escalate to the next Realtor Club partner. Scaling without hiring, enforced by software.

**`on_converted`**
- Create the deal record → feeds directly into your finance module (3pinfinance.html) for brokerage/commission entry. This is the join between your lead system and your financial records.
- Trigger the suppression flag and the referral-ask sequence.

**`every_message`**
- **The only way to get `chat_history` into your database.** No REST endpoint returns conversation content. If you skip this trigger, conversation data is unrecoverable.
- Powers your future "ask a question about this lead" feature — once history is stored, you run your own LLM over it.
- Extract localities, budget figures and property codes with your own parsing as messages arrive.
- Maintain a true last-activity timestamp for stale detection.
- Volume warning: this fires on every message. Return 200 immediately, queue the processing.

**`custom` (prompt-defined) — the most underused feature in the platform**

Each webhook carries its own natural-language trigger condition, evaluated by the AI on the live conversation. You are effectively running a standing question against every conversation and getting the answer pushed to you. High-value conditions for your business:

- *"when the lead shares a budget figure"* → write budget to CRM, auto-segment
- *"when the lead names a specific locality"* → route to the right zone partner
- *"when the lead asks for a site visit date"* → create the visit task
- *"when the lead mentions needing a home loan"* → trigger loan-partner referral (a revenue line most brokers leave on the table)
- *"when the lead indicates they are an NRI"* → switch to a timezone-aware, document-heavy follow-up cadence
- **"when a property owner or land owner enquires about listing their property"** → route to the **listing pipeline instead of the buyer pipeline.** Hot/warm/cold cannot distinguish a seller from a buyer. This custom trigger can — and seller leads are worth more to you than buyer leads.
- *"when the lead mentions another broker or a competing project"* → competitive alert
- *"when the lead goes silent immediately after the price is quoted"* → price-objection queue

### Architecture consequences

- **Build 3–4 separate endpoints, not one god-handler.** Independent retries and independent failure domains are a feature; use them. E.g. `/api/tt/lifecycle` (first_message, warm, hot, converted), `/api/tt/messages` (every_message), `/api/tt/qualify` (custom).
- **Webhooks are lossy by nature.** Pair them with the `get_leads` nightly reconcile from §1.
- **No HMAC signature is documented.** There is no signing secret in the header list, which means your endpoint is effectively unauthenticated. Mitigate with an unguessable secret path segment (`/api/tt/webhook/<long-random>`), a replay window check against `X-Webhook-Timestamp`, and strict payload-shape validation. **Ask TailorTalk whether request signing is available.**
- **Never return 4xx on a transient problem.** A 422 from a validation bug means that event is gone forever. Return 200 and dead-letter internally.
- Use the **Sample Payload** option in each webhook card's ⋮ menu to get the exact JSON your agent will send — the `data` shape depends on your own agent configuration, so this is the only authoritative schema.
- **Test Webhook** in the same menu lets you validate your Vercel function before going live.

---

## 9. The API Tool — the direction almost everyone misses

**Tools → API Tool.** This lets the TailorTalk agent call *your* REST endpoints live, mid-conversation.

Configuration per endpoint: API Name, Request Type (**GET or POST only**), URL, Headers (key-value, e.g. `Authorization: Bearer <token>`), and typed Parameters/Body fields — each with Name, Type (`int` or `str`), Required, and Description. Plus an overall Description telling the agent when to use it.

This inverts the integration. Instead of syncing data out of TailorTalk into your CRM, **your CRM becomes the live source of truth the agent reads from and writes to.**

### Strategic scopes for 3 PIN

1. `GET /api/properties/search?locality=&budget_max=&configuration=` → the agent quotes **live inventory from your Firebase property dashboard**. Never a stale price, never a sold unit offered. This eliminates most of your manual "sharing property details with potential buyers".
2. `GET /api/property/{code}/status` → truthful availability answers, 24/7, without you being reachable.
3. `POST /api/site-visits` → the agent books a visit **directly into your CRM**, not just a Google Calendar. Strictly better than the Booking Tool for your purposes because the record lands in your system with the lead attached.
4. `POST /api/leads/{id}/notes` → the agent writes qualification notes into your CRM as it learns them. You stop reverse-engineering requirements from chat transcripts.
5. `GET /api/brochure?code=` → returns a signed Drive link. Pairs with the Google Drive API integration you already have on admin.threepin.in.
6. `POST /api/listing-enquiry` → seller-side capture. An owner who wants to list gets recorded as a listing opportunity, not a buyer lead.
7. `GET /api/emi?price=&down_payment=&rate=` → instant EMI answers, computed by your own service. One of the most common questions in Indian residential sales and a natural conversation-extender.
8. `GET /api/realtor-club/next-owner?zone=` → the agent asks your CRM who to assign. Your round-robin and availability logic stays in your code where you control it.

### Constraints to design around

- **GET and POST only.** No PATCH/PUT/DELETE. Model every write as a POST.
- **Parameter types limited to `int` and `str`.** No nested objects, no arrays, no file upload. Flatten everything; pass dates as ISO strings.
- Auth via static header only — issue a long-lived bearer token scoped to these read/write paths, and rate-limit it.
- **The agent decides when to call.** A vague Description field causes calls at the wrong moment. Write descriptions as precise trigger conditions, not feature summaries.
- Make endpoints idempotent — the agent may retry.

---

## 10. Non-API surfaces worth exploiting

| Tool | What it is | Strategic use for 3 PIN |
|---|---|---|
| **Sheet Tool** | Agent reads/writes one Google Worksheet (multiple tabs) | Zero-code two-way bridge. Your CRM writes a "live availability" tab; agent reads it. Good stopgap before you build API Tool endpoints. |
| **Booking Tool** | Google Calendar via OAuth, multi-calendar with labels; checks real availability before confirming | Site-visit scheduling. Label calendars per Realtor Club partner/zone so the agent books the right person. Bookings also appear in the webhook `data` payload. |
| **Events Tool** | Reads calendars, shares upcoming events | Open-house schedules, project walkthrough slots — agent answers "when is the next site visit for Anna Nagar?" |
| **Documents Tool** | Knowledge base upload with a "when to use this" description | TN stamp duty and registration FAQs, society rules, your standard listing terms. Note: agent-facing knowledge only — keep Drive as the source of truth for actual legal documents. |
| **Media Tool** | Pre-uploaded files the agent can send (WhatsApp: image 5MB, PDF 100MB, video 16MB, audio 16MB) | Preload branded posters, brochures, property walkthrough videos. Labels + description control when the agent sends them. |
| **Catalog Tool** | **Phone-native PWA** — photograph, AI auto-detects attributes, live inventory with stock status | Worth a pilot. It is mobile-first, which matches how you actually work. "Other" category gives flexible custom attributes; stock status maps onto sold/available. |
| **Razorpay / QR Payment** | Payment collection in chat | Token advance / booking amount collection. Payments appear in the webhook `data` payload → feeds your finance module. |

### Agent Settings as free CRM infrastructure

Several things you would otherwise build are already configurable, and they shape what your webhooks deliver:

- **Lead statuses are Converted / Hot / Warm / Cold / Dead, with customisable definitions.** Redefine "Hot" as *"asked for a site visit date or shared a budget"* and the `on_hot` webhook becomes a genuinely reliable trigger. Most of your automation quality depends on getting these definitions right.
- **Manual tags** — create `Needs Site Visit`, `Loan Required`, `NRI`, `Owner-Listing`, `Budget Constraint`. These flow through to your CRM.
- **Lead Ownership + allotment strategy** (random or manual) — a built-in first draft of Realtor Club assignment.
- **Escalation, Basic vs Advance mode** — Advance escalates to **multiple teams by multiple criteria**, each notifying different admin WhatsApp numbers. This is zone-based partner routing with no code at all.
- **Autolock** with natural-language conditions.
- **Follow-up period in hours** — tune against the `total_followups` fatigue data from §1.
- **Notification triggers to admin WhatsApp numbers** — instant partner alerts, built in.
- **Timezone** — set to IST or your daily summaries and follow-up timing will be wrong.

---

## 11. Recommended architecture for admin.threepin.in

Given Firebase + Vercel + plain HTML with inline JS:

```
Vercel serverless functions (Node)
├── /api/tt/lifecycle      ← webhook: first_message, on_warm, on_hot, on_converted
├── /api/tt/messages       ← webhook: every_message  (high volume)
├── /api/tt/qualify        ← webhook: custom triggers (budget, locality, owner-listing)
├── /api/tt/send-template  → wrapper over send_whatsapp_template_message
├── /api/tt/reconcile      ← Vercel Cron, nightly: get_leads + get_contacts upsert
└── /api/agent/*           ← endpoints the TailorTalk API Tool calls (properties, visits, notes)

Firestore
├── tt_leads      (external_id = get_leads `id`; phone/IG username as alt key)
├── tt_messages   (append-only chat history from every_message)
├── tt_events     (raw webhook envelopes — keep forever, cheap insurance)
└── tt_outbound   (message_id, template, status, polled at +1h and +24h)
```

**Non-negotiable: the agent token never goes in client-side HTML.** Your current pages use inline JS with the Firebase script API. The TailorTalk token must live only in a Vercel environment variable, accessed from serverless functions. Anyone opening view-source on admin.threepin.in must not be able to read it.

**Return 200 within a second.** Write the raw envelope to `tt_events`, respond, then process asynchronously. Slow endpoints cause retries and duplicates.

---

## 12. On "ask questions about a lead and get a response"

Being direct: **there is no Q&A API.** The dashboard has an "Ask Me" lead-insights feature ("why are my leads not converting?"), but it is UI-only — nothing in the documentation exposes it as an endpoint.

You have three real paths, in increasing order of power:

1. **Custom webhook triggers as standing questions.** Each custom webhook is a natural-language question evaluated continuously against every conversation, with the answer pushed to you. Asynchronous, one question per webhook, and limited by your plan's webhook count — but it is genuine AI evaluation of lead conversations with zero infrastructure on your side.
2. **Store `chat_history` from `every_message`, then run your own LLM over it.** This gives you true on-demand Q&A — "what budget did this lead mention?", "summarise every Adyar enquiry this week" — answered from your own database with no dependency on TailorTalk. This is the right long-term build and it is not difficult.
3. **API Tool in reverse** for anything the agent should look up from you mid-conversation.

Path 2 is what you actually want. Path 1 buys you most of the value immediately while you build it.

---

## 13. Verify with TailorTalk before you build

These are the answers that will change your architecture. Get them in writing.

1. **Is `lead_contact` / `phone_number` genuinely masked in API responses, or was that documentation redaction?** If masked, `get_leads` cannot key your CRM and webhooks become mandatory rather than optional.
2. **Exact Sample Payload JSON** for each webhook trigger — specifically the structure of `chat_history`, `bookings`, `payments`. Pull it from the ⋮ menu; it is agent-specific.
3. **How many webhooks does your plan allow per agent?** This caps your custom-trigger strategy.
4. **Is there webhook request signing (HMAC) or a shared secret?** If not, confirm secret-in-URL is acceptable practice and ask for an IP allowlist.
5. **Rate limits** on `get_leads`, `get_contacts`, `send_whatsapp_template_message`, `add_match_image`.
6. **Is there any endpoint to fetch chat history on demand?** If not, confirm that a missed `every_message` webhook is permanently unrecoverable.
7. **Is there a create/update-contact endpoint** to write custom attributes from your CRM into TailorTalk? The contacts doc references attributes "added via CSV or API" but no such API is published.
8. **Can `lead_status` be set to anything other than converted via API?** (e.g. marking a lead Dead from your CRM.)
9. **Webhook retry count and backoff schedule** — how long do you have to recover a downed endpoint?
10. **Identity model across channels:** Instagram leads key on username, WhatsApp on phone. Confirm whether one human contacting on both channels becomes one lead or two.
11. **Does `every_message` fire on outbound agent messages as well as inbound lead messages?**
12. Token scope and rotation — can you issue more than one agent token, and can you revoke one without downtime?

---

## 14. Suggested build order

| Phase | Build | Outcome |
|---|---|---|
| **1** | Custom attributes on agent + status definitions + timezone | Leads arrive qualified, not just logged |
| **2** | `/api/tt/lifecycle` webhook + Firestore `tt_leads` | Real pipeline visibility. Ends the WhatsApp-Business-as-CRM era |
| **3** | `/api/tt/messages` + `tt_messages` | Conversation history preserved. Enables everything later |
| **4** | Nightly `get_leads` / `get_contacts` reconcile | Makes the webhook feed trustworthy |
| **5** | `send_whatsapp_template_message` wrapper + `lock_lead` | Follow-ups and reassignment from your CRM, on your phone |
| **6** | Custom webhooks: budget, locality, **owner-listing** | Seller leads separated from buyer leads automatically |
| **7** | API Tool endpoints (property search, availability, site visits) | Agent sells from live inventory without you |
| **8** | `add_match_image` auto-sync from property dashboard | Screenshot-to-listing identification; post-level content ROI |
| **9** | Your own LLM Q&A layer over `tt_messages` | "Ask anything about any lead" — built on your data |
