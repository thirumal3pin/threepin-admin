# 3 PIN Realty — Multi-Tenant WhatsApp Bot SOP

Operating manual for the multi-tenant CRM + AI WhatsApp bot platform. Covers
one-time setup, onboarding a new customer, and what everything does.

---

## 1. What this system is

A SaaS product: each customer signs up, connects their own WhatsApp Business
number through a Meta popup inside the CRM, and gets an isolated AI bot +
lead CRM. Under the hood, every customer is a **tenant** — identified by a
`tenantId` — and every piece of data (bot config, knowledge base, leads,
conversations) is scoped to that tenant so customers never see each other's
data.

Your own business (3 PIN Realty) was migrated in as the first tenant:
`tenantId = t_3pinrealty`.

**Stack**: static site (`crm.html`, `dashboard.html`) + Vercel serverless
functions (`api/*.js`) + Firebase (Firestore + Auth), project `pin-realty`.
Deploys automatically on every push to `main` (Vercel ↔ GitHub integration),
live at `https://threepin-admin.vercel.app`.

---

## 2. One-time platform setup (you've already done most of this)

### 2.1 Meta App configuration

Go to [developers.facebook.com](https://developers.facebook.com) → your app.

| Where | What to set | Why |
|---|---|---|
| Settings → Basic | **App ID**, **App Secret** | App ID is public (client-side popup); App Secret verifies webhook signatures — never exposed client-side |
| Settings → Basic | **Privacy Policy URL** = `https://threepin-admin.vercel.app/privacy-policy.html` | Required before App Review will approve anything |
| Settings → Basic | **Terms of Service URL** = `https://threepin-admin.vercel.app/terms.html` | Recommended, some review paths require it |
| App Review → Permissions and Features | Request `whatsapp_business_management` (currently: **Ready for testing**) | Governs whether real, unaffiliated customers can use the Embedded Signup popup |
| WhatsApp → Configuration | Create an **Embedded Signup Configuration** | Produces the Configuration ID the popup uses |
| WhatsApp → Configuration (webhook) | Callback URL = `https://threepin-admin.vercel.app/api/whatsapp-bot-webhook`, Verify token = your `WHATSAPP_VERIFY_TOKEN`, subscribe to field `messages` | So Meta forwards inbound WhatsApp messages to your bot |
| Facebook Login → Settings | Data Deletion Request URL = `https://threepin-admin.vercel.app/api/data-deletion-callback` | Required for App Review — Meta calls this when a user asks Meta to delete their app data |
| Webhooks (Page/Lead Ads, if used) | Callback URL = `https://threepin-admin.vercel.app/api/meta-webhook`, Verify token = your `META_VERIFY_TOKEN`, subscribe to field `leadgen` | Facebook/Instagram Lead Ads → CRM |

### 2.2 Vercel environment variables

All set via `vercel env add <NAME> production` or the Vercel dashboard
(Project → Settings → Environment Variables). Current state as of this SOP:

| Variable | Set? | Secret? | Used by / purpose |
|---|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | ✅ | Yes | All server-side Firestore/Auth access (`api/_bot-shared.js`) |
| `META_APP_SECRET` | ✅ | Yes | Verifies webhook signatures (both webhooks); token exchange in Embedded Signup |
| `META_APP_ID` | ✅ | No (but stored as env for convenience) | Served to the client via `/api/public-config`; also used server-side for the Embedded Signup token exchange |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | ✅ | No | Served to the client via `/api/public-config`; tells the popup which signup flow to run |
| `ANTHROPIC_API_KEY` | ❌ still missing | Yes | Claude replies — both the live bot and the CRM's "Test Message" button. **Nothing will reply to a real WhatsApp message until this is set.** |
| `WHATSAPP_VERIFY_TOKEN` | ❌ still missing | Yes (treat as one) | Meta's webhook handshake for `/api/whatsapp-bot-webhook` — must match what you type into the Meta webhook config |
| `META_VERIFY_TOKEN` | ❌ still missing | Yes (treat as one) | Same, for `/api/meta-webhook` (Lead Ads) — only needed if you use Lead Ads |
| `META_PAGE_ACCESS_TOKEN` | ❌ still missing | Yes | Only needed for Lead Ads (`api/meta-webhook.js`) |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Legacy fallback only | — | Only used if a tenant has no `waSecrets` doc yet (pre-migration safety net) — not required going forward, every new tenant gets credentials via Embedded Signup instead |

**Do this next**: set `ANTHROPIC_API_KEY` and `WHATSAPP_VERIFY_TOKEN` — without them the bot cannot reply to anyone.

```bash
vercel env add ANTHROPIC_API_KEY production
vercel env add WHATSAPP_VERIFY_TOKEN production
```

### 2.3 Firestore

Security rules live in `firestore.rules` in this repo and are already
deployed (via the Firebase Rules API, using the service account — see
`scripts/` history). If you ever hand-edit rules in the Firebase Console,
copy them back into `firestore.rules` afterward so the repo stays the
source of truth.

---

## 3. Onboarding a new customer (tenant)

Accounts are **admin-provisioned** — there's no public signup page yet.

```bash
node scripts/create-tenant.js --email owner@customer.com --business "Customer Business Name"
```

This creates their Firebase Auth login, generates a `tenantId`, seeds a
default bot config, and prints a temporary password (share it with them
securely — it's not stored anywhere, so save it now if you need it later).

Then tell the customer:
1. Go to `https://threepin-admin.vercel.app/crm.html`
2. Log in with the email/password you gave them
3. Click **AI Bot** → **Connect WhatsApp via Meta**
4. Complete the popup using their own WhatsApp Business Account login

That's it — their bot, knowledge base, and leads are fully isolated from
every other tenant from that point on.

---

## 4. Testing before going fully live

Your `whatsapp_business_management` permission is "Ready for testing" —
meaning the popup works today for **test** WhatsApp Business Accounts you
explicitly add, not yet for random real customers.

1. Meta App Dashboard → **Roles → Test Users** (or **WhatsApp → API Setup**
   test number) — add a test WhatsApp Business Account.
2. Provision a test tenant: `node scripts/create-tenant.js --email test@yours.com --business "Test Co"`.
3. Log into `crm.html` as that test tenant, click **Connect WhatsApp via
   Meta**, complete the popup with the test account.
4. Send a WhatsApp message to the test number from your phone; confirm the
   bot replies and a lead appears under that tenant's CRM — not
   `t_3pinrealty`'s.

## 5. Going live for real customers

Once testing looks good: App Review → Permissions and Features →
`whatsapp_business_management` → **Request**. Meta reviews your app (they
may ask for a screen recording of the exact flow above). Once approved, the
same popup works for any real customer — no code changes needed.

---

## 6. Reference — what each piece does

### API endpoints (`api/*.js`)

| Endpoint | Purpose |
|---|---|
| `whatsapp-bot-webhook.js` | Receives inbound WhatsApp messages from Meta, resolves the tenant, replies via Claude |
| `whatsapp-embedded-signup.js` | Exchanges the popup's authorization code for a per-tenant WhatsApp token |
| `meta-webhook.js` | Receives Facebook/Instagram Lead Ads submissions |
| `knowledge-sync.js` | CRM's knowledge-base connectors (Google Sheet/Doc links, uploaded files) |
| `bot-test-message.js` | Powers the CRM's "Test Message" preview chat |
| `public-config.js` | Serves the non-secret Meta App ID / Config ID to the static CRM page |
| `data-deletion-callback.js` / `data-deletion-status.js` | Meta's required data-deletion compliance callback |
| `_bot-shared.js` | Shared helpers (not a route) — auth verification, tenant resolution, prompt building |

### Firestore collections

| Collection | Scope | Purpose |
|---|---|---|
| `botConfigs/{tenantId}` | Per-tenant | Bot persona + connected WhatsApp number metadata |
| `knowledgeConfigs/{tenantId}` | Per-tenant | Knowledge-base sources fed into the bot's prompt |
| `pipelines/{tenantId}` | Per-tenant | CRM Kanban stage definitions |
| `waNumbers/{phoneNumberId}` | Routing table | Maps a WhatsApp number → owning tenant (webhook routing) |
| `waSecrets/{tenantId}` | Server-only | Per-tenant WhatsApp access token — never client-readable |
| `users/{uid}` | Per-user | Maps a Firebase Auth user → their tenant + role |
| `leads`, `conversations` | Flat, `tenantId`-filtered | CRM leads and WhatsApp conversation history |
| `dataDeletionRequests/{code}` | Audit log | Records from the Meta data-deletion callback |
| `properties`, `config/*`, `meta/*` | Legacy / dashboard.html | Unrelated to the multi-tenant bot — property listings still single-tenant (see §7) |

### Scripts

| Script | Run when |
|---|---|
| `scripts/create-tenant.js` | Onboarding a new customer |
| `scripts/migrate-existing-tenant.js` | Already run once — do not re-run unless onboarding a *second* pre-existing business the same way |

---

## 7. Known gaps / not yet done

- **`dashboard.html` (property listings)** is still single-tenant and has no
  real Firebase Auth (only a hardcoded password gate) — it was explicitly
  out of scope for this conversion. Its `properties` collection remains
  fully open in Firestore rules.
- **Lead Ads (`api/meta-webhook.js`) multi-tenancy** was deferred — it still
  reads the legacy `config/pipeline` doc rather than being tenant-routed.
- **Privacy Policy / Terms of Service** (`privacy-policy.html`, `terms.html`)
  are drafts — have a lawyer review before relying on them, especially
  against India's DPDP Act 2023.
- **Billing/plan limits** — not designed yet; needed before charging real
  customers.
