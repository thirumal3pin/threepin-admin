# Property Intelligence Dashboard

`dashboard.html` (in the repo root) is a single-page property CRM for 3 PIN
Realty. This folder holds everything it loads — the HTML file itself stays
a thin shell so edits touch one small file instead of a 1000+ line page.

## Files

| File | What it does |
|---|---|
| `style.css` | All styling, including the login screen. |
| `sample-data.js` | The 46 starter properties, used to seed Firestore once and to paint the page instantly on first load. |
| `search-engine.js` | The search itself: query parsing, numeric ranges, synonyms, fuzzy names, scoring, and the facets the Advanced panel is built from. No DOM — `tests/property-search.test.mjs` runs it over a real inventory snapshot. |
| `advanced-search.js` | The Advanced Search panel: the filter drawer, the active-filter chips and the live result count. Every filter and count comes from `search-engine.js`, nothing is hand-listed. |
| `auth.js` | The login gate (see below). |
| `app.js` | All dashboard logic — filters, search, cards, add/edit/delete, sold-out, notes, favorites, compare, export. |
| `nav-boot.js` | Wires this page into the shared app rail (`../shared-assets/`). All properties, Missing data and Changes are panels this page already has, so the rail toggles them rather than navigating; Sync and Create brochure open as dialogs and leave the highlight on the page underneath. |
| `firebase-sync.js` | Connects to Firebase, handles login, seeds the database on first run, and keeps every open browser in sync in realtime. |

Load order in `dashboard.html` matters: `sample-data.js` → `search-engine.js`
→ `advanced-search.js` → `auth.js` → `property-view.js` → `app.js` →
`brochure-form.js` → `appnav.js` → `nav-boot.js` → `firebase-sync.js` (the
last one is a `type="module"` script). The two search files are plain scripts
on purpose, so `window.PinSearch` and `window.PinAdvanced` exist before
`app.js` runs; `nav-boot.js` comes after both `app.js` and `appnav.js`
because it wraps functions from the first and calls into the second.

## Searching

Two ways in, one engine behind both.

**The box** takes what an agent would say out loud. Numbers are understood as
numbers, not as text: `1518 sqft` matches a project listing `1,250–2,000`
because 1,518 falls inside it, and `uds 1,140` and `uds 1140` are the same
search. `3 and 4 bhk in anna nagar and adyar` is read the way it is meant —
"and" between two values of ONE field is an OR — and `-plot`, `not resale`,
`under 1.5cr`, `between 1 and 2 cr`, `sqft:>2000`, `builder:sobha` and
`"exact phrase"` all work. Misspelt localities and builders still land.
When a search finds nothing, the whole query is retried as plain words before
the grid is emptied.

Every card in a search result carries one quiet line saying which field
matched — the answer to "why is this one here", which matters most for the
matches that are hardest to guess.

**The Advanced panel** is for a brief with several parts. Values inside one
filter are OR; filters are combined by the ALL/ANY switch. Every filter,
option and count is derived from the live inventory by
`PinSearch.buildFacets`, and the count on a chip is exactly what that chip
returns — asserted per chip in the test suite.

Run the tests with `npm run test:search`. For screenshots of the real page,
serve the repo (`python3 -m http.server 5199`) and run
`node tests/search-preview.mjs`.

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
