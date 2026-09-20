# The app rail

One navigation for every console. Properties (`dashboard.html`), the CRM
(`crm.html`) and Finance (`3pinfinance`) are separate pages with separate
stylesheets; this folder is the only thing all three share.

| File | What it does |
|---|---|
| `appnav.js` | The whole map, and the behaviour that drives it. Every page renders the same rail from it. |
| `appnav.css` | The rail, the phone drawer, the narrowed state, and the offsets the host pages need. |

## What it replaced

Each console used to advertise the others with loose buttons in its own
header — the dashboard had "Lead CRM", the CRM had "Property Intelligence"
and "Finance", Finance had nothing at all. Different buttons, different
order, different place on every page, and none of them saying where you
already were. The CRM's own four views (Board, List, Follow-ups, Analytics)
were a fifth set of controls on the same row.

All of that is one list now.

## The one rule

**A section header opens that section. It never navigates. An item inside it
navigates.** Only one section is open at a time, so clicking Finance is what
puts the finance pages on screen, and clicking CRM is what takes them away.
Two clicks to change console, and never a wrong guess about which of the two
a click was going to be.

Sections with nothing inside them — Daily task, Create brochure — have no
chevron and go straight there. There is no second level to open, so there is
nothing for the first click to mean.

The section holding the page you are on opens on load. Collapse it and it
keeps a dot, so a closed rail still says where you are standing.

## Adding a console

Add an entry to `MAP` in `appnav.js` and a `PAGES` destination. Nothing in
any header changes. On the new page:

```html
<link rel="stylesheet" href="shared-assets/appnav.css">
...
<button type="button" class="rail-toggle" data-rail-toggle aria-label="Show menu"></button>
...
<script src="shared-assets/appnav.js"></script>
```

```js
AppNav.boot({
  console: 'yours',
  select: nav => showThatView(nav),   // same page: no reload
  signOut: () => yourAuth.logout(),
});
AppNav.setActive('home');
const pending = AppNav.takeNav();     // arrived via ?nav=…
if (pending) setTimeout(() => select(pending), 0);
```

`AppNav.setUser(email)` fills the footer, and `AppNav.setBadge(key, n)` puts
a count beside an entry (`missing`, `followups`). A count of zero renders
nothing rather than a grey 0.

## How it takes each console's colours

Nothing here hardcodes a palette. Each host page already declares its own
tokens and the rail reads them through `[data-console]`, so it reads as a
continuation of the page rather than a strip bolted to its side. Finance is
light-only and calls its rules `--line`; the CRM carries a real dark theme
through `light-dark()`. Both work without a second palette to keep in sync.

## Where it does and does not cover the page

Full-bleed panels that replace the page — a property, a lead, the change log,
the bot editor — are pages, not dialogs, so they are inset by the rail's width
and sit beside it. You can leave for Finance without first closing what you
were reading. True modals (a scrim plus a dialog) cover the rail, which is
what a modal is for.

## On a phone

Below 900px the rail is off-canvas and the same menu button opens it as a
drawer over the page. Finance keeps its bottom tab bar — the four screens
used all day, with Record as the one that creates something — and its "More"
tab opens the rail rather than a second sheet listing the same pages a
different way.

## Tests

| | |
|---|---|
| `tests/appnav.test.mjs` | Runs in `npm test`. The rail duplicates Finance's nineteen view keys, labels and groups on purpose (it also runs on two pages that never load the finance module), so this fails the build if the two ever drift apart. Also checks every console the rail points at is a page in the repo and loads the rail. |
| `tests/appnav-preview.mjs` | Drives the real pages in Chromium with Firebase stubbed out — no login, no network. Checks the rail behaves identically on all three consoles at desktop and phone width, and screenshots each. |
