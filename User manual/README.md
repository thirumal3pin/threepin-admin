# 3 PIN Realty — Admin Dashboard + CRM (`admin.threepin`)

Internal admin console for **3 PIN Realty**, a real-estate business in Chennai.
This repo powers `https://admin.threepin.in` (and the default
`https://threepin-admin.vercel.app`).

> This is the **developer + operator manual**. The short root `README.md`
> covers only first-time GitHub/Vercel/DNS setup. Non-technical, phone-friendly
> runbooks live next to this file in [`SOP.md`](SOP.md).

> **Read this first — the stack is not what you might assume.**
> There is **no Next.js, no React, no build step, no bundler**. The frontend is
> **plain static HTML + vanilla JavaScript** served directly by Vercel. The
> only server-side code is a set of **Vercel serverless functions** in `api/`
> using the Web `Request`/`Response` API. Data lives in **Firebase Firestore**;
> the CRM uses **Firebase Authentication**.
>
> Paths below are relative to the **repo root** (one level up from this folder).

---

## Table of contents

1. [Project overview](#1-project-overview)
2. [Tech stack](#2-tech-stack)
3. [Architecture](#3-architecture)
4. [Project structure](#4-project-structure)
5. [Core features & user flows](#5-core-features--user-flows)
6. [Data model](#6-data-model)
7. [Authentication & authorization](#7-authentication--authorization)
8. [API reference](#8-api-reference)
9. [Environment variables](#9-environment-variables)
10. [Local setup — quickstart](#10-local-setup--quickstart)
11. [Deployment (Vercel)](#11-deployment-vercel)
12. [External dependencies & integrations](#12-external-dependencies--integrations)
13. [Troubleshooting](#13-troubleshooting)
14. [Known issues & technical debt](#14-known-issues--technical-debt)
15. [Maintenance & operations](#15-maintenance--operations)
16. [How to extend](#16-how-to-extend)
17. [Glossary](#17-glossary)
18. [Traceability index — "if I change X, what breaks?"](#18-traceability-index--if-i-change-x-what-breaks)
19. [NEEDS VERIFICATION checklist](#19-needs-verification-checklist)

---

## 1. Project overview

`admin.threepin` is the private back-office for a Chennai real-estate brokerage.
It bundles two independent single-page apps plus a small serverless backend:

- **Lead CRM** (`crm.html`) — a Kanban + list pipeline for buyer enquiries:
  add/edit leads, move them through stages, log notes and follow-ups, get a daily
  follow-up digest over WhatsApp/email, auto-generate a per-lead AI summary,
  export to Excel, and (optionally) connect a WhatsApp Business number and AI bot.
  Protected by **real Firebase Authentication** and is **multi-tenant** (each
  business = one `tenantId`; data is isolated).
- **Property Intelligence Dashboard** (`dashboard.html`) — a catalogue of ~46
  property listings with search/filter/compare/export, sales talking points, and
  per-browser notes/favorites. Protected only by a **client-side hardcoded
  password gate** (not real auth) and is **single-tenant with open Firestore
  rules** (see [Known issues](#14-known-issues--technical-debt)).
- **Public landing page** (`index.html`) — brochure page with a cosmetic "Admin
  login" modal that does nothing but link to the two apps.

The problem it solves: keep every buyer lead and every property listing "on
record" in one place, shared in realtime across the team, without standing up a
heavyweight app or backend.

---

## 2. Tech stack

| Layer | Technology | Version | Why it's used here |
|---|---|---|---|
| Frontend | Plain HTML + vanilla JS (ES modules) | — | No build step; Vercel serves static files directly. Each page is a thin HTML shell + a few JS files. |
| Frontend data/auth SDK | Firebase JS SDK (CDN) | `12.16.0` | Loaded from `gstatic.com` in `firebase-sync.js`. Firestore realtime (`onSnapshot`) + Email/Password auth. |
| Spreadsheet export | SheetJS (`xlsx`) | `0.18.5` (CDN) | CRM "Export Leads" → `.xlsx`. Loaded from cdnjs in `crm.html`. |
| PDF text extraction | `pdf.js` | `3.11.174` (CDN) | CRM knowledge-base PDF upload → text. Loaded from cdnjs in `crm.html`. |
| Meta JS SDK | Facebook `sdk.js` (`v21.0`) | CDN | WhatsApp Embedded Signup popup (`FB.login`) in `crm.html`. |
| Backend | Vercel Serverless Functions (Node, ES modules) | — | Files in `api/` export `GET`/`POST`/`DELETE` handlers using Web `Request`/`Response`. `package.json` has `"type": "module"`. |
| Backend Firebase | `firebase-admin` | `^14.2.0` | Server-side Firestore/Auth from serverless functions and CLI scripts. Bypasses security rules by design. |
| AI | `@anthropic-ai/sdk` | `^0.112.2` | Per-lead AI summaries via Claude Haiku (`claude-haiku-4-5-20251001`). **Bot replies are currently disabled** — see note below. |
| Email | `nodemailer` | `^9.0.3` | Daily follow-up digest email via Gmail SMTP. |
| Hosting / CI-CD | Vercel | — | Auto-deploys on push to `main`. One cron job (`vercel.json`). |
| Database | Firebase Firestore | project `pin-realty` | All shared data. Security rules in `firestore.rules`. |
| Auth (CRM) | Firebase Authentication (Email/Password) | — | Real login + `tenantId` custom claim for tenant isolation. |
| Local dev server | `live-server` | `^1.2.2` | `npm start` static server on port 5173 (does **not** run `api/`). |
| Dependency override | `jose` | `^5.10.0` | Pinned via `overrides` (transitive dep of firebase-admin). |

> **Two Anthropic models, one disabled feature.** AI **lead summaries** are live
> (`claude-haiku-4-5-20251001`, see `api/_lead-summary-shared.js`). The AI
> **WhatsApp bot** and the CRM's **"Live Test Chat"** are intentionally switched
> off in code today — `api/whatsapp-bot-webhook.js` sends a static acknowledgement
> and `api/bot-test-message.js` returns a canned "turned off" reply.
> `ANTHROPIC_API_KEY` stays set but is only spent on summaries. Comments in those
> files explain how to re-enable Claude.

---

## 3. Architecture

```mermaid
flowchart TD
  subgraph Browser
    IDX[index.html landing]
    CRM[crm.html + crm-assets Lead CRM]
    DASH[dashboard.html + dashboard-assets Property Dashboard]
  end

  subgraph Vercel
    STATIC[Static file hosting]
    API[Serverless functions api/*.js]
    CRON[Cron 03:30 UTC daily to /api/followup-digest]
  end

  subgraph Firebase [Firebase project pin-realty]
    AUTH[Firebase Auth Email/Password + tenantId claim]
    FS[(Firestore)]
  end

  subgraph External
    META[Meta Graph / WhatsApp Cloud API]
    ANTH[Anthropic Claude API]
    GMAIL[Gmail SMTP]
    GDOCS[Google Docs/Sheets public export]
  end

  IDX --> CRM
  IDX --> DASH
  CRM -->|Firebase JS SDK realtime| FS
  CRM -->|login| AUTH
  DASH -->|Firebase JS SDK realtime NO auth| FS
  CRM -->|fetch + ID token| API
  STATIC -.serves.-> Browser
  API -->|firebase-admin| FS
  API -->|verify ID token| AUTH
  API --> META
  API --> ANTH
  API --> GMAIL
  API --> GDOCS
  CRON --> API
  META -->|webhooks| API
```

### Request walkthrough (end to end)

**A CRM user edits a lead:**
1. Browser loads `crm.html` → `crm-assets/firebase-sync.js` (ES module) inits the
   Firebase JS SDK with the public `firebaseConfig` and calls `onAuthStateChanged`.
2. User logs in (Email/Password). The SDK returns an ID token carrying a
   `tenantId` custom claim. `firebase-sync.js` subscribes to
   `leads where tenantId == <claim>` via `onSnapshot`.
3. User drags a card / saves an edit in `crm-assets/app.js`. State mutates in
   memory, then `persistLead(l)` writes the doc back with `setDoc` (client-side,
   governed by `firestore.rules`).
4. `persistLead` also debounces (~5s) a `fetch('/api/generate-lead-summary')` with
   `Authorization: Bearer <idToken>`.
5. The serverless function verifies the token with `firebase-admin`, re-reads the
   lead, calls Claude Haiku, and writes `aiSummary` back to Firestore.
6. The write triggers the browser's `onSnapshot` listener → `applyLeadsSnapshot`
   re-renders. Every other open tab on the same tenant updates in realtime.

**An inbound WhatsApp message (when connected):**
Meta → `POST /api/whatsapp-bot-webhook` → HMAC signature verified against
`META_APP_SECRET` → `resolveTenantByPhoneNumberId` looks up `waNumbers/{id}` →
creates/updates a `leads` doc (`source: 'whatsapp_bot'`) and a
`conversations/{tenantId}_{phone}` doc → sends a static acknowledgement back via
the WhatsApp Cloud API.

---

## 4. Project structure

```
.
├── index.html                     Public landing page + cosmetic admin modal
├── crm.html                       Lead CRM shell (loads crm-assets/*)
├── dashboard.html                 Property dashboard shell (loads dashboard-assets/*)
├── dash-copy.html                 ⚠️ ORPHAN — 88KB older dashboard copy, not referenced anywhere
├── privacy-policy.html            Draft privacy policy (linked from Meta App config)
├── terms.html                     Draft terms of service (linked from Meta App config)
├── logo.jpg                       Brand logo used by all pages / favicons
├── README.md                      Short root readme: GitHub/Vercel/DNS first-time setup
├── package.json                   Deps + live-server scripts; "type": "module"
├── vercel.json                    Cron: /api/followup-digest at 03:30 UTC daily
├── firestore.rules                Firestore security rules (NOT auto-deployed)
├── .gitignore                     Ignores node_modules, .vercel, .env*, *firebase-adminsdk*.json
│
├── User manual/                   ← YOU ARE HERE
│   ├── README.md                  This full developer + operator manual
│   └── SOP.md                     Non-technical, phone-friendly runbooks
│
├── crm-assets/                    Everything crm.html loads
│   ├── app.js                     ~2000 lines: board/list/follow-ups, modals, notes,
│   │                              export, stage manager, digest, bot editor, KB, auth glue
│   ├── firebase-sync.js           Firebase init, Email/Password auth, tenant-scoped realtime sync
│   ├── sample-leads.js            10 sample Chennai leads (seeded once per tenant)
│   ├── style.css                  All CRM styling
│   └── README.md                  CRM-specific setup notes (Meta/WhatsApp/Firebase)
│
├── dashboard-assets/              Everything dashboard.html loads
│   ├── app.js                     Filters, cards, add/edit/delete, compare, export, notes
│   ├── auth.js                    ⚠️ CLIENT-SIDE password gate with hardcoded passwords
│   ├── firebase-sync.js           Firebase init + realtime sync (NO auth) for `properties`
│   ├── sample-data.js             46 starter properties (seeded once via meta/seeded)
│   ├── style.css                  All dashboard styling
│   └── README.md                  Dashboard-specific notes
│
├── api/                           Vercel serverless functions (Web Request/Response)
│   ├── _bot-shared.js             Shared: getDb(), verifyCrmUser(), prompt builder,
│   │                              WhatsApp creds resolver, tenant resolver, DEFAULT_BOT_CONFIG
│   ├── _lead-summary-shared.js    Shared prompt/guardrails for lead summaries (Haiku)
│   ├── generate-lead-summary.js   POST — regenerate ONE lead's AI summary (auth)
│   ├── backfill-lead-summaries.js POST — bulk-generate summaries for a tenant (auth)
│   ├── bot-test-message.js        POST — CRM test chat (auth) — currently returns canned reply
│   ├── whatsapp-bot-webhook.js    GET verify / POST inbound WA messages (HMAC) — static reply
│   ├── whatsapp-embedded-signup.js POST connect / DELETE disconnect WhatsApp (auth)
│   ├── meta-webhook.js            GET verify / POST Facebook-Instagram Lead Ads (HMAC) — LEGACY
│   ├── knowledge-sync.js          GET/POST — bot knowledge base connectors (auth)
│   ├── followup-digest.js         GET (cron, CRON_SECRET) + POST (auth) — WA/email digest
│   ├── public-config.js           GET — serves non-secret Meta App ID / Config ID to client
│   ├── data-deletion-callback.js  POST — Meta data-deletion compliance callback (HMAC)
│   └── data-deletion-status.js    GET — human-facing status page for the above
│
├── scripts/                       Admin CLI scripts (run locally with a service-account key)
│   ├── create-tenant.js           Provision a brand-new tenant (business) + owner login
│   ├── add-team-member.js         Add another login to an EXISTING tenant
│   ├── migrate-existing-tenant.js One-off: migrate the original single-tenant data → t_3pinrealty
│   └── connect-whatsapp-manual.js Manually wire a WhatsApp number to a tenant (bypass popup)
│
├── docs/
│   └── SOP.md                     Developer-facing operating manual (multi-tenant platform)
│
└── .vercel/project.json           Vercel project link (projectName: threepin-admin)
```

> The Firebase service-account JSON (referenced by scripts as
> `api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json`) is **git-ignored**
> and must be supplied locally — see [Local setup](#10-local-setup--quickstart).

---

## 5. Core features & user flows

### 5.1 CRM login / auth (Firebase)

- **What:** Email/Password login gating the whole CRM; resolves a `tenantId`
  custom claim used to scope every read/write.
- **Flow:**
  1. `crm.html` shows the login screen; `attemptCrmLogin()` calls
     `window.crmAuth.login(email, password)`.
  2. `firebase-sync.js`'s `onAuthStateChanged` fires; it force-refreshes the ID
     token (`getIdTokenResult(true)`) to pick up a freshly-set `tenantId` claim.
  3. If `tenantId` exists → `subscribeToData(tenantId)` (seeds pipeline/settings/
     sample leads if empty, then attaches realtime listeners). If not → a console
     error ("no tenantId claim yet — finish onboarding").
  4. `onCrmAuthChange` shows `#appRoot`, hides the login screen.
- **Files:** `crm.html`, `crm-assets/app.js` (`attemptCrmLogin`, `crmLogout`,
  `onCrmAuthChange`), `crm-assets/firebase-sync.js`.
- **Data:** `users/{uid}` (role/tenant), Auth custom claim `tenantId`.

```mermaid
sequenceDiagram
  actor U as User
  participant CRM as crm.html / app.js
  participant FB as Firebase Auth
  participant SYNC as firebase-sync.js
  participant FS as Firestore
  U->>CRM: enter email + password
  CRM->>FB: signInWithEmailAndPassword
  FB-->>SYNC: onAuthStateChanged(user)
  SYNC->>FB: getIdTokenResult(true)
  FB-->>SYNC: claims.tenantId
  alt has tenantId
    SYNC->>FS: onSnapshot(leads where tenantId == claim)
    FS-->>CRM: leads snapshot then render board
  else no tenantId
    SYNC-->>CRM: console error (not onboarded)
  end
```

### 5.2 Lead management (create / edit / delete / stage)

- **What:** Add leads manually (channel, name, phone, enquiry type, property
  interest, budget, follow-up), edit them, delete them, and move them through
  pipeline stages via drag-and-drop, a "→ next stage" button, or the detail
  dropdown. Every change appends to an in-doc `history[]` and bumps `updatedAt`/
  `updatedBy`.
- **Flow (create):** `openAddLeadModal()` → fill form → `saveLeadModal()`
  validates required fields (channel, name, phone, enquiry type, property) →
  builds a lead object with `source: 'manual'` → `leads.unshift` + `persistLead()`
  → toast + board refresh.
- **Files:** `crm-assets/app.js` (`saveLeadModal`, `openEditLeadModal`,
  `deleteLead`, `changeStage`, `persistLead`), `crm-assets/firebase-sync.js`
  (`saveLead`, `deleteLead`).
- **Data:** `leads` collection (see [Data model](#6-data-model)); `pipelines/{tenantId}`
  for stage definitions.

```mermaid
flowchart LR
  A[openAddLeadModal] --> B[saveLeadModal]
  B -->|validate| C{valid?}
  C -- no --> B
  C -- yes --> D[build lead source=manual]
  D --> E[leads.unshift + addHistory created]
  E --> F[persistLead to crmFirebase.saveLead]
  F --> G[setDoc leads doc + tenantId]
  F --> H[debounce 5s to /api/generate-lead-summary]
  G --> I[onSnapshot to applyLeadsSnapshot re-render]
```

### 5.3 Notes, follow-ups & follow-up digest

- **What:** Per-lead notes (`notes[]`), a single "next follow-up" timestamp
  (`followUpAt`), a "Log Follow-up" modal that records what happened and sets the
  next follow-up in one step, and a **daily digest** of overdue + next-3-days
  follow-ups sent over WhatsApp and/or email at 9:00 AM IST.
- **Flow (digest):** Cron hits `GET /api/followup-digest` (auth via `CRON_SECRET`)
  → iterates every tenant in `pipelines` → reads each tenant's `settings/{tenantId}`
  for recipients → buckets that tenant's leads by IST day → sends WhatsApp (Cloud
  API) and/or email (nodemailer/Gmail). The CRM's "Send Digest Now" button does the
  same for one tenant via `POST` (Firebase auth).
- **Files:** `crm-assets/app.js` (`saveFollowUpLog`, `removeFollowUp`, digest
  manager, `sendDigestNow`), `api/followup-digest.js`.
- **Data:** `leads.followUpAt`, `leads.notes[]`, `settings/{tenantId}`
  (`followupDigestEnabled`, `followupDigestRecipients[]`,
  `followupDigestEmailEnabled`, `followupDigestEmails[]`).

### 5.4 AI per-lead summary

- **What:** A 3–4 line, ≤70-word Claude Haiku summary of each lead, auto-
  regenerated (debounced 5s) after any change, shown at the top of the detail
  panel. A "Backfill AI Summaries" menu item bulk-fills leads that lack one.
- **Flow:** `persistLead` → `scheduleSummaryRegeneration` → `POST
  /api/generate-lead-summary {leadId}` → server verifies auth + tenant ownership,
  builds a tightly-guardrailed prompt from the lead's own notes/history, calls
  Claude, writes `aiSummary`/`aiSummaryAt` (or `aiSummaryError` on failure).
- **Files:** `api/generate-lead-summary.js`, `api/backfill-lead-summaries.js`,
  `api/_lead-summary-shared.js`, `crm-assets/app.js` (`regenerateLeadSummary`,
  `runBackfillSummaries`, `renderAiSummary`).
- **Data:** `leads.aiSummary`, `aiSummaryAt`, `aiSummaryError`, `aiSummaryErrorAt`.

### 5.5 WhatsApp connect (Meta Embedded Signup) + AI bot editor

- **What:** Connect a WhatsApp Business number via Meta's Embedded Signup popup,
  configure a bot persona/steps/guardrails, and manage a knowledge base. **Bot
  auto-replies are disabled in code** — inbound messages get a static
  acknowledgement and still create/update a lead.
- **Flow (connect):** "Connect WhatsApp via Meta" → `FB.login(config_id=…)` popup
  → returns an OAuth `code` + `phone_number_id` → `POST
  /api/whatsapp-embedded-signup` exchanges the code server-side for a long-lived
  token → writes `botConfigs`, `waSecrets`, `waNumbers` and subscribes the app to
  the WABA's webhooks.
- **Files:** `crm.html`, `crm-assets/app.js` (`connectWhatsApp`,
  `handleFbLoginResponse`, `disconnectWhatsApp`, bot editor functions),
  `api/whatsapp-embedded-signup.js`, `api/whatsapp-bot-webhook.js`,
  `api/bot-test-message.js`, `api/knowledge-sync.js`.
- **Data:** `botConfigs/{tenantId}`, `waSecrets/{tenantId}`,
  `waNumbers/{phoneNumberId}`, `knowledgeConfigs/{tenantId}`,
  `conversations/{tenantId}_{phone}`.

### 5.6 Lead export (Excel)

- **What:** Export leads to `.xlsx` (SheetJS) filtered by All / Created today /
  Movement today / Date range. One sheet, 18 columns incl. flattened notes.
- **Files:** `crm-assets/app.js` (`openExportModal`, `getExportLeads`,
  `runExport`), `xlsx` CDN in `crm.html`.

### 5.7 Property dashboard (listings)

- **What:** Browse/search/filter/sort ~46 listings, compare, mark sold-out, add/
  edit/delete via a JSON-paste modal, per-browser notes/favorites/interest level,
  and print/brochure/CSV/JSON export.
- **Flow (add):** `openAddModal()` → paste JSON (template downloadable) →
  `savePModal()` parses + `normalizeProperty()` (accepts an alternate flat
  schema) → optimistic in-memory update → `dashboardFirebase.saveProperty()` →
  `setDoc properties/{id}` → realtime `onSnapshot` re-render (rolls back on error).
- **Files:** `dashboard.html`, `dashboard-assets/app.js`,
  `dashboard-assets/firebase-sync.js`, `dashboard-assets/auth.js`.
- **Data:** `properties` collection, `meta/seeded` marker. Favorites/notes/
  interest are `localStorage` only (per-browser, not synced).

### 5.8 Meta Lead Ads intake (legacy, single-tenant)

- **What:** Facebook/Instagram Lead Ads submissions become CRM leads.
- **Flow:** Meta → `POST /api/meta-webhook` (HMAC vs `META_APP_SECRET`) →
  `fetchLeadFields` via Graph API (`META_PAGE_ACCESS_TOKEN`) → writes a lead with
  `source: 'meta'`.
- ⚠️ **Legacy:** this endpoint reads the pre-multi-tenant `config/pipeline` doc
  and writes leads **without a `tenantId`** — so those leads will **not** appear
  in the tenant-filtered CRM board. See [Known issues](#14-known-issues--technical-debt).

---

## 6. Data model

Firestore project **`pin-realty`**. Two families of collections:

- **Per-tenant singletons** — the document ID *is* the `tenantId`
  (`botConfigs`, `knowledgeConfigs`, `pipelines`, `settings`, `leadsSeededFlags`).
- **Flat collections** — scoped by a `tenantId` **field** on each doc
  (`leads`, `conversations`).

> **Schema-flag:** Firestore is schemaless and these docs are written from
> multiple code paths (client, webhooks, scripts). Field presence varies — e.g.
> `whatsapp_bot` leads omit `channel`/`enquiryType`/`history`/`detailsSent`;
> `meta` leads omit `tenantId` today; `manual` leads carry the full set. Treat
> every field as optional in code.

### `leads` — one doc per buyer enquiry
Doc ID patterns: `lead_<ts>` (manual), `meta_<leadgenId>` (Lead Ads),
`lead_wa_<tenantId>_<digits>` (WhatsApp).

| Field | Type | Required | Description | Example |
|---|---|---|---|---|
| `id` | string | yes | Doc ID, duplicated in body | `lead_1737800000000` |
| `tenantId` | string | yes* | Owning tenant. *Absent on `meta`-source leads (bug). | `t_3pinrealty` |
| `name` | string | yes | Lead name | `Karthik Subramaniam` |
| `phone` | string | yes (manual) | Phone (any format; `+91` assumed for wa.me) | `98765 43211` |
| `email` | string | no | Email | `k@example.com` |
| `channel` | string | manual only | `call` \| `whatsapp` \| `instagram` | `call` |
| `enquiryType` | string | manual only | From `settings.enquiryTypes` | `Property Enquiry` |
| `propertyInterest` | string | yes (manual) | Free text | `3BHK in Adyar` |
| `budget` | string | no | Free text | `1.8 Cr` |
| `source` | string | yes | `manual` \| `meta` \| `whatsapp_bot` | `manual` |
| `stageId` | string | yes | References `pipelines.stages[].id` | `new` |
| `detailsSent` | boolean | no | "Sent Details" toggle | `false` |
| `notes` | array | yes | `{id, text, createdAt, by}` | `[…]` |
| `history` | array | manual/CRM | `{id, type, text, at, by}` audit log | `[…]` |
| `contactAt` | number (ms) | no | Time of contact | `1737…` |
| `followUpAt` | number (ms)\|null | no | Next follow-up | `1737…` |
| `createdAt` / `updatedAt` | number (ms) | yes | Timestamps | `1737…` |
| `createdBy` / `updatedBy` | string\|null | no | User email | `a@b.com` |
| `aiSummary` | string | no | Claude summary | `Karthik wants…` |
| `aiSummaryAt` | number | no | Summary time | `1737…` |
| `aiSummaryError` / `aiSummaryErrorAt` | string / number | no | Last summary failure | `429…` |
| `leadgenId` / `formId` / `adId` / `rawFieldData` | string / object | meta only | Meta Lead Ads metadata | — |
| `conversationId` | string | wa only | Phone of the WA conversation | `9198…` |

### `conversations` — one doc per WhatsApp thread
Doc ID: `<tenantId>_<phone>`. Fields: `tenantId`, `phone`, `messages[]`
(`{role, content, ts}`), `extractedInfo{}`, `status`, `createdAt`, `updatedAt`.
Server-only writes (webhook); client can read within tenant.

### `pipelines/{tenantId}` — Kanban stages
`{ stages: [{ id, name, color, order? }] }`. Defaults seeded:
New, Contacted, Site Visit, Negotiation, Closed Won, Closed Lost.

### `settings/{tenantId}` — CRM settings
`enquiryTypes[]`, `followupDigestEnabled`, `followupDigestRecipients[]`,
`followupDigestEmailEnabled`, `followupDigestEmails[]`.

### `botConfigs/{tenantId}` — bot persona + WA connection metadata
`role`, `welcomeMessage`, `requiredInfo[]`, `steps[]`, `guardrails[]`, `tone`,
`waPhoneNumberId`, `waPhoneNumber`, `waVerifiedName`, `waQualityRating`,
`waConnectedAt`.

### `knowledgeConfigs/{tenantId}` — bot knowledge base
`{ sources: [{ id, type, name, url, content, syncedAt, status }], updatedAt }`.
Per-source cap 20k chars; `content` never sent to the list view.

### `waNumbers/{phoneNumberId}` — routing table (server-only)
`{ tenantId, wabaId, connectedAt }`. Maps an inbound number → tenant.

### `waSecrets/{tenantId}` — WhatsApp token (server-only)
`{ token, updatedAt }`. Never client-readable (rules deny both directions).

### `users/{uid}` — user → tenant/role
`{ tenantId, email, businessName?, role ('owner'|'member'), createdAt }`.
Readable only by that same uid.

### `leadsSeededFlags/{tenantId}` — sample-lead seed marker
`{ done, at }`.

### `dataDeletionRequests/{code}` — Meta compliance audit log
`{ metaUserId, requestedAt, status }`.

### `properties` — dashboard listings (single-tenant, OPEN rules)
Free-form; common fields: `id, name, builder, location, type, config, status,
possession, startingPrice, pricePerSqft, contactName, contactNumber, totalUnits,
sqftRange, highlights, amenities, nearby, connectivity, vastu, soldOut, …`.
Accepts an alternate flat schema normalized by `normalizeProperty()`.

### `meta/{docId}` — dashboard seed marker (`meta/seeded`), OPEN rules

### `config/*` — **legacy** pre-multi-tenant singletons
`config/pipeline`, `config/whatsappBot`, `config/knowledge`. Superseded by the
per-tenant collections; still read by `api/meta-webhook.js`. Client read-only.

### Indexes & rules
- Security rules: `firestore.rules` (well-commented). **Not auto-deployed** —
  deploy manually.
- **Composite index:** the CRM query `leads where tenantId == X` is a single-field
  filter (no `orderBy`), so no composite index is required. If you ever add an
  `orderBy` to a filtered query, Firestore emits a one-click "create index" link
  in the console (see [Troubleshooting](#13-troubleshooting)).

---

## 7. Authentication & authorization

### CRM (`crm.html`) — real auth, multi-tenant
- **Sign-in:** Firebase Email/Password only. No self-signup; users are created by
  CLI scripts (`create-tenant.js` / `add-team-member.js`).
- **Session:** Firebase SDK persists the session in the browser; ID tokens are
  short-lived and auto-refreshed. `getIdTokenResult(true)` forces a refresh so a
  newly-set `tenantId` claim is picked up.
- **Roles/permissions:** a `tenantId` **custom claim** (set by the scripts) is the
  authorization primitive. `users/{uid}.role` (`owner`/`member`) is stored but
  **not currently enforced** anywhere — all authenticated tenant members have the
  same capabilities.
- **Protected routes:** every `api/*.js` admin endpoint calls
  `verifyCrmUser(request)` (`api/_bot-shared.js`), which verifies the
  `Authorization: Bearer <idToken>` header and requires a non-null `tenantId`.
  Client-side Firestore access is governed by `firestore.rules`: reads/writes
  require `request.auth.token.tenantId` to match the doc's tenant.
- **Unauthorized request:** admin endpoints return `401 {"error":"Unauthorized"}`;
  Firestore rejects with `permission-denied` (surfaces as a console error in the
  browser). Server-side functions using `firebase-admin` **bypass rules by
  design** (that's how webhooks write without a user session).

### Dashboard (`dashboard.html`) — NOT real auth
- A **client-side hardcoded** username (`admin`) + one of four plaintext passwords
  in `dashboard-assets/auth.js`; a successful check sets
  `localStorage.pinAdminAuthed = true`. This hides the UI only — the
  `properties`/`meta` collections are **fully open** in Firestore rules, so anyone
  with the (public) Firebase config can read/write them directly. See
  [Known issues](#14-known-issues--technical-debt) — this is Critical/High.

### Webhooks — HMAC, not user auth
`meta-webhook.js`, `whatsapp-bot-webhook.js`, and `data-deletion-callback.js`
verify Meta's `x-hub-signature-256` (or signed-request) HMAC against
`META_APP_SECRET`. The cron endpoint uses a shared `CRON_SECRET` bearer token.

---

## 8. API reference

All handlers live in `api/` and use the Web `Request`/`Response` API. "Auth"
below means the request must carry `Authorization: Bearer <Firebase ID token>`
and the caller must have a `tenantId` claim, unless noted.

Base URL: `https://admin.threepin.in`.

### `POST /api/generate-lead-summary` — auth
Regenerate one lead's AI summary.
- Body: `{ "leadId": "lead_…" }`
- 200: `{ "ok": true, "summary": "…" }`
- Errors: `401` unauthorized, `400` missing leadId, `404` not found / wrong
  tenant, `500` Claude/Firestore error (also writes `aiSummaryError`).
- Example:
  ```bash
  curl -X POST https://admin.threepin.in/api/generate-lead-summary \
    -H "Authorization: Bearer $ID_TOKEN" -H "Content-Type: application/json" \
    -d '{"leadId":"lead_1737800000000"}'
  ```

### `POST /api/backfill-lead-summaries` — auth
Bulk-generate summaries for the tenant's leads (skips leads that already have one
unless `force`). Cap 300/run, one Claude call at a time.
- Body: `{ "force": false }` (optional)
- 200: `{ ok, totalLeads, attempted, skipped, generated, failed, errors[] }`

### `POST /api/bot-test-message` — auth
CRM "Live Test Chat". **Currently returns a canned reply** (Claude disabled).
- Body: `{ "config": {…}, "history": [{role,content}] }`
- 200: `{ "reply": "…", "extractedInfo": {} }`; `400` missing config/history.

### `GET /api/whatsapp-bot-webhook` — Meta verify handshake
Query `hub.mode`, `hub.verify_token`, `hub.challenge`. Returns the challenge if
`hub.verify_token === WHATSAPP_VERIFY_TOKEN`, else `403`.

### `POST /api/whatsapp-bot-webhook` — HMAC (no user auth)
Inbound WhatsApp messages. Verifies `x-hub-signature-256` vs `META_APP_SECRET`.
Text messages only → resolves tenant via `waNumbers` → upserts a lead +
conversation → sends a **static** acknowledgement. Returns `200 EVENT_RECEIVED`
(`401` invalid signature, `400` bad JSON).

### `POST /api/whatsapp-embedded-signup` — auth
Exchange the Embedded Signup `code` for a long-lived token and connect the number.
- Body: `{ code, phoneNumberId, wabaId }`
- 200: `{ connected: true, phoneNumberId, displayPhoneNumber, verifiedName,
  qualityRating }` — or `{ connected: false, error }` (200) if the number is
  already claimed by another tenant / exchange fails. `401` unauthorized,
  `400` missing fields.

### `DELETE /api/whatsapp-embedded-signup` — auth
Disconnect the tenant's number. Clears `botConfigs` WA fields + deletes the
`waNumbers` routing entry (leaves `waSecrets` token). 200: `{ connected: false }`.

### `GET /api/knowledge-sync` — auth
List the tenant's knowledge sources (metadata only). 200: `{ sources: [{id, type,
name, url, syncedAt, status, chars}] }`.

### `POST /api/knowledge-sync` — auth
Actions via `{ action, … }`:
- `addLink` `{url, name?}` — pull a public Google Sheet/Doc.
- `addText` `{content, name?, sourceType?}` — pasted / uploaded (pre-extracted) text.
- `resync` `{id}` — re-fetch a link source.
- `remove` `{id}` — delete a source.
- 200: `{ ok: true, source? }`; `400`/`404` on bad input; fetch failures returned
  as `{error}` with status `200` (by design, so the UI can toast).

### `GET /api/followup-digest` — cron (CRON_SECRET bearer)
Runs the digest for **every** tenant. Requires `Authorization: Bearer $CRON_SECRET`,
else `401`. 200: `{ sent: [...] }`.

### `POST /api/followup-digest` — auth
"Send Digest Now" for the caller's tenant. 200:
`{ tenantId, skipped, results:[{channel, to, ok, error?}] }`.

### `POST /api/meta-webhook` (+ `GET` verify) — HMAC (legacy)
Facebook/Instagram Lead Ads. `GET` verifies against `META_VERIFY_TOKEN`. `POST`
verifies HMAC, fetches lead fields via Graph API, writes a `meta`-source lead
(⚠️ no `tenantId`). 200/401/400.

### `GET /api/public-config` — public
Serves non-secret client config: `{ metaAppId, metaEmbeddedSignupConfigId }`.

### `POST /api/data-deletion-callback` — Meta signed-request (HMAC)
Verifies Meta's `signed_request`, logs a `dataDeletionRequests/{code}` doc,
returns `{ url, confirmation_code }`.

### `GET /api/data-deletion-status?id=<code>` — public
HTML status page for a deletion request.

---

## 9. Environment variables

Static pages have **no** build step, so client-visible values are served at
runtime by `GET /api/public-config` — there are **no `NEXT_PUBLIC_*` vars** (this
isn't Next.js). The Firebase **web** config (apiKey etc.) is hardcoded in
`firebase-sync.js`; that is expected for Firebase web apps and is **not** a secret
(access is controlled by Firestore rules, not by hiding the key).

All of the following are **server-only** Vercel env vars unless marked
client-exposed.

| Variable | Required? | Used where | How to obtain | Example (dummy) |
|---|---|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Yes (all server) | `api/_bot-shared.js`, `api/meta-webhook.js` | Firebase Console → Project Settings → Service Accounts → Generate key; paste full JSON | `{"type":"service_account",…}` |
| `META_APP_SECRET` | Yes (webhooks + signup) | webhooks, `whatsapp-embedded-signup.js`, `data-deletion-callback.js` | Meta App → Settings → Basic | `a1b2c3…` |
| `META_APP_ID` | Yes (WA connect) | `public-config.js` (→ client), `whatsapp-embedded-signup.js` | Meta App → Settings → Basic | `1234567890` |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | Yes (WA connect) | `public-config.js` (→ client) | Meta App → WhatsApp → Configuration | `9876543210` |
| `ANTHROPIC_API_KEY` | Yes (AI summaries) | `@anthropic-ai/sdk` in `generate-lead-summary.js`, `backfill-lead-summaries.js` (read implicitly by `new Anthropic()`) | console.anthropic.com → API Keys (billing required) | `sk-ant-…` |
| `CRON_SECRET` | Yes (digest cron) | `followup-digest.js` GET | Any strong random string; also set in Vercel Cron config | `crn_…` |
| `GMAIL_USER` | For email digest | `followup-digest.js` | A Gmail address | `bot@gmail.com` |
| `GMAIL_APP_PASSWORD` | For email digest | `followup-digest.js` | Google Account → App Passwords (2FA required) | `abcd efgh ijkl mnop` |
| `WHATSAPP_VERIFY_TOKEN` | For WA webhook | `whatsapp-bot-webhook.js` GET | A string you choose; enter same in Meta webhook config | `3pin_wa_webhook_2026` |
| `META_VERIFY_TOKEN` | For Lead Ads only | `meta-webhook.js` GET | A string you choose | `3pin_meta_webhook_2026` |
| `META_PAGE_ACCESS_TOKEN` | For Lead Ads only | `meta-webhook.js` | Graph API Explorer / System User token | `EAAG…` |
| `WHATSAPP_ACCESS_TOKEN` | Legacy fallback | `_bot-shared.js` (`getWhatsAppCreds`) | System User token — only if a tenant has no `waSecrets` doc | `EAAG…` |
| `WHATSAPP_PHONE_NUMBER_ID` | Legacy fallback | `_bot-shared.js` | Meta WhatsApp API Setup | `123456789012345` |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Scripts only (local) | `scripts/*.js` | Path to a local service-account JSON | `./api/pin-…json` |
| `VERCEL_OIDC_TOKEN` | Auto (Vercel CLI) | `.env.local` (dev) | Written by `vercel` CLI; short-lived | `eyJ…` |

> **Client-exposed via `/api/public-config`:** only `META_APP_ID` and
> `META_EMBEDDED_SIGNUP_CONFIG_ID` — both are non-secret by Meta's design (they
> must appear in client JS for `FB.login` to work). No secret is exposed through
> that endpoint. **Do not** add secrets to `public-config.js`.

### `.env.example`

```dotenv
# ---- Server-only (set in Vercel → Settings → Environment Variables) ----
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"pin-realty","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"...@pin-realty.iam.gserviceaccount.com"}
META_APP_SECRET=your_meta_app_secret
META_APP_ID=your_meta_app_id
META_EMBEDDED_SIGNUP_CONFIG_ID=your_embedded_signup_config_id
ANTHROPIC_API_KEY=sk-ant-your-key
CRON_SECRET=generate_a_long_random_string

# ---- Email follow-up digest (optional) ----
GMAIL_USER=youraddress@gmail.com
GMAIL_APP_PASSWORD=your_16_char_app_password

# ---- WhatsApp bot webhook ----
WHATSAPP_VERIFY_TOKEN=choose_a_string_and_match_it_in_meta

# ---- Facebook/Instagram Lead Ads (only if used) ----
META_VERIFY_TOKEN=choose_a_string_and_match_it_in_meta
META_PAGE_ACCESS_TOKEN=your_long_lived_page_token

# ---- Legacy single-tenant WhatsApp fallback (usually unset now) ----
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=

# ---- Local CLI scripts only ----
FIREBASE_SERVICE_ACCOUNT_PATH=./api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json
```

---

## 10. Local setup — quickstart

**Prerequisites:** Node **20 LTS** recommended (`firebase-admin@14` needs Node
18+; Vercel runs Node 20). npm (bundled). A Firebase service-account key for
running `api/` and scripts.

```bash
# 1. Clone
git clone <your-repo-url> thirumal
cd thirumal

# 2. Install deps
npm install

# 3. (Frontend only) run the static pages — NOTE: this does NOT run api/*.js
npm start           # live-server on http://localhost:5173  (open /crm.html or /dashboard.html)

# 4. (Full stack) run the serverless functions locally with the Vercel CLI
npm i -g vercel
vercel link         # link to the existing "threepin-admin" project (or a new one)
vercel env pull .env.local   # pulls env vars you have access to
vercel dev          # runs static pages + api/*.js together at http://localhost:3000
```

**Firebase service-account key (needed for `api/` + scripts):**
1. Firebase Console → project `pin-realty` → Project Settings → Service Accounts
   → **Generate new private key** (downloads JSON).
2. For **Vercel functions**: paste the whole JSON as the
   `FIREBASE_SERVICE_ACCOUNT_JSON` env var (`vercel env add FIREBASE_SERVICE_ACCOUNT_JSON`).
3. For **CLI scripts**: save the file as
   `api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json` (git-ignored) **or**
   set `FIREBASE_SERVICE_ACCOUNT_PATH` to wherever you put it.

**Verify it works:**
- `dashboard.html`: log in as `admin` / one of the passwords in
  `dashboard-assets/auth.js`; you should see ~46 property cards.
- `crm.html`: log in with a Firebase Email/Password user that has a `tenantId`
  claim (create one with `node scripts/create-tenant.js …`); you should see the
  Kanban board seed with 10 sample leads.
- Functions: `curl http://localhost:3000/api/public-config` → JSON with
  `metaAppId`.

A frontend-only dev loop (steps 1–3) takes well under 15 minutes; you only need
the Firebase key for `api/`/scripts.

---

## 11. Deployment (Vercel)

- **Project:** `threepin-admin` (see `.vercel/project.json`). Framework preset
  **Other** — leave build command / output dir **blank**. There is nothing to
  build; Vercel serves the repo's static files and turns `api/*.js` into functions
  automatically.
- **Auto-deploy:** every push to `main` deploys to production. PRs / other branches
  get **preview** deployments with the same code but their own URL; preview deploys
  share the same env vars scoped to "Preview" (configure per-env in Vercel if you
  need different values).
- **Env vars:** set every server variable from [§9](#9-environment-variables) in
  Vercel → Settings → Environment Variables (Production, and Preview if you test
  there). **Redeploy after changing env vars** — they only apply to new builds.
- **Cron:** `vercel.json` schedules `GET /api/followup-digest` at `30 3 * * *`
  (03:30 UTC = 09:00 IST). Vercel automatically sends the `CRON_SECRET` bearer if
  configured in the project's cron settings.
- **Custom domain:** `admin.threepin.in` is a CNAME → `cname.vercel-dns.com`
  (added in GoDaddy). The default `threepin-admin.vercel.app` also serves the same
  deployment. Both must be registered in the Meta App's App Domains.
- **Roll back a bad deploy:** Vercel → Deployments → pick the last known-good
  deployment → **⋯ → Promote to Production** (instant, no rebuild). Or
  `git revert <bad-commit> && git push`.

---

## 12. External dependencies & integrations

| Service | What it does here | Where creds live | Tier / limits | If it goes down |
|---|---|---|---|---|
| **Firebase (Firestore + Auth)** | All shared data + CRM login | Web config in `firebase-sync.js` (public); admin key in `FIREBASE_SERVICE_ACCOUNT_JSON` | Spark/Blaze — Firestore free ~50k reads / 20k writes / 20k deletes per day; Auth generous free tier | CRM/dashboard can't read/write; dashboard still renders bundled sample data; webhooks 500 |
| **Vercel** | Static hosting + functions + cron | Vercel account | Hobby: functions time-limited, cron limited; check plan | Whole site down |
| **Anthropic Claude** | Per-lead AI summaries (Haiku) | `ANTHROPIC_API_KEY` | Paid per token; rate limits per account | Summaries fail → `aiSummaryError` shown, stale summary kept; nothing else breaks |
| **Meta Graph / WhatsApp Cloud API** | WhatsApp connect, inbound messages, digest sends, Lead Ads | `META_APP_SECRET`, `META_APP_ID`, tenant `waSecrets` token, `META_PAGE_ACCESS_TOKEN` | WhatsApp: free service conversations then paid; 24h freeform-reply window | WA connect/digest/Lead-Ads intake fail; CRM otherwise works |
| **Gmail SMTP (nodemailer)** | Email follow-up digest | `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Gmail sending limits (~500/day) | Email digest fails; WhatsApp digest unaffected |
| **Google Docs/Sheets export URLs** | Pull public sheet/doc text into bot KB | none (public "anyone with link") | Google fair-use | KB add/resync fails with a "not publicly readable" style error |
| **CDNs (gstatic, cdnjs, connect.facebook.net)** | Firebase SDK, xlsx, pdf.js, Meta SDK | none | — | Export/PDF/WA-popup break; core CRM/dashboard still load |

Dashboards/docs: [Firebase Console](https://console.firebase.google.com/project/pin-realty) ·
[Vercel Dashboard](https://vercel.com/) ·
[Meta for Developers](https://developers.facebook.com/apps) ·
[Anthropic Console](https://console.anthropic.com/) ·
[Anthropic pricing](https://platform.claude.com/docs/en/pricing).

---

## 13. Troubleshooting

| Symptom (message) | Likely cause | Fix |
|---|---|---|
| CRM board empty; console: `This account has no tenantId claim yet` | The Firebase user has no `tenantId` custom claim | Run `node scripts/create-tenant.js …` (new business) or `add-team-member.js --tenantId t_3pinrealty` (existing); log out/in to refresh the token. |
| CRM: `permission-denied` / `Missing or insufficient permissions` in console | Firestore rules reject the read/write (claim missing or wrong tenant), or rules never deployed | Confirm the user's `tenantId` claim; deploy `firestore.rules` via Firebase Console → Firestore → Rules → paste → Publish. |
| API returns `401 {"error":"Unauthorized"}` | Missing/expired `Authorization: Bearer` token, or user has no `tenantId` | Ensure the client sends `window.crmAuth.getIdToken()`; re-login. For cron, send `Bearer $CRON_SECRET`. |
| Env var "not loading" in a function | Set only for a different environment, or not redeployed | Set it in Vercel for Production/Preview, then **redeploy** (env changes need a new build). Locally, `vercel env pull` + `vercel dev`. |
| `TypeError: Cannot read properties of undefined (reading 'project_id')` / JSON parse error on boot | `FIREBASE_SERVICE_ACCOUNT_JSON` missing or malformed (must be the full JSON, one value) | Re-paste the entire service-account JSON as the env value; redeploy. |
| WhatsApp webhook verification fails in Meta ("token mismatch") | `WHATSAPP_VERIFY_TOKEN` in Vercel ≠ what you typed in Meta | Make them identical; redeploy; retry the Meta verify. |
| `POST /api/*-webhook` → `401 Invalid signature` | `META_APP_SECRET` wrong, or a proxy altered the raw body | Copy App Secret from Meta → Settings → Basic; ensure the raw body isn't rewritten. |
| Bot never replies to real WhatsApp messages | **Expected** — bot replies are disabled in code (static ack) | See `api/whatsapp-bot-webhook.js`; re-add the Claude call (git history) to re-enable. |
| CRM "Live Test Chat" says "AI Bot replies are turned off" | **Expected** — `api/bot-test-message.js` returns a canned reply | Re-wire it to call Claude to re-enable. |
| AI summary shows "Couldn't refresh the summary" | Claude error (bad/missing `ANTHROPIC_API_KEY`, rate limit, billing) | Check Vercel function logs for `generate-lead-summary error`; verify key + billing. Stale summary is kept intentionally. |
| Meta Lead Ads leads never appear on the board | `meta-webhook.js` writes leads **without `tenantId`**, so the tenant-filtered query excludes them | Known bug — see [Known issues](#14-known-issues--technical-debt). Workaround: use the multi-tenant WhatsApp path, or patch the webhook to set `tenantId`. |
| Firestore console shows "The query requires an index" link | You added an `orderBy` to a filtered query | Click the console's one-click "Create index" link and wait for it to build. |
| Export button: "Export library failed to load" | `xlsx` CDN blocked/offline | Check network to `cdnjs.cloudflare.com`; retry when online. |
| KB add link: "This file is not publicly readable" | Google Sheet/Doc isn't shared "Anyone with the link" | Set link sharing to Anyone-with-link (Viewer) and retry. |
| Digest cron: `401 Unauthorized` | `CRON_SECRET` unset or mismatched | Set `CRON_SECRET` in Vercel and in the cron config; redeploy. |
| Email digest not sent; results show "Gmail not configured" | `GMAIL_USER`/`GMAIL_APP_PASSWORD` missing | Add an App Password (2FA on the Gmail account) and set both env vars. |
| WhatsApp digest fails to a number that hasn't messaged you | WhatsApp Cloud API blocks freeform text outside the 24h window | Recipient must message the business first, or use an approved template (not implemented). |
| Dashboard changes vanish on reload / "Save failed" toast | Firestore unreachable or open-rule write rejected; dashboard falls back to bundled sample data | Check connectivity + Firebase status; edits made offline don't sync. |
| Local `npm start` — `/api/...` calls 404 | `live-server` serves static files only | Use `vercel dev` to run functions locally. |
| Deploy succeeds but page 404s | Wrong path/case, or file not committed | URLs are case-sensitive; confirm the file is tracked (`git ls-files`) and pushed. |
| Data not updating in another tab | `onSnapshot` listener dropped (network) or write went to the wrong tenant | Refresh; confirm both tabs are the same tenant; check console for `sync error`. |
| WhatsApp connect popup blocked / doesn't open | `FB.login` not called synchronously on click, or domain not in Meta App Domains | Keep the click handler synchronous (already done); add both domains to Meta → Settings → Basic → App Domains. |

---

## 14. Known issues & technical debt

### 🔴 Critical
- **Dashboard passwords are hardcoded in client JS.** `dashboard-assets/auth.js`
  ships four plaintext passwords readable via "View Source". Anyone can read them
  and log into the dashboard UI. **Rotate to real auth** (Firebase) or at minimum
  stop treating this as a security control.
- **`properties` and `meta` Firestore collections are world-writable.**
  `firestore.rules` has `allow read, write: if true` for both. Anyone with the
  (public) Firebase config can read/modify/delete all listings directly, bypassing
  the login entirely. Closing this needs real auth on the dashboard first.
- **Secrets can be committed by accident.** Scripts expect a service-account JSON
  at `api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json`. It is git-ignored
  (`*firebase-adminsdk*.json`), but verify it was never force-added. `.env.local`
  (contains a `VERCEL_OIDC_TOKEN`) is git-ignored via `.env*` — keep it that way.

### 🟠 High
- **Meta Lead Ads intake writes leads without `tenantId`.** `api/meta-webhook.js`
  is pre-multi-tenant: it reads the legacy `config/pipeline` doc and omits
  `tenantId`, so Lead-Ads leads never show on the tenant-filtered CRM board.
  Either finish multi-tenant routing or disable Lead Ads.
- **`firestore.rules` is not deployed automatically.** Editing the repo file has
  no effect until someone pastes it into the Firebase Console (or deploys via the
  Rules API). Easy to have repo and live rules drift.
- **No stored-XSS escaping on some lead fields.** In `crm-assets/app.js`, several
  render paths interpolate raw lead fields into `innerHTML` (e.g. `l.name`,
  `l.phone`, `l.propertyInterest`, note `text`) without `escapeHtml()`. Values can
  arrive from a WhatsApp webhook (attacker-influenced). Wrap these in
  `escapeHtml()` consistently (the code already has the helper and uses it in
  many, but not all, places).

### 🟡 Medium
- **`users/{uid}.role` is stored but never enforced** — no owner/member
  distinction in code. All tenant members are effectively admins.
- **Long-lived WhatsApp token exchange is unverified** (`exchangeForLongLivedToken`
  in `whatsapp-embedded-signup.js`) — falls back to the short-lived token; a
  short-lived token will silently expire and break sending.
- **`whatsapp-bot-webhook.js` handles text messages only** — media/interactive
  messages are dropped (`if (msg.type !== 'text') continue`).
- **Digest sends are sequential** (`for … await`) per tenant/recipient — fine now,
  slow at scale, and a single hang blocks the rest.

### 🟢 Low
- **Orphan file:** `dash-copy.html` (88 KB) is an older copy of the dashboard,
  referenced nowhere. Safe to delete after confirming.
- **`connect-whatsapp-manual.js`** is a utility, not part of any automated flow.
- **Google Drive picker is a placeholder** (`connectGoogleDrive()` just toasts).
- **`config/*` legacy docs** linger; only `meta-webhook.js` still reads them.
- **The per-app `crm-assets/README.md` / `dashboard-assets/README.md`** still hold
  useful setup detail, but their Firestore-rules snippets predate the current
  multi-tenant `firestore.rules`.

---

## 15. Maintenance & operations

**Monthly checklist**
- Firebase Console → Usage: confirm Firestore reads/writes are within budget.
- Vercel → Deployments/Logs: skim function errors (auth failures, Claude errors,
  digest send failures).
- Anthropic Console: check spend; summaries run on every lead change.
- Meta App: confirm the WhatsApp token/number is still healthy (quality rating),
  and that Lead-Ads page subscription (if used) is intact.
- Gmail: confirm the App Password still works (revoked passwords fail silently in
  the digest results).

**Backups**
- Firestore: enable scheduled exports (Firebase Console → Firestore → Import/
  Export, or `gcloud firestore export gs://<bucket>`). At minimum export before
  any rules change or bulk script run.

**Key rotation**
- `ANTHROPIC_API_KEY`, `CRON_SECRET`, `META_APP_SECRET`, `GMAIL_APP_PASSWORD`:
  create the new value at the provider, update the Vercel env var, redeploy, then
  revoke the old one. (For `META_APP_SECRET`, update Meta and Vercel together to
  avoid webhook signature failures.)
- Firebase service account: generate a new key, update
  `FIREBASE_SERVICE_ACCOUNT_JSON`, redeploy, then disable the old key.

**Dependency updates**
- `npm outdated`; bump `firebase-admin`, `@anthropic-ai/sdk`, `nodemailer`
  cautiously and test `vercel dev` + one function call before pushing. The Firebase
  **web** SDK is pinned by URL (`12.16.0`) in `firebase-sync.js` — bump it there.

**Monitoring**
- There is no external error tracker wired up. Vercel function logs and browser
  console are the sources of truth.

---

## 16. How to extend

**Add a new page**
1. Create `newpage.html` in the repo root (thin shell).
2. Put its JS/CSS under a new `newpage-assets/` folder.
3. If it needs shared data, import the Firebase SDK the same way
   `crm-assets/firebase-sync.js` does. Push to `main` — it's live at
   `/newpage.html`.

**Add a new field to a lead**
1. `crm.html`: add the input to the Add/Edit modal.
2. `crm-assets/app.js`: read it in `saveLeadModal` (both add + edit branches), add
   a `diffField(...)` line for history, render it in `openDetail`, and add it to
   the `runExport` row map. Escape it with `escapeHtml()` when rendering.
3. No schema migration needed (Firestore is schemaless); old docs just lack it.
4. If it should feed the AI summary, add it in
   `api/_lead-summary-shared.js → buildLeadSummaryUserPrompt`.

**Add a new API endpoint**
1. Create `api/my-endpoint.js` exporting `GET`/`POST` etc. (Web `Request`/
   `Response`).
2. For an authenticated admin action, start with
   `const user = await verifyCrmUser(request); if (!user?.tenantId) return 401`.
3. Use `getDb()` from `api/_bot-shared.js` for Firestore.
4. Call it from the client with `fetch('/api/my-endpoint', { headers:{
   Authorization: 'Bearer ' + await window.crmAuth.getIdToken() }})`.

**Add a new user role (make `role` meaningful)**
1. Set `role` when provisioning (`create-tenant.js` / `add-team-member.js` already
   write it).
2. Include it as a **custom claim** alongside `tenantId` (edit the scripts'
   `setCustomUserClaims`), so it's available in the ID token server-side.
3. Enforce it in `verifyCrmUser` consumers (e.g. gate delete/backfill) and,
   optionally, in `firestore.rules`.

**Add a new pipeline stage** — no code: CRM → ☰ → **Manage Stages**.

**Onboard a new tenant** — `node scripts/create-tenant.js --email … --business …`
(see [`SOP.md`](SOP.md) and `docs/SOP.md`).

---

## 17. Glossary

| Term | Meaning in this project |
|---|---|
| **Lead** | A prospective buyer enquiry (a `leads` doc). Source is `manual`, `meta`, or `whatsapp_bot`. |
| **Tenant** | One customer business. Identified by a `tenantId`; all CRM data is isolated per tenant. 3 PIN Realty itself is `t_3pinrealty`. |
| **Pipeline / Stage** | The Kanban columns a lead moves through (New → Contacted → Site Visit → Negotiation → Closed Won/Lost). Editable per tenant. |
| **Follow-up** | A single scheduled next-touch timestamp (`followUpAt`) on a lead; drives the follow-ups view, badges, and the daily digest. |
| **Digest** | Daily 9 AM IST summary of overdue + next-3-days follow-ups, sent over WhatsApp and/or email. |
| **Enquiry type** | A tag on a manual lead (Property Enquiry / Seller Listing / General / custom), stored in `settings.enquiryTypes`. |
| **Details sent** | A Yes/No flag (`detailsSent`) recording whether property/pricing info was sent to the lead. |
| **Bot config** | The bot's persona/steps/guardrails + connected-WhatsApp metadata (`botConfigs/{tenantId}`). |
| **Knowledge base** | Text sources (Google Sheet/Doc links, uploaded/pasted text) the bot could answer from (`knowledgeConfigs`). |
| **WABA** | WhatsApp Business Account (Meta). |
| **Embedded Signup** | Meta's popup flow to connect a customer's own WhatsApp number without pasting tokens. |
| **Listing / Property** | A `properties` doc shown on the dashboard. |
| **Sold out** | A boolean flag hiding/greying a property on the dashboard. |
| **Source** | Where a lead came from: `manual`, `meta` (Lead Ads), `whatsapp_bot`. |

---

## 18. Traceability index — "if I change X, what breaks?"

### a) Feature → files
| Feature | Pages | Components/JS | API routes | Helpers/libs |
|---|---|---|---|---|
| CRM auth | `crm.html` | `crm-assets/app.js` (`attemptCrmLogin`, `onCrmAuthChange`), `crm-assets/firebase-sync.js` | — | Firebase Auth SDK |
| Lead CRUD + stages | `crm.html` | `crm-assets/app.js`, `firebase-sync.js` | `generate-lead-summary` (side-effect) | `firestore.rules` |
| Notes & follow-ups | `crm.html` | `crm-assets/app.js` | — | — |
| Follow-up digest | `crm.html` | `crm-assets/app.js` (digest manager) | `followup-digest.js` | `nodemailer`, WhatsApp Cloud API, `_bot-shared.js` |
| AI lead summary | `crm.html` | `crm-assets/app.js` (`renderAiSummary`, `runBackfillSummaries`) | `generate-lead-summary.js`, `backfill-lead-summaries.js` | `_lead-summary-shared.js`, `@anthropic-ai/sdk` |
| WhatsApp connect | `crm.html` | `crm-assets/app.js` (`connectWhatsApp`) | `whatsapp-embedded-signup.js`, `public-config.js` | Meta JS SDK, `_bot-shared.js` |
| Bot inbound + KB | `crm.html` | `crm-assets/app.js` (bot editor, KB) | `whatsapp-bot-webhook.js`, `bot-test-message.js`, `knowledge-sync.js` | `_bot-shared.js` |
| Lead export | `crm.html` | `crm-assets/app.js` (`runExport`) | — | `xlsx` (CDN) |
| KB PDF upload | `crm.html` | `crm-assets/app.js` (`extractPdfText`) | `knowledge-sync.js` | `pdf.js` (CDN) |
| Property dashboard | `dashboard.html` | `dashboard-assets/app.js`, `auth.js`, `firebase-sync.js` | — | Firebase SDK |
| Lead Ads intake | — | — | `meta-webhook.js` | Meta Graph API |
| Data-deletion compliance | — | — | `data-deletion-callback.js`, `data-deletion-status.js` | — |

### b) Collection → consumers
| Collection | Read by | Written by | Deleted by |
|---|---|---|---|
| `leads` | `crm-assets/firebase-sync.js`, `followup-digest.js`, `generate/backfill-lead-summaries.js` | `crm-assets/app.js`→`firebase-sync.js`, `whatsapp-bot-webhook.js`, `meta-webhook.js`, summary APIs, `migrate-existing-tenant.js` | `crm-assets/firebase-sync.js` (`deleteLead`) |
| `conversations` | (client, tenant-scoped) | `whatsapp-bot-webhook.js` | — |
| `pipelines/{tid}` | `firebase-sync.js`, `followup-digest.js`, `whatsapp-bot-webhook.js`, summary APIs | `firebase-sync.js` (`savePipeline`, seed), `migrate-existing-tenant.js` | — |
| `settings/{tid}` | `firebase-sync.js`, `followup-digest.js` | `firebase-sync.js` (enquiry types, digest, seed) | — |
| `botConfigs/{tid}` | `firebase-sync.js`, `_bot-shared.js`, `whatsapp-embedded-signup.js`, `add-team-member.js` | `firebase-sync.js`, `whatsapp-embedded-signup.js`, `create-tenant.js`, `connect-whatsapp-manual.js`, `migrate-existing-tenant.js` | — |
| `knowledgeConfigs/{tid}` | `knowledge-sync.js`, `_bot-shared.js` | `knowledge-sync.js`, `create-tenant.js`, `migrate-existing-tenant.js` | — |
| `waNumbers/{phoneNumberId}` | `_bot-shared.js` (resolve tenant) | `whatsapp-embedded-signup.js`, `connect-whatsapp-manual.js`, `migrate-existing-tenant.js` | `whatsapp-embedded-signup.js` (DELETE/reconnect) |
| `waSecrets/{tid}` | `_bot-shared.js` | `whatsapp-embedded-signup.js`, `connect-whatsapp-manual.js` | — |
| `users/{uid}` | (client, own uid) | `create-tenant.js`, `add-team-member.js`, `migrate-existing-tenant.js` | — |
| `leadsSeededFlags/{tid}` | `firebase-sync.js` | `firebase-sync.js` | — |
| `dataDeletionRequests/{code}` | `data-deletion-status.js` | `data-deletion-callback.js` | — |
| `properties` | `dashboard-assets/firebase-sync.js` | `dashboard-assets/app.js`→`firebase-sync.js` | `dashboard-assets/firebase-sync.js` |
| `meta/seeded` | `dashboard-assets/firebase-sync.js` | `dashboard-assets/firebase-sync.js` | — |
| `config/*` (legacy) | `meta-webhook.js`, `migrate-existing-tenant.js` | (rules: client write denied) | — |

### c) Env var → consumers
| Variable | Read by | Fails if missing/wrong |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | `_bot-shared.js` `getDb()`, `meta-webhook.js` | Every server function crashes on first Firestore access |
| `META_APP_SECRET` | both webhooks, `whatsapp-embedded-signup.js`, `data-deletion-callback.js` | Webhook signature checks fail (401); WA token exchange fails |
| `META_APP_ID` | `public-config.js`, `whatsapp-embedded-signup.js` | WhatsApp connect popup can't init / token exchange fails |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | `public-config.js` | "Connect WhatsApp" button errors ("Meta config still loading") |
| `ANTHROPIC_API_KEY` | `generate/backfill-lead-summaries.js` (via SDK) | AI summaries fail → `aiSummaryError` |
| `CRON_SECRET` | `followup-digest.js` GET | Cron digest returns 401; no daily sends |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | `followup-digest.js` | Email digest returns "Gmail not configured" |
| `WHATSAPP_VERIFY_TOKEN` | `whatsapp-bot-webhook.js` GET | Meta can't verify the WA webhook |
| `META_VERIFY_TOKEN` | `meta-webhook.js` GET | Meta can't verify the Lead-Ads webhook |
| `META_PAGE_ACCESS_TOKEN` | `meta-webhook.js` | Lead-Ads field fetch fails |
| `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | `_bot-shared.js` fallback | Only matters if a tenant has no `waSecrets`; otherwise unused |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | `scripts/*.js` | CLI scripts can't authenticate to Firebase |

### d) External service → blast radius
| Service | Features depending on it | User sees when down/over quota |
|---|---|---|
| Firebase | Everything data/auth | CRM won't load leads / can't log in; dashboard shows stale sample data; webhooks 500 |
| Vercel | Entire site + functions | Site unreachable |
| Anthropic | AI lead summaries | "Couldn't refresh the summary" (stale summary kept) |
| Meta/WhatsApp | Connect, inbound bot leads, WA digest, Lead Ads | Can't connect number; no inbound WA leads; WA digest fails |
| Gmail | Email digest | No digest emails (results show error) |
| Google Docs/Sheets | Bot KB link import | "not publicly readable" errors on add/resync |
| CDNs | xlsx export, PDF KB, WA popup | Those specific actions fail; core pages still load |

### e) Shared component → used in
| Shared module | Imported by | Contract |
|---|---|---|
| `api/_bot-shared.js` | `generate-lead-summary`, `backfill-lead-summaries`, `bot-test-message`, `whatsapp-bot-webhook`, `whatsapp-embedded-signup`, `knowledge-sync`, `followup-digest`, `data-deletion-*`, `create-tenant.js` (`DEFAULT_BOT_CONFIG`) | `getDb()`, `verifyCrmUser(req)→{…,tenantId}`, `buildSystemPrompt`, `getWhatsAppCreds`, `resolveTenantByPhoneNumberId`, `getKnowledgeSources`, `DEFAULT_BOT_CONFIG`, `UPDATE_LEAD_INFO_TOOL` |
| `api/_lead-summary-shared.js` | `generate-lead-summary.js`, `backfill-lead-summaries.js` | `LEAD_SUMMARY_MODEL`, `LEAD_SUMMARY_MAX_TOKENS`, `buildLeadSummarySystemPrompt()`, `buildLeadSummaryUserPrompt(lead, stageName)` |
| `crm-assets/firebase-sync.js` | `crm.html` (window globals `crmFirebase`, `crmAuth`; callbacks `applyLeadsSnapshot`, `applyPipelineSnapshot`, `applyEnquiryTypesSnapshot`, `applyDigestSettingsSnapshot`, `onCrmAuthChange`) | `crm-assets/app.js` calls these globals |
| `dashboard-assets/firebase-sync.js` | `dashboard.html` (`dashboardFirebase`, `applyPropertiesSnapshot`) | `dashboard-assets/app.js` calls these globals |
| `dashboard-assets/auth.js` | `dashboard.html`, `app.js` (`window.pinAuth`) | `isLoggedIn/showLogin/showApp/attemptLogin/logout` |

### f) Orphans (defined but unused — do not delete without confirming)
- **`dash-copy.html`** — older dashboard copy, referenced nowhere.
- **`connect-whatsapp-manual.js`** — manual utility, not wired into any flow.
- **`connectGoogleDrive()`** in `crm-assets/app.js` — placeholder toast only.
- **`config/*` legacy docs** — only `meta-webhook.js` still reads them.
- **`WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID`** — only used if a tenant
  has no `waSecrets` doc (should be none post-migration).
- **`UPDATE_LEAD_INFO_TOOL` / `buildSystemPrompt`** in `_bot-shared.js` — only
  meaningful once the disabled Claude bot is re-enabled.
- **`sample-data.js` / `sample-leads.js`** — used only for first-run seeding and
  offline fallback.

---

## 19. NEEDS VERIFICATION checklist

- [ ] ⚠️ **Confirm the Firebase service-account JSON was never committed.** Run
      `git log --all --full-history -- '*firebase-adminsdk*.json'` — should be empty.
- [ ] ⚠️ **`ANTHROPIC_API_KEY` set in Vercel?** `docs/SOP.md` (dated) says it was
      "still missing." If unset, AI summaries silently fail. Confirm in Vercel.
- [ ] ⚠️ **`CRON_SECRET` set in Vercel and in the cron config?** Without it the
      daily digest returns 401 and never sends. Confirm.
- [ ] ⚠️ **`GMAIL_USER` / `GMAIL_APP_PASSWORD` set?** Required for the *email*
      digest only; confirm whether email digests are expected to work.
- [ ] ⚠️ **Is `firestore.rules` in the repo identical to what's live in Firebase?**
      It is not auto-deployed. Diff the Console rules against the repo file.
- [ ] ⚠️ **Do you actually use Meta Lead Ads (`meta-webhook.js`)?** If yes, note it
      writes leads without `tenantId` (they won't appear on the board) — is that a
      live bug to fix or a dead path to remove?
- [ ] ⚠️ **Is the disabled AI bot intended to stay off?** `whatsapp-bot-webhook.js`
      and `bot-test-message.js` don't call Claude. Confirm this is deliberate.
- [ ] ⚠️ **Should `dash-copy.html` be deleted?** Confirm it's a dead copy.
- [ ] ⚠️ **Node version for local scripts?** No `engines` field. Confirm you run
      Node 18+/20 locally (matching Vercel).
- [ ] ⚠️ **Dashboard security:** confirm the open `properties`/`meta` rules and
      client-side passwords are an accepted risk or scheduled for real auth.
```
