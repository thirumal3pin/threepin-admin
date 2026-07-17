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
| `firebase-sync.js` | Connects to Firebase, seeds the database on first run, and keeps every open browser in sync in realtime. |

Load order in `dashboard.html` matters: `sample-data.js` → `auth.js` →
`app.js` → `firebase-sync.js` (the last one is a `type="module"` script).

## Logging in

- **Username:** `admin`
- **Password:** `thirumal@threepin.in`

The whole dashboard is hidden behind a login screen until these are
entered correctly. Once logged in, the session is remembered in the
browser's `localStorage` (key `pinAdminAuthed`) — closing the tab or
reloading the page does **not** ask for the password again. Click
**Logout** in the header to clear it and return to the login screen.

To change the password, edit the two constants at the top of `auth.js`:
```js
const PIN_ADMIN_USER = 'admin';
const PIN_ADMIN_PASS = 'thirumal@threepin.in';
```

### ⚠️ Security note

This login is a **client-side check only**. It hides the dashboard UI from
casual visitors, but:
- The password is readable in `auth.js` by anyone who views page source.
- It does **not** protect the Firestore database itself — the security
  rules are currently open (`allow read, write: if true`), so anyone with
  the Firebase project config could read/write data directly via the API,
  bypassing this login entirely.

This is an accepted tradeoff for now (simplicity over security). If this
ever needs to be properly locked down, replace this with real Firebase
Authentication and matching Firestore security rules.

## How data flows (and fallback behavior)

- Properties and each property's "sold out" flag live in **Firebase
  Firestore** (project `pin-realty`), not in browser storage. Favorites
  and CRM notes stay local per-browser (`localStorage`) since those are
  personal, not shared.
- On the very first load ever, `firebase-sync.js` seeds Firestore with
  the 46 properties from `sample-data.js` (checked via a `meta/seeded`
  marker doc, so it only runs once).
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
  listing, document ID = property `id`), plus a `meta/seeded` marker doc.
- SDK: loaded from `https://www.gstatic.com/firebasejs/12.16.0/` via
  CDN — no `npm install` or build step needed.
