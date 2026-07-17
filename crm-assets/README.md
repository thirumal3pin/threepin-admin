# Lead CRM

`crm.html` (repo root) is a real estate lead management CRM — a kanban
pipeline board with manual lead entry, notes/follow-ups, customizable
stages, an optional live connection to Meta (Facebook/Instagram) Lead
Ads, and a customizable Claude-powered WhatsApp bot that qualifies
leads through conversation.

## Files

| File | What it does |
|---|---|
| `style.css` | All styling — kanban board, lead detail panel, modals, login screen. |
| `sample-leads.js` | 10 sample Chennai leads, seeded once so the board isn't empty on first login. |
| `app.js` | All CRM logic — board rendering, list view, add/edit/delete lead, stage manager, notes, search/filter. |
| `firebase-sync.js` | Firebase Authentication + Firestore realtime sync (leads + pipeline stages). |
| `../api/meta-webhook.js` | Vercel serverless function that receives Meta's Lead Ads webhook and writes leads into Firestore. |
| `../api/whatsapp-bot-webhook.js` | Vercel serverless function that receives WhatsApp messages, runs them through Claude, replies, and writes/updates the lead. |
| `../api/bot-test-message.js` | Authenticated endpoint the CRM's "Live Test Chat" panel calls to try the bot without a real WhatsApp message. |
| `../api/_bot-shared.js` | Shared code between the two bot endpoints above (system prompt builder, tool definition, Firebase Admin init). |

## How it's different from the property dashboard

The property dashboard (`dashboard.html`) uses a simple client-side
password check — fine for public listing data. This CRM holds real
buyer contact information, so it uses **real Firebase Authentication**
instead, plus Firestore security rules that reject any request that
isn't logged in. See "Security setup" below — **the CRM will not work
at all until you complete those steps.**

## Data model (Firestore)

- **`leads` collection** — one document per lead:
  `id, name, phone, email, propertyInterest, source ('manual'|'meta'), stageId, notes[], createdAt, updatedAt`
  — Meta-sourced leads additionally have `leadgenId, formId, adId, rawFieldData`.
- **`config/pipeline` doc** — `{ stages: [{id, name, color}, ...] }`,
  fully editable from the CRM's "Manage Stages" button (add, rename,
  recolor, reorder, delete). Leads reference stages by `stageId`, so
  renaming a stage doesn't break anything; deleting one moves its leads
  to the first remaining stage.
- **`config/leadsSeeded`** — marker doc so the sample leads only seed once.

## Security setup (required before this works)

### 1. Enable real login
- Firebase Console → your project → **Build → Authentication → Sign-in method**
- Enable **Email/Password**
- Go to the **Users** tab → **Add user** → enter the admin's real email
  and a real password. This is the only account that exists — the CRM
  has no self-signup, so add every teammate who needs access the same way.

### 2. Lock down the CRM's Firestore data
Go to **Firestore Database → Rules** and make sure `leads` and `config`
require login, while leaving `properties`/`meta` (used by the property
dashboard) as they were:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /properties/{docId} {
      allow read, write: if true;
    }
    match /meta/{docId} {
      allow read, write: if true;
    }
    match /leads/{docId} {
      allow read, write: if request.auth != null;
    }
    match /config/{docId} {
      allow read, write: if request.auth != null;
    }
    match /conversations/{docId} {
      allow read, write: if request.auth != null;
    }
  }
}
```
Click **Publish**. Until this is done, the CRM's data is exactly as
open as the dashboard's — do this before adding real lead data.

## Connecting Meta (Facebook/Instagram) Lead Ads

This requires a Meta Developer App and some setup only you can do
(it needs access to your own Facebook Page and ad account). Since
these are **your own** leads (not a multi-client platform), you do
**not** need Meta's lengthy App Review process — an app's own
admins/developers can retrieve leads from pages they manage
indefinitely in Development mode.

### 1. Create a Meta App
- Go to https://developers.facebook.com/apps → **Create App** → choose
  **Business** type.
- Add yourself (and anyone else who'll help configure this) as an
  **Admin** or **Developer** under **App Roles → Roles**.

### 2. Get your App Secret
- **App Settings → Basic** → copy the **App Secret** (click "Show").
  This becomes `META_APP_SECRET`.

### 3. Generate a Page Access Token
- Use **Graph API Explorer** (developers.facebook.com/tools/explorer),
  select your app, select your Page, and request these permissions:
  `pages_read_engagement`, `pages_manage_metadata`, `pages_show_list`,
  `ads_management`, `leads_retrieval`.
- Generate a **Page Access Token**, then use the
  [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/)
  to extend it to a long-lived token (60 days), or generate a
  non-expiring token via a **System User** in Business Manager if you
  want to avoid renewing it periodically.
- This becomes `META_PAGE_ACCESS_TOKEN`.

### 4. Subscribe your Page to the app
Using the Page token from step 3, make one API call (Graph API
Explorer works for this too):
```
POST /{your-page-id}/subscribed_apps?subscribed_fields=leadgen
```

### 5. Set up the webhook
- Pick any secret string yourself, e.g. `3pin_meta_webhook_2026` — this
  becomes `META_VERIFY_TOKEN`.
- In your Meta App → **Products → Webhooks** → add a callback:
  - **Callback URL:** `https://admin.threepin.in/api/meta-webhook`
  - **Verify Token:** the string you picked above
  - Subscribe to the **Page** object, **leadgen** field.

### 6. Get a Firebase service account key (for the webhook to write to Firestore)
- Firebase Console → **Project Settings → Service Accounts** →
  **Generate new private key** → downloads a JSON file.
- This becomes `FIREBASE_SERVICE_ACCOUNT_JSON` — paste the **entire
  file contents** as one line (it's just JSON, so it can go directly
  into a Vercel env var value).

### 7. Add all 4 values as Vercel environment variables
Vercel dashboard → your project → **Settings → Environment Variables**:

| Name | Value |
|---|---|
| `META_VERIFY_TOKEN` | the string you picked in step 5 |
| `META_APP_SECRET` | from step 2 |
| `META_PAGE_ACCESS_TOKEN` | from step 3 |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | from step 6 |

Redeploy after adding these (Vercel → Deployments → redeploy latest,
or just push any commit) — env vars only apply to new deployments.

### What happens once this is live
A visitor submits your Facebook/Instagram lead form → Meta calls
`/api/meta-webhook` → the function verifies the request is genuinely
from Meta (HMAC signature check against `META_APP_SECRET`) → fetches
the full submitted fields from Meta's Graph API → writes a new lead
into Firestore with `source: 'meta'` → it appears on the CRM board
in the first pipeline stage, in realtime, for every logged-in user.

If something's misconfigured, check the function's logs in Vercel →
your project → **Functions** tab — errors are logged there (bad
signature, Graph API errors, Firestore write failures, etc.), nothing
fails silently.

## WhatsApp AI Bot

The **🤖 AI Bot** button in the CRM opens a workflow editor: Role &
Persona, Welcome Message, Required Info to collect, Conversation Steps,
and Guardrails — all editable, saved to Firestore (`config/whatsappBot`),
and used to build the system prompt for every conversation. A **Live
Test Chat** panel lets you try the bot immediately with your current
draft, before ever saving or connecting a real WhatsApp number.

### ⚠️ Real, ongoing costs — read before enabling

Unlike the rest of this project, this feature calls a **paid API per
message**:
- **Anthropic (Claude) API** — billed per message, using
  `claude-opus-4-8` (Anthropic's most capable model). Check current
  pricing at https://platform.claude.com/docs/en/pricing before going
  live with real traffic. If you want a cheaper/faster model for a
  high-volume bot, that's a one-line change in
  `api/_bot-shared.js`/`api/whatsapp-bot-webhook.js`/`api/bot-test-message.js` — ask
  and it can be swapped, but it isn't done by default.
- **WhatsApp Business Platform** — Meta charges per conversation once
  you're past the free tier, separate from Anthropic's pricing.

### 1. Get an Anthropic API key
- Go to https://console.anthropic.com → **API Keys** → create a key.
- Add billing there (a card on file) — the key won't work without it.
- This becomes `ANTHROPIC_API_KEY`.

### 2. Set up WhatsApp Business Cloud API
This is separate from Meta Lead Ads above, but can live in the **same**
Meta App. Your real WhatsApp Business number can only be connected to
**one** integration at a time — if it's currently used elsewhere (e.g.
a tool like TailorTalk), either disconnect it there first, or test this
on a different number / Meta's free test number until you're ready to
switch over.

- In your Meta App → **Add Product → WhatsApp** → follow the setup
  flow to create/select a **WhatsApp Business Account** and a phone
  number (Meta gives you a free test number instantly — good enough to
  fully test this feature before using your real number).
- **Business Settings → Users → System Users** → create a System User,
  generate a token with `whatsapp_business_messaging` and
  `whatsapp_business_management` permissions. This becomes
  `WHATSAPP_ACCESS_TOKEN`.
- From the WhatsApp product's **API Setup** page, copy the **Phone
  Number ID** — becomes `WHATSAPP_PHONE_NUMBER_ID`. Also enter the
  number itself and this ID into the CRM's Bot Editor "WhatsApp
  Connection" fields, so the status shows as connected.
- Pick any secret string yourself for verification, e.g.
  `3pin_wa_webhook_2026` — becomes `WHATSAPP_VERIFY_TOKEN`.
- **WhatsApp → Configuration → Webhook** → set:
  - **Callback URL:** `https://admin.threepin.in/api/whatsapp-bot-webhook`
  - **Verify Token:** the string you picked above
  - Subscribe to the **messages** field.
- The webhook signature check reuses `META_APP_SECRET` (same value as
  the Lead Ads setup above — Meta signs all webhook types with the
  same app secret).

### 3. Add the new Vercel environment variables
In addition to `META_APP_SECRET` and `FIREBASE_SERVICE_ACCOUNT_JSON`
(already set up for Lead Ads), add:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | from step 1 |
| `WHATSAPP_VERIFY_TOKEN` | the string you picked in step 2 |
| `WHATSAPP_ACCESS_TOKEN` | the System User token from step 2 |
| `WHATSAPP_PHONE_NUMBER_ID` | from step 2 |

Redeploy after adding these — env vars only apply to new deployments.

### What happens once this is live
Someone messages your WhatsApp number → Meta calls
`/api/whatsapp-bot-webhook` → the function verifies the request is
genuinely from Meta → loads your saved workflow from Firestore → sends
the conversation to Claude, which replies conversationally **and**
calls a tool to record any new info it learned (name, area, budget,
property type) → the reply is sent back over WhatsApp → the lead is
created/updated on your CRM board with `source: 'whatsapp_bot'`, in
realtime, first pipeline stage, ready to hand off to a human.

### Data model additions
- **`config/whatsappBot` doc** — the structured workflow (role,
  welcomeMessage, requiredInfo[], steps[], guardrails[], tone,
  waPhoneNumber, waPhoneNumberId), fully editable from the Bot Editor.
- **`conversations/{phone}` collection** — one doc per WhatsApp number,
  holding the full message history and extracted info for that
  conversation. Not yet surfaced in the CRM UI beyond the lead itself.

### Security note
`/api/bot-test-message` requires a valid Firebase Auth ID token (the
same login as the rest of the CRM) — this stops random visitors from
running up your Anthropic bill by hitting the test endpoint directly.
The real `/api/whatsapp-bot-webhook` is protected the same way the Lead
Ads webhook is: HMAC signature verification against `META_APP_SECRET`,
not authentication (Meta's webhook caller has no user session to
authenticate).
