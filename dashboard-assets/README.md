# Property Intelligence Dashboard

`dashboard.html` (in the repo root) is a single-page property CRM for 3 PIN
Realty. This folder holds everything it loads — the HTML file itself stays
a thin shell so edits touch one small file instead of a 1000+ line page.

## Files

| File | What it does |
|---|---|
| `style.css` | All styling, including the login screen. |
| `sample-data.js` | The 46 starter properties, used to seed Firestore once and to paint the page instantly on first load. |
| `auth.js` | The login gate (see below). |
| `app.js` | All dashboard logic — filters, search, cards, add/edit/delete, sold-out, notes, favorites, compare, export. |
| `firebase-sync.js` | Connects to Firebase, handles login, seeds the database on first run, and keeps every open browser in sync in realtime. |

Load order in `dashboard.html` matters: `sample-data.js` → `auth.js` →
`app.js` → `firebase-sync.js` (the last one is a `type="module"` script).

## Logging in

Real **Firebase Authentication** — the same Firebase project, tenant
(`t_3pinrealty`), and accounts as `crm.html`. Log in with the same
email/password used there (e.g. `3pinrentals@gmail.com` or
`thirumal@threepin.in`). There's no separate dashboard-only password list
anymore; to give someone dashboard access, give them a CRM login via
`scripts/add-team-member.js --tenantId t_3pinrealty` (see `docs/SOP.md`) —
they'll then be able to log into both `crm.html` and `dashboard.html` with
the same credentials.

Session persistence is handled by the Firebase SDK itself (it stays signed
in across reloads until you click **Logout**), not `localStorage`.

### Security

- Firestore security rules (`firestore.rules`) enforce that only signed-in
  users with a `tenantId` claim can read/write `properties`, and only for
  their own tenant — scoped exactly like the CRM's `leads` collection.
- Before deploying the updated rules, run
  `node scripts/migrate-properties-tenant.js` once — it backfills
  `tenantId` onto every property doc that predates this change, so
  existing listings aren't locked out.

## How data flows (and fallback behavior)

- Properties and each property's "sold out" flag live in **Firebase
  Firestore** (project `pin-realty`), scoped by `tenantId`, not in browser
  storage. Favorites and CRM notes stay local per-browser (`localStorage`)
  since those are personal, not shared.
- On first login for a tenant with no properties yet, `firebase-sync.js`
  seeds Firestore with the 46 properties from `sample-data.js` (checked via
  a `propertiesSeededFlags/{tenantId}` marker doc, so it only runs once per
  tenant).
- After that, a realtime listener (`onSnapshot`) means every add / edit /
  delete / sold-out toggle appears on **every other open browser within
  seconds**, no refresh needed.
- **If Firestore is unreachable** (offline, network issue, Firebase
  outage): the page still renders instantly using the bundled
  `sample-data.js` as a local fallback, so the dashboard never shows a
  blank page. However, any add/edit/delete/sold-out actions made while
  disconnected will **not** sync anywhere — they'll only appear in that
  one browser tab until the connection recovers, and errors are logged
  to the browser console (`Firestore save error:` / `Firestore sync
  error:`), not shown to the user.

## Firebase project

- Console: https://console.firebase.google.com → project `pin-realty`
- Database: Firestore, collection `properties` (one document per
  listing, document ID = property `id`, each with a `tenantId` field),
  plus a `propertiesSeededFlags/{tenantId}` marker doc per tenant.
- SDK: loaded from `https://www.gstatic.com/firebasejs/12.16.0/` via
  CDN — no `npm install` or build step needed.
