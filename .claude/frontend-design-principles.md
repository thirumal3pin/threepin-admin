# Frontend Design Principles — 3 PIN Admin, UI v2

The admin is a tool people work in all day: CRM, Shoot & Media, Properties, Finance. It should read
calm, precise and premium — every console in the same visual language, nothing that tires the eye,
nothing out of line. **v2 is set by the owner's reference: the Listing page** (sidebar with Home /
Listings / Settings, the code `NGMA0001`, "3 BHK · Apartment · Nungambakkam", ₹1.25 Cr, the status
grid, "Details filled in"). When in doubt, make it look like that page.

Everything below lives in code in **one place: `shared-assets/theme.css`**, loaded LAST on every page
(after the page's stylesheet and inline styles). A page never re-declares a font, a grey or the
accent; it uses the tokens.

---

## 1. Type — Inter, one family

- **Inter** (variable, 100–900), self-hosted: `shared-assets/fonts/` (OFL 1.1 licence beside it).
  Preloaded on every page; no Google Fonts, so no third-party request and no late swap.
- One family for text, headings, figures and labels. **No serif display face.** `--serif` and
  `--mono` both resolve to Inter; figures that must line up use `font-variant-numeric: tabular-nums`.
- A true monospace (`--code`: SF Mono / Cascadia Mono / Menlo / Consolas) only for **codes** —
  property codes like `NGMA0001`, set bold with wide tracking (`.08–.12em`), as in the reference.
- Normal double-storey "a" (no `cv11`). Body tracking `-0.006em`; headings `-0.017em`.

| Role | Size / weight | Example from the reference |
|---|---|---|
| Page title | 20px / 600 | "Listing" |
| Record title | 18–20px / 600 | "3 BHK · Apartment · Nungambakkam" |
| Key figure | 20px / 650, tabular | "₹1.25 Cr" |
| Section title | 16px / 600 | "Status", "Details filled in", "Photos 4" |
| Body / controls | 14px / 500 | buttons, tabs, menu items |
| Secondary | 13px / 400, `--ink3` | "Add the area, the floor, which way it faces." |
| Micro label / chip | **11px minimum** / 600 | "Available" pill, counts |

**Eye strain rule:** nothing a person must read is under 11px. 10px and below only for decoration
that repeats something said elsewhere.

## 2. Colour — neutral greys, one accent

| Token | Light | Use |
|---|---|---|
| `--bg` | `#F8F8F8` | page ground |
| `--card` | `#FFFFFF` | cards, panels, the sidebar |
| `--bg2` | `#F2F2F2` | recessed: the current menu item, inputs at rest, chips |
| `--border` | `#E6E6E6` | hairlines on every card and control |
| `--border2` | `#D4D4D4` | stronger divider, scrollbar thumb |
| `--ink` | `#171717` | text |
| `--ink2` / `--ink3` / `--ink4` | `#3D3D3D` / `#5C5C5C` / `#686868` | secondary text — each AA on white, `--bg` and `--bg2` |
| `--brand` | `#FF8A00` | the accent — solid fills only |
| `--brand-ink` | `#A35A00` | orange **text** on white (5.1:1) |
| `--brand-soft` / `--brand-line` | `#FFF4E6` / `#FFD9AD` | tinted surface + hairline |

- **Neutral, not warm.** v1's cream/stone tint (`#F7F6F2`, `#E5E1D9`) is retired.
- **Text on solid orange is dark** (`--on-brand` `#1A1206`, 8:1). White on `#FF8A00` is only 2.4:1 —
  below AA for any text size — so the reference's white-on-orange is drawn dark here. (One token:
  if white is ever wanted, it is changed in one place, knowingly.)
- **Orange as text** (a link, a small label) is `--brand-ink` `#A35A00` (5.1:1), never `--brand`.
- **The accent is spent in one place at a time:** the selected status (solid orange, dark text),
  the active tab's underline, the current menu item's icon tile, the progress bar, the primary
  button. Never orange body text on white (use `--brand-ink`), never two competing orange things
  in one row.
- **Semantic colours** (`--green`, `--red`, `--blue`, `--purple`) are states, never decoration;
  text on a tinted state surface is that state's own colour. A count on solid red is white in light
  and near-black (`#2A0A0A`) in dark.
- **Dark theme** (CRM, Shoot & Media): blue-slate grounds, the same roles; every grey re-checked
  for AA on every dark surface. Light-only pages (Dashboard, Finance) never ask for the dark half.

## 3. Shape and space

- Radius scale: **6** chips · **10** buttons, inputs, rows · **12** cards, columns, panels ·
  **16** dialogs and sheets. Nothing else.
- 4px grid: 4 · 8 · 12 · 16 · 20 · 24 · 32. Card padding 16–20; gaps between cards 12–16; a
  section title sits 12 above its content.
- **Cards lie flat**: white, 1px `--border`, no shadow. Shadow only for what floats (menus,
  dialogs, a dragged card).
- **Even layouts**: siblings share a size (the status grid's four equal buttons), columns align,
  labels start on one line. Screenshot with the worst-case data (longest names, empty states,
  ₹ crores, 40 items) before shipping.
- **No sideways scroll** — the board is the only horizontal scroller, inside itself. Anything that
  would overflow folds behind a "Filters"-style button with a count. On a phone, a console's filters
  fold behind that button by default (CRM, Shoot & Media): the work starts under the search box.
- **Rows line up**: a filter row starts and ends exactly where the search box above it does; every
  control in a row is the same height, with the same caret (selects sized to their value with
  `field-sizing: content`, not to their longest option).
- **A pick of 2–4 short options** (listing type) is a row of pills, the chosen one filled in ink;
  picking it again clears it. More options, or long ones: a select.
- **Checklists** (documents): the item on the left, its status select on the right at one fixed
  width, colour on the status text only (green in hand, amber applied, red missing). A checklist or
  a reminder ("Brochure v2?") **informs and never blocks** — it is not a stuck reason, raises no
  alert and moves no card. Optional extras (a final-video link) appear only where they apply, marked
  "optional".

## 4. Side menu

As the reference: white rail, hairline right edge; each entry a 26px icon box + label; the
**current entry on a `--bg2` pill with its icon in a solid orange tile (white glyph)**; others grey
icons. Every icon occupies the same 26px box so labels align whether or not they are current.

## 5. Motion — modern CSS, one vocabulary

- Tokens: `--ease-out` (arrivals), `--ease-spring` (a `linear()` spring for press/pick/open),
  `--dur-1/2/3` = 120 · 200 · 320ms (feedback · small surfaces · panels).
- **Between consoles:** cross-document View Transitions (`@view-transition { navigation: auto }`),
  the side menu held in place (`view-transition-name: app-rail`), content cross-fades.
- **Controls:** background/border/shadow ease on hover; a press settles with the `scale` property
  (never `transform`, so it composes with whatever already positions the element). **Text colour is
  never transitioned** (and nothing uses `transition: all`): when the system theme flips — an
  iPhone does it at sunset — Chrome and Safari can leave a mid-transition text colour at the old
  scheme's value (dark text on a dark panel). The shared script also holds every transition for the
  one frame the scheme changes (`.scheme-flip`).
- **Surfaces:** menus and dialogs arrive from 4–14px with a fade; `interpolate-size:
  allow-keywords` lets heights animate to `auto`. Newer patterns welcome where they help:
  `@starting-style` for entry, `transition-behavior: allow-discrete` for display changes,
  scroll-driven animations for subtle header states.
- Motion explains a change; it never decorates. Nothing loops except a live indicator.
- **`prefers-reduced-motion: reduce` turns all of it off** (and view transitions).

## 6. Writing

- Write from the user's side of the screen; plain words, sentence case, active verbs.
- Same action, same name through a flow ("Plan edit" → "Start edit" → "Edit done").
- Failures say what happened and what to do, without apology. Empty states invite the next step.

## 7. Quality gate — every UI change, before it ships

1. **`node tests/ui-audit-all.mjs`** (`npm run audit:ui-all`) — runs every page preview; on every screenshot (every view, desktop
   and phone) it audits the screen as shot **and in the other colour scheme** for:
   page overflow · overlapping text · clipped text without an ellipsis · any text not in Inter
   (a cascade collision — e.g. a class named `far`, which Font Awesome also styles) · WCAG AA
   contrast against what is really behind the text · text under 11px · phone tap targets under
   24×24. It must report **no overflow, overlap, clipping, wrong font or contrast failure**.
2. All unit tests (`npm test`) and every page preview pass.
3. Screenshots looked at by eye — desktop 1440 and phone 390, light and dark — against the
   reference: alignment, rhythm, one accent, nothing straining the eye.
4. Keyboard focus visible (brand ring on `:focus-visible`), reduced motion respected.
5. Class names never collide with a library's: no bare `fa`, `far`, `fas`, `fab` as state classes
   (a stage-age chip named `far` was drawn in the icon font).
6. Engineering gates that run with every `npm test`: `tests/syntax.test.mjs` (every JS file and
   inline script parses), `tests/css.test.mjs` (every stylesheet and inline `<style>` well-formed —
   a stray `}` silently discards the next rule; one hid a whole Dashboard `@media` block), `tests/sdk-stubs.test.mjs` (every Firebase stand-in a test serves offers
   every name the pages import — else a page module silently fails to load in its preview).

---

**In one line:** Inter on neutral white, one orange spent where the decision is, flat cards on a
4px rhythm, motion that explains — and an audit that proves every screen before it ships.
