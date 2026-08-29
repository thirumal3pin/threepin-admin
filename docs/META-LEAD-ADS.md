# Meta Lead Ads — Integration Reference

**Endpoint (planned):** `https://admin.threepin.in/api/meta-webhook`
**Who it's for:** the developer wiring this up, and the owner running the
Meta-side setup.
**What it does:** turns Facebook and Instagram lead-form submissions into CRM
leads automatically, instead of agents re-typing them from Leads Center.

> Companion guides: [`CRM.md`](CRM.md) (the CRM itself),
> [`SOP.md`](SOP.md) (access, ops, incidents).
> Step-by-step setup runbook: see the shared runbook link in the project notes.
> Written **29 Aug 2026**. Meta facts verified against Meta's developer docs
> the same day; Graph API **v25.0**.

---

## Contents

1. [Status — read this first](#1-status--read-this-first)
2. [Account and app identifiers](#2-account-and-app-identifiers)
3. [How it will work](#3-how-it-will-work)
4. [Environment variables](#4-environment-variables)
5. [Field mapping](#5-field-mapping)
6. [What has to be built](#6-what-has-to-be-built)
7. [Meta-side setup checklist](#7-meta-side-setup-checklist)
8. [Hard constraints you cannot design around](#8-hard-constraints-you-cannot-design-around)
9. [Open decisions](#9-open-decisions)
10. [Troubleshooting](#10-troubleshooting)
11. [Corrections to older docs](#11-corrections-to-older-docs)

---

## 1. Status — read this first

**Not deployed.** No lead has ever arrived through this path.

| Piece | State |
|---|---|
| Meta app | **Created** — app type Business |
| System User + token | **Partially done** — asset assignment in progress |
| Leads Access granted | **Pending** |
| Business Verification | **Done** — confirm it is on portfolio `2207663012585689` |
| App Review | **Not started** — now unblocked |
| `api/meta-webhook.js` | **Written and tested** — 37/37 diagnostic checks pass |
| `api/meta-reconcile.js` | **Written** — daily cron at 01:00 UTC |
| `scripts/check-meta-lead-ads.js` | **Written** — full integration diagnostic |
| Deploy | **Not deployed yet** |
| Webhook subscription | **Not configured** |

Run the diagnostic any time — after a credential rotation, or whenever leads
stop arriving:

```
node scripts/check-meta-lead-ads.js
```

It checks the live Meta connection (token scopes, Page, Instagram linkage,
Leads Access, ad account), Firestore (pipeline, routing, leads), and every
branch of the ingest workflow against mocks — no writes, no Graph calls in the
workflow section.

A working single-tenant version of the endpoint exists in git history and is the
starting point rather than a blank file:

```
git show 60c2d78^:api/meta-webhook.js
```

It was removed in `60c2d78` *"Merge brochure endpoints into one function, drop
unused Meta/WhatsApp routes."* It is structurally correct — HMAC verification,
`hub.challenge` handshake, Graph API fetch, Firestore write — but predates the
multi-tenant migration. See [section 6](#6-what-has-to-be-built).

---

## 2. Account and app identifiers

None of these are secret. Secrets live only in Vercel env vars — see
[section 4](#4-environment-variables).

| Thing | Name | ID |
|---|---|---|
| Business portfolio | realtor chennai | `2207663012585689` |
| Meta app | — | `4276458589245740` |
| Facebook Page | Realtor chennai | `341092613310217` |
| Ad account | 3Pin (owned by Realtor chennai) | `act_689659773970470` |
| Firebase project | pin-realty | — |
| CRM tenant | 3 PIN Realty | `t_3pinrealty` |

> **The ad account needs the `act_` prefix in Graph API calls.** The bare number
> returns nothing rather than erroring.

> **This is a different portfolio from the main 3 PIN Realty business.** The ads
> project runs its own portfolio, Page and Instagram account. That is fine — but
> everything must stay inside *one* portfolio (see
> [section 7](#7-meta-side-setup-checklist)), and Business Verification applies
> to **this** portfolio, not the 3 PIN Realty one.

---

## 3. How it will work

```
Someone submits an instant form on Facebook or Instagram
  → Meta POSTs /api/meta-webhook          (identifiers only, no PII)
  → verify X-Hub-Signature-256 vs META_APP_SECRET
  → resolve tenant: waPages/{page_id}.tenantId
  → GET /v25.0/{leadgen_id}               (the actual field data)
  → dedupe on phoneKey()
  → write leads/{id} + notes/ + history/  (Admin SDK, bypasses rules)
  → onSnapshot pushes it to every open CRM board in realtime
```

**The webhook carries no personal data.** It delivers only `leadgen_id`,
`page_id`, `form_id`, `ad_id` and `created_time`. The details require a second
authenticated Graph call. That is why the token matters as much as the webhook.

Instagram leads arrive through this **same** Page subscription — there is no
separate Instagram webhook. The lead object's `platform` field distinguishes
them. The Instagram account must be linked to the Page.

---

## 4. Environment variables

Set in Vercel for Production, then **redeploy** — env changes do not apply to
existing deployments.

| Variable | Secret? | Source |
|---|---|---|
| `META_APP_ID` | no | App settings → Basic |
| `META_APP_SECRET` | **yes** | App settings → Basic |
| `META_VERIFY_TOKEN` | **yes** | Invented; must match the Webhooks config |
| `META_PAGE_ACCESS_TOKEN` | **yes** | System User token, expiry **Never** |
| `META_PAGE_ID` | no | `341092613310217` |

`META_APP_SECRET` signs **every** Meta webhook type, so the same value is reused
by `whatsapp-bot-webhook.js` and `data-deletion-callback.js`. Rotating it breaks
all three at once.

Use a **System User** token, never a Page token. A Page token expires in 60 days
and fails silently — leads simply stop and nothing alerts anyone.

---

## 5. Field mapping

**Not final** — pending the live form structure. Get it with:

```
GET /{page-id}/leadgen_forms?fields=id,name,status,questions
```

Meta keys each answer by the question's internal name, so the mapping must be
written against the real forms rather than guessed.

### What the CRM requires

`readLeadForm()` in `crm-assets/app.js` requires **channel, name, phone,
enquiryType, propertyInterest**. A default Meta form supplies name, email and
phone only.

| CRM field | From Meta | Notes |
|---|---|---|
| `name` | `full_name` | Fall back to `first_name + last_name` |
| `phone` | `phone_number` | E.164; `phoneKey()` normalises it to match manual entry |
| `email` | `email` | Optional in the CRM |
| `propertyInterest` | **custom question** | **Required by the CRM — absent from a default form.** Either add a property question, or map `form_id` → property name |
| `budget` | custom question | Feeds Open Pipeline Value; multiple choice parses better than free text |
| `enquiryType` | — | Default `Property Enquiry` |
| `channel` | `platform` | Open decision — see [section 9](#9-open-decisions) |
| `source` | — | Always `meta` |
| `stageId` | — | First stage of `pipelines/{tenantId}` |
| `tenantId` | — | From `waPages/{page_id}` |

### Worth storing beyond the CRM fields

`GET /v25.0/{leadgen_id}` also returns `campaign_id`, `campaign_name`,
`adset_id`, `ad_id`, `platform`, `is_organic` and `custom_disclaimer_responses`.

Keep them. That is ad-level attribution manual entry can never produce — it is
what would eventually let Analytics tie a closed deal back to the specific ad
that generated it.

---

## 6. What has to be built

In priority order.

### 6.1 Stored-XSS audit — done, and the old warning was stale ✅

Audited 29 Aug 2026. **Every render path already escapes.** The known-issues
entry claiming otherwise (in `User manual/README.md`) predates a fix that was
never documented.

| Path | Line | Treatment |
|---|---|---|
| Board card — name, phone, type, property | 603–610 | `escapeHtml()` |
| List view | 750–754 | `escapeHtml()` |
| Follow-ups, incl. last-note preview | 819–828 | `escapeHtml()` |
| Detail panel | 1538–1542 | `escapeHtml()` |
| Note text | 1655 | `escapeHtml()` |
| AI summary | 365–368 | `escapeHtml()` |
| **Meta raw-fields block** | 1559 | **`textContent`** — cannot render markup at all |

The two `confirm()` calls and the export's `notesSummary` interpolate raw values
but are plain text, not HTML.

One hardening was added: the webhook strips everything outside `[A-Za-z0-9_-]`
from `leadgen_id` when building the doc id, because `leadCardHtml` interpolates
a lead's id into an inline `onclick`. Meta signs the payload so the value is
already trusted — this just removes the assumption.

### 6.2 Restore and multi-tenant the webhook

The archived version needs four corrections:

| Archived code does | Must do instead |
|---|---|
| Omits `tenantId` | Write it — the board query filters on it, so leads are invisible without it |
| Reads `config/pipeline` | Read `pipelines/{tenantId}` |
| `notes: []` / `history: []` inline | Write to the `notes` / `history` **subcollections** |
| Hardcodes one tenant | Resolve via `waPages/{page_id}` |
| Pins Graph `v21.0` | `v25.0` |

`firestore.rules` already reserves `waPages/{pageId}` as server-only. Nothing
reads or writes it yet — it is a scaffolded slot waiting for exactly this.

Seed it:

```js
waPages/341092613310217 = { tenantId: 't_3pinrealty', pageName: 'Realtor chennai' }
```

Create the parent lead doc **before** its notes/history, since the subcollection
rules check the parent's `tenantId`.

### 6.3 Server-side duplicate detection

`findLeadByPhone()` is client-side only, so a repeat enquirer would create a
second lead with no merge prompt. Reuse the `phoneKey()` normalisation — Meta
returns E.164, which normalises to the same key as a hand-typed number, so this
works cleanly once implemented.

### 6.4 Daily reconciliation cron — built ✅

`api/meta-reconcile.js`, wired into `vercel.json` at **01:00 UTC daily**.

Walks every ACTIVE form, lists the leads Meta still holds (default: last 7 days,
`?days=` up to 90), and ingests anything the webhook missed. Guarded by
`CRON_SECRET`; `?dryRun=1` reports without writing.

Idempotent — leads are keyed `meta_<leadgen_id>` and existing docs are skipped
on a single cheap read, so re-running is always safe.

**Read the logs when it recovers anything.** A non-zero `ingested` count means
the webhook missed a lead, which is the only signal you will get that the
webhook needs attention — it logs a `console.warn` specifically so that shows up.

Run it by hand:

```
curl "https://admin.threepin.in/api/meta-reconcile?dryRun=1&days=30" \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

## 7. Meta-side setup checklist

Everything below must be in the **realtor chennai** portfolio
(`2207663012585689`). Cross-portfolio setups fail in confusing ways rather than
with a clear error.

- [ ] App owned by the portfolio (`Business settings → Accounts → Apps`)
- [ ] Page **Realtor chennai** owned by the portfolio
- [ ] Instagram account **linked to that Page** (or IG leads never arrive)
- [x] Ad account **owned** by Realtor chennai, not merely shared in via Partners
- [ ] System User created, with three assets:
      **App** → Develop app · **Page** → Full control · **Ad account** → Manage campaigns
- [ ] Token generated, expiry **Never**, six permissions:
      `leads_retrieval`, `pages_show_list`, `pages_read_engagement`,
      `pages_manage_metadata`, `pages_manage_ads`, `ads_management`
- [ ] **Leads Access granted** — `Business settings → Integrations → Leads access`
- [x] Business Verification — **done**; confirm it is on this portfolio
- [ ] Webhook: Page object, `leadgen` field, callback + verify token
- [ ] `POST /341092613310217/subscribed_apps?subscribed_fields=leadgen`
- [ ] App Review passed for `leads_retrieval` + `pages_manage_ads`
- [ ] App Mode switched to **Live**

**Business Verification legal name.** The portfolio is called *realtor chennai*,
but verification checks a **legal entity**. Enter the legal name and address
exactly as they appear on the GST certificate or incorporation document, even
when that differs from the portfolio's display name. A mismatch here is the most
common rejection.

---

## 8. Hard constraints you cannot design around

**App Review is mandatory.** Meta has not delivered Lead Ads data to apps in
Development mode since **1 February 2019**. Development mode gives you the Lead
Ads Testing Tool and fake leads only. There is no exemption for using your own
Page with your own app.

**Business Verification gates App Review** and applies per portfolio. Already
done here — which removes the longest wait from this project. The only remaining
gate is App Review itself (typically 3–15 days), so the critical path is now
build → test → submit.

**The 90-day deletion is absolute.** Lead data is unrecoverable after 90 days —
not through support, not through the API. Once this is live the CRM becomes the
only durable copy of your own leads, which makes the reconciliation cron and
Firestore backups load-bearing rather than nice-to-have.

**Silence is ambiguous.** A quiet Monday and a broken webhook look identical
from the board. Check Vercel function logs before assuming a slow day.

---

## 9. Open decisions

Each changes the code. None block the Meta-side setup.

| Decision | Options |
|---|---|
| **Which tenant?** | Existing `t_3pinrealty` board, or a new tenant for Realtor Chennai. The `waPages` table supports either, and both Pages can coexist later. |
| **Channel value** | Split `platform` into Facebook / Instagram (accurate channel-mix analytics, adds a `facebook` channel), a single `Meta Ads` channel, or reuse the existing `instagram`. |
| **Landing stage** | First pipeline stage, or a dedicated stage so ad leads are visually distinct. |
| **Auto follow-up** | Set `followUpAt` automatically (ad leads go cold fast), or leave it to agents as manual leads do. |

---

## 10. Troubleshooting

Ordered by how often each actually happens.

| Symptom | Cause | Fix |
|---|---|---|
| Leads arrive with empty name and phone | Leads Access never granted | Grant it. Webhook and logs look perfectly healthy in this state |
| Nothing from real ads, test leads fine | App still in Development mode | Switch App Mode to Live. Approval does not flip it for you |
| Leads in Firestore, absent from the board | `tenantId` missing | The board query filters by tenant — this is the archived webhook's bug |
| Webhook verification fails on save | Endpoint not deployed, or token mismatch | Deploy first, then configure; match `META_VERIFY_TOKEN` exactly |
| Worked for weeks, then stopped | Page token expired (60 days) | Regenerate as a System User token, expiry Never |
| Every lead missing its property | Form has no property question | Add it. Already-collected leads cannot be backfilled |
| App missing from token dropdown | App not assigned as a System User asset | Add Assets → Apps → Develop app, then reload |
| Instagram leads never arrive | IG account not linked to the Page | Link it; there is no separate IG webhook |
| Verification rejected | Legal name/address mismatch | Match the documents exactly; GSTIN active and mapped to that name |

---

## 11. Corrections to older docs

Three places in this repo are wrong or stale on this subject. Fix them when the
integration ships.

- **`crm-assets/README.md`** claims you do *not* need App Review and can retrieve
  leads indefinitely in Development mode. **This is wrong** and has been since
  Feb 2019. Following it leads to a dead end.
- **`docs/SOP.md`** lists `META_APP_ID` / `META_APP_SECRET` /
  `META_EMBEDDED_SIGNUP_CONFIG_ID` as "set". They were not — no code has ever
  read a Lead Ads variable, and no app existed until Aug 2026.
- **`docs/CRM.md`** and **`User manual/README.md`** describe Lead Ads intake as
  not deployed, and `meta-webhook.js` as legacy. Correct once shipped.

One thing older docs get right and is worth keeping: the note in
`User manual/README.md` that `meta` leads omit `tenantId`. That is exactly the
bug [section 6.2](#62-restore-and-multi-tenant-the-webhook) exists to fix.
