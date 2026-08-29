# 3 PIN Realty Admin — Standard Operating Procedures

The operating manual for `admin.threepin.in`: what the system is, who does
what, how access works, how things get deployed and backed up, and what to do
when something breaks.

**This is the platform SOP.** How to actually *use* the two apps lives in their
own guides:

| Guide | Covers |
|---|---|
| [`CRM.md`](CRM.md) | Lead CRM — leads, stages, follow-ups, notes, analytics, exports |
| [`DASHBOARD.md`](DASHBOARD.md) | Property Dashboard — listings, sync, changes, missing data, sharing |
| [`PROPERTY-PIPELINE.md`](PROPERTY-PIPELINE.md) | How property data flows: sheet → Firestore → dashboard, and the brochure pipeline |
| [`mac-scheduler-handoff.md`](mac-scheduler-handoff.md) | The Mac scheduler's brochure-delivery script |

Verified against the live code on **27 Aug 2026**.

---

## Contents

1. [What the system is](#1-what-the-system-is)
2. [Current status at a glance](#2-current-status-at-a-glance)
3. [Users and access](#3-users-and-access)
4. [The operating rhythm](#4-the-operating-rhythm)
5. [Scheduled jobs](#5-scheduled-jobs)
6. [Deploying changes](#6-deploying-changes)
7. [Configuration and secrets](#7-configuration-and-secrets)
8. [Backups and recovery](#8-backups-and-recovery)
9. [WhatsApp and the AI bot](#9-whatsapp-and-the-ai-bot)
10. [Onboarding a separate business (multi-tenant)](#10-onboarding-a-separate-business-multi-tenant)
11. [If something breaks](#11-if-something-breaks)
12. [Reference — files, endpoints, collections, scripts](#12-reference--files-endpoints-collections-scripts)
13. [Known gaps and technical debt](#13-known-gaps-and-technical-debt)

---

## 1. What the system is

A private back-office for a Chennai real-estate brokerage, made of two apps
plus a small serverless backend:

- **Lead CRM** (`crm.html`) — every buyer/seller enquiry, its pipeline stage,
  follow-ups, notes and analytics.
- **Property Dashboard** (`dashboard.html`) — the catalogue of sellable
  properties, fed from an Inventory master sheet.
- **Public landing page** (`index.html`) — brochure page with links into both.

**Both apps share one login.** One Firebase Authentication account gives a
person the CRM *and* the Dashboard.

### The stack, in one paragraph

Plain static HTML and vanilla JavaScript — **no React, no build step, no
bundler**. Vercel serves the files and runs a handful of serverless functions in
`api/`. Data lives in Firebase Firestore (project `pin-realty`); logins are
Firebase Authentication. Deploys happen automatically on every push to `main`.

### Multi-tenancy

Every piece of data carries a `tenantId`, and each login carries a matching
custom claim. 3 PIN Realty is `t_3pinrealty`. The design supports several
separate businesses on one deployment; today it runs one.

### Domains

- `https://admin.threepin.in` — canonical.
- `https://threepin-admin.vercel.app` — the default Vercel domain, same
  deployment.

---

## 2. Current status at a glance

| Capability | State |
|---|---|
| Lead CRM | **Live** |
| Property Dashboard | **Live** |
| Inventory sheet → dashboard sync | **Live** — every 30 min on the Mac, plus the on-demand button |
| Brochure pipeline (intake → PDF → Drive → email → sheet) | **Live** — Mac, every 30 min |
| AI lead summaries (Claude Haiku) | **Live** — on demand |
| Daily follow-up digest — **email** | **Live** — 09:00 IST |
| Daily follow-up digest — **WhatsApp** | **Not working** — no WhatsApp number connected |
| Daily dashboard summary email | **Live** — 21:30 IST |
| AI WhatsApp bot | **Off** — disabled in code |
| WhatsApp Embedded Signup ("Connect WhatsApp via Meta") | **Broken** — the endpoint is not deployed |
| Facebook/Instagram Lead Ads intake | **Not deployed** |
| Roles / permissions | **Not implemented** — everyone has full access |
| Billing / plan limits | **Not designed** |

---

## 3. Users and access

Both apps use the same accounts. There is currently **no in-app user
management** — everything below is a developer or Firebase Console task.

### Add a teammate to 3 PIN Realty

```bash
node scripts/add-team-member.js --email newperson@threepin.in --tenantId t_3pinrealty
```

It prints a temporary password. **Copy it immediately — it is not stored
anywhere.** Send the person their email and password; they log in at
`/crm.html` or `/dashboard.html`.

> Do **not** use `create-tenant.js` for a teammate. That mints a brand-new
> business that cannot see your leads or properties. It is only for onboarding a
> genuinely separate company — see [section 10](#10-onboarding-a-separate-business-multi-tenant).

### Reset a password

Firebase Console → project **pin-realty** → **Build → Authentication → Users** →
find the email → **⋮** → **Reset password** (sends an email) or **Edit** to set
one directly.

### Remove someone

Same screen → **⋮** → **Disable account** (reversible) or **Delete account**
(permanent). Their leads, properties and notes are untouched; the "added by" and
"updated by" stamps on past records stay as they are.

### See who has access

Firebase Console → **Authentication → Users** lists every login, its last
sign-in and whether it is disabled.

### Access level — say this out loud to every new user

There is **one** access level. Anyone who can log in can edit or delete any
lead and any property. Roles are recorded in the data model but not enforced.
The only accountability is the `createdBy` / `updatedBy` stamp on every record
and the per-lead history log.

---

## 4. The operating rhythm

**Every 30 minutes (automatic, on the Mac):** brochure delivery runs, then the
Inventory sheet is synced into the dashboard.

**09:00 IST (automatic):** follow-up digest goes out — what needs chasing today.

**21:30 IST (automatic):** dashboard summary email goes out — how the day went.

**Daily (people):**
- Agents work the CRM's Follow-ups tab to empty — see [`CRM.md`](CRM.md).
- New enquiries get entered as they arrive, not at the end of the day.
- New listings go in via **📋 Create Brochure** on the dashboard.

**Weekly (owner or whoever maintains data):**
- Dashboard **🕒 Changes → Pending** — carry each edit into the Inventory sheet
  and tick it off. This is the only thing keeping the sheet accurate.
- Dashboard **⚠️ Missing Data** — fill the worst gaps.
- CRM **Analytics → Data Hygiene** and **Cold Leads**.

---

## 5. Scheduled jobs

| Job | Where | When | What it does |
|---|---|---|---|
| `api/followup-digest` | Vercel cron | 03:30 UTC = **09:00 IST** | Sends the follow-up digest by email (and WhatsApp, when connected) |
| `api/dashboard-summary` | Vercel cron | 16:00 UTC = **21:30 IST** | Sends the daily analytics email |
| `scripts/deliver-brochures.js` | **The Mac**, launchd | every 30 min | Reads the intake queue, uploads brochure PDFs to Drive, emails them, writes the link back into the Inventory sheet |
| `scripts/sync-inventory.js --apply` | **The Mac**, launchd | every 30 min, after the above | Syncs the Inventory sheet into Firestore `properties` |

Both cron schedules are declared in `vercel.json`. The digest is idempotent per
day, so triggering it twice cannot double-send.

**The Mac matters.** It holds the generated brochure PDFs and is the only
machine that can upload them. If it is off or asleep, brochures stop being
delivered and the dashboard stops picking up sheet changes automatically —
agents can still use the dashboard's **🔄 Sync from Sheet** button in the
meantime. Details: [`PROPERTY-PIPELINE.md`](PROPERTY-PIPELINE.md).

---

## 6. Deploying changes

Vercel is connected to GitHub. **Any push to `main` deploys automatically.**

```bash
git add -A
git commit -m "Describe the change"
git push origin main
```

Watch the deployment in the Vercel dashboard. A failed build leaves the previous
deployment live.

**Rolling back:** Vercel dashboard → Deployments → pick the last good one →
**Promote to Production**. That is instant and does not touch the repo; fix the
code properly afterwards.

**Firestore rules do NOT deploy on push.** After any change to
`firestore.rules`:

```bash
node scripts/deploy-firestore-rules.js
```

If anyone ever hand-edits rules in the Firebase Console, copy them back into
`firestore.rules` so the repo stays the source of truth.

---

## 7. Configuration and secrets

Environment variables live in Vercel (Project → Settings → Environment
Variables) or as a local `.env` for the scripts.

| Variable | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Server-side Firestore and Auth access (all `api/*` and scripts) |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Local alternative to the above, for scripts |
| `ANTHROPIC_API_KEY` | Claude lead summaries. Read automatically by the SDK — not referenced by name in code |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Gmail SMTP for both daily emails |
| `GOOGLE_SERVICE_ACCOUNT_JSON` (or `..._PATH`) | Google Sheets and Drive access — Inventory sync, brochure upload |
| `GOOGLE_IMPERSONATE_EMAIL` | Workspace user the Drive calls impersonate |
| `CRON_SECRET` | Guards the cron endpoints |
| `WEBHOOK_SHARED_SECRET` | Guards the brochure endpoint |
| `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID` | WhatsApp Embedded Signup — set, but the flow is not deployed |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Legacy fallback when a tenant has no per-tenant credentials |

**Rotating a key:** add the new value in Vercel, redeploy, verify the affected
feature, then revoke the old key at its source. Never commit a key. The Firebase
service-account JSON is gitignored (`*firebase-adminsdk*.json`) and is correctly
untracked — keep it that way.

**Adding a variable:** set it in Vercel for Production, redeploy (env changes do
not apply to existing deployments), then test.

### Important IDs

- Firebase project: **pin-realty**
- Tenant: **t_3pinrealty**
- Inventory master sheet: `1X53_F-S9ezL70Dy2c7a6DG06ljD7bGCb3HauysPMZ8I`
- Brochure intake queue sheet: `1MlepLxnA1-OzHHYd-8S1YKRPCk3Cvz8g1md3eWthsY4`

Both sheets must stay shared with the service account, or the sync and the
brochure pipeline fail.

---

## 8. Backups and recovery

| Data | Protection |
|---|---|
| Properties | `syncBackups/{runId}` — a pre-sync snapshot is written before every sync run |
| Property edits and deletes | `propertyChanges` — append-only; a delete stores the whole record |
| Leads | **No application-level backup.** A deleted lead is gone |
| Everything | Whatever Firestore backup policy is configured in Google Cloud |

**Practical consequences:**

- **A deleted property is recoverable** by a developer from the change-log
  snapshot.
- **A deleted lead is not.** Train the team to move leads to a *Not Interested*
  or *Spam* stage instead of deleting them.
- Before any bulk or migration script, take a manual export. The `backups/`
  folder is gitignored and is the conventional place for those.

**Restoring one deleted property:** find its `delete` row in `propertyChanges`,
read the stored snapshot, write it back to `properties`. There is no UI for
this.

**Undoing a whole bad sync run:** every `--apply` run writes a backup file
first, and the script can roll it back:

```bash
node scripts/sync-inventory.js --restore backups/<file>
```

Runs triggered from the dashboard's Sync button snapshot to
`syncBackups/{runId}` in Firestore instead, since Vercel has no writable disk.

---

## 9. WhatsApp and the AI bot

**Both are currently non-functional. This is expected, not a fault.**

- `api/bot-test-message.js` returns a fixed "turned off" message by design; the
  comment in the file explains how to re-wire it to Claude.
- There is **no** `whatsapp-bot-webhook.js` in `api/`, so no inbound WhatsApp
  message reaches anything.
- The CRM's **Connect WhatsApp via Meta** button calls
  `/api/whatsapp-embedded-signup`, which **is not deployed** — the popup fails.
- There is **no** `meta-webhook.js`, so Facebook/Instagram Lead Ads do not
  arrive.
- `ANTHROPIC_API_KEY` is still spent — but only on **lead summaries**, which
  work.

**What this costs the business today:** the WhatsApp follow-up digest cannot
send (use the email digest instead), and no leads arrive automatically. Nothing
else is affected.

**To connect a number without the popup**, `scripts/connect-whatsapp-manual.js`
writes the same three Firestore records the popup would. That is the shorter
path for internal use, since Meta's popup flow exists mainly for reselling to
external businesses.

**To restore the bot properly**, a developer needs to: re-add the webhook
endpoint, re-add the embedded-signup endpoint (or use the manual script),
re-point `bot-test-message.js` at Claude, and register the callback URL and
verify token in the Meta app.

---

## 10. Onboarding a separate business (multi-tenant)

Only for a genuinely different company — never for a teammate.

```bash
node scripts/create-tenant.js --email owner@customer.com --business "Customer Business Name"
```

This creates their login, mints a `tenantId`, seeds a default bot config and
prints a temporary password (save it — it is not stored). They then log in at
`/crm.html` and see a completely isolated set of leads, properties and settings.

Note that WhatsApp connection is currently unavailable
([section 9](#9-whatsapp-and-the-ai-bot)), so a new tenant gets the CRM and
Dashboard but no bot.

---

## 11. If something breaks

### The site is down

1. Check `https://admin.threepin.in` and `https://threepin-admin.vercel.app`. If
   only the custom domain fails, it is DNS or the domain config, not the app.
2. Vercel dashboard → Deployments. If the latest build failed, **promote the
   last good deployment**.
3. Check the Vercel status page before assuming it is your code.

### Nobody can log in

1. Firebase Console → **Authentication** — is the Email/Password provider
   enabled, and is the account disabled?
2. Firebase Status Dashboard — an Auth incident affects everyone at once.
3. One person only? Reset their password.

### Data is not saving

1. Does it fail for everyone, or one person?
2. Browser console — a `permission-denied` error means the Firestore rules or
   the user's tenant claim, not the app code.
3. If rules were changed recently, redeploy them:
   `node scripts/deploy-firestore-rules.js`.
4. A user with no `tenantId` claim can log in but sees and saves nothing —
   re-run `add-team-member.js` for them.

### Properties stopped updating from the sheet

1. Try the dashboard's **🔄 Sync from Sheet** — the preview shows the real
   error.
2. "Sheets read failed" usually means the sheet is no longer shared with the
   service account, or a tab was renamed.
3. If the button works but the automatic sync does not, the Mac scheduler is the
   problem — see [`PROPERTY-PIPELINE.md`](PROPERTY-PIPELINE.md).

### Brochures are not being delivered

The Mac is asleep, off, or its script is failing. Same doc.

### The daily emails stopped

Use **📤 Send Now** in the CRM's digest settings — it surfaces the actual error.
Most often it is `GMAIL_APP_PASSWORD` having been revoked.

### Someone deleted something important

- **A property:** recoverable from the `propertyChanges` snapshot.
- **A lead:** not recoverable through the app; ask whether a Firestore backup
  covers that window.

---

## 12. Reference — files, endpoints, collections, scripts

### Pages

| File | What it is |
|---|---|
| `index.html` | Public landing page |
| `crm.html` + `crm-assets/` | Lead CRM |
| `dashboard.html` + `dashboard-assets/` | Property Dashboard |
| `property.html` | Single shareable property page (login required) |
| `privacy-policy.html`, `terms.html` | Legal pages — drafts |

### API endpoints (`api/`)

| Endpoint | Purpose |
|---|---|
| `sync-inventory.js` | Inventory sheet → `properties`; dry-run preview then apply |
| `brochure.js` | Brochure upload to Drive and delivery email |
| `followup-digest.js` | Daily follow-up digest (cron + Send Now) |
| `dashboard-summary.js` | Daily analytics email; also serves the "dead reasons" breakdown |
| `generate-lead-summary.js` | One lead's AI summary |
| `backfill-lead-summaries.js` | Batched AI summaries for leads without one |
| `knowledge-sync.js` | AI-bot knowledge-base connectors |
| `bot-test-message.js` | Bot test chat — **currently returns a fixed off message** |
| `public-config.js` | Serves non-secret Meta IDs to the client |
| `data-deletion-callback.js`, `data-deletion-status.js` | Meta data-deletion compliance |
| `_bot-shared.js`, `_brochure-shared.js`, `_inventory-shared.js`, `_lead-summary-shared.js`, `_dashboard-ai-shared.js` | Shared helpers, not routes |

Vercel's Hobby plan caps a deployment at 12 serverless functions, which is why
some features are folded into a single route rather than split out.

### Firestore collections

| Collection | Scope | Purpose |
|---|---|---|
| `leads` | flat, `tenantId`-filtered | CRM leads |
| `leads/{id}/notes`, `leads/{id}/history` | subcollections | Per-lead notes and audit log |
| `properties` | flat, `tenantId`-filtered | Dashboard listings |
| `properties/{id}/notes` | subcollection | Shared property notes and events |
| `propertyChanges` | flat, **append-only** | Dashboard edit log, sheet worklist, delete snapshots |
| `syncBackups/{runId}` | server-only | Pre-sync property snapshots |
| `pipelines/{tenantId}` | per-tenant | CRM stage definitions |
| `settings/{tenantId}` | per-tenant | Enquiry types, saved properties, digest and email settings |
| `botConfigs/{tenantId}`, `knowledgeConfigs/{tenantId}` | per-tenant | Bot persona and knowledge sources |
| `waNumbers/{phoneNumberId}`, `waSecrets/{tenantId}` | routing / server-only | WhatsApp number routing and per-tenant tokens |
| `users/{uid}` | per-user | Auth user → tenant and role |
| `conversations` | flat, `tenantId`-filtered | WhatsApp conversation history |
| `leadsSeededFlags`, `propertiesSeededFlags` | per-tenant | One-time sample-data seed markers |
| `dataDeletionRequests/{code}` | audit | Meta data-deletion callbacks |
| `config/*`, `meta/*` | legacy | Pre-multi-tenant, no longer written |

### Scripts

| Script | Run it when |
|---|---|
| `add-team-member.js` | Adding a person to an existing business — **the common one** |
| `create-tenant.js` | Onboarding a genuinely separate company |
| `deploy-firestore-rules.js` | After **any** `firestore.rules` change |
| `sync-inventory.js` | Sheet → dashboard sync; dry-run by default, `--apply` to write |
| `deliver-brochures.js` | Mac only, launchd, every 30 min |
| `connect-whatsapp-manual.js` | Connect a WhatsApp number without the Meta popup |
| `replace-brochure.js` | Replace an already-delivered brochure PDF |
| `backfill-property-links.js` | One-off: backfill photo/brochure/details links |
| `migrate-existing-tenant.js` | Already run once — do not re-run |
| `migrate-properties-tenant.js` | Already run once — safe but unnecessary |
| `migrate-notes-history-subcollections.js` | Already run once — idempotent |

---

## 13. Known gaps and technical debt

**Product**
- No roles or permissions. Everyone can edit and delete everything.
- No lead assignment — Analytics infers an "owner" from who last touched a lead.
- No in-app user management; adding and removing people is a script or console
  task.
- CRM lead deletion is permanent, with no recycle bin.
- The dashboard's **📋 Lead CRM** button navigates to the CRM but does not
  pre-fill the property on the new lead.
- No billing or plan limits — required before charging any external customer.

**Platform**
- The WhatsApp bot, the embedded-signup flow and Lead Ads intake are all absent
  or disabled ([section 9](#9-whatsapp-and-the-ai-bot)).
- The Inventory sheet is never written back to automatically; reconciliation is
  manual through the dashboard's Changes worklist. This is deliberate, but it
  depends on someone actually doing it.
- The brochure pipeline depends on a single Mac being awake.
- CRM Analytics classifies pipeline stages by **exact stage name**, so renaming
  a stage can silently change the metrics — see the stage-name rule in
  [`CRM.md`](CRM.md).

**Legal**
- `privacy-policy.html` and `terms.html` are drafts. Have them reviewed by a
  lawyer, particularly against India's DPDP Act 2023, before relying on them.
