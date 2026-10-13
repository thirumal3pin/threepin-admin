## 3E · Platform, data and automations

The platform is five static consoles on one navigation rail, backed by **Firebase** (sign-in, Firestore database, Storage for finance files) and **12 Vercel serverless functions** (the plan's limit, so several jobs share a route). There is one production tenant, `t_3pinrealty`.

### Sign-in, tenants and roles

- Everyone signs in with email and password. Each account carries a **tenant** tag; every database read and write is checked against it.
- **There are no enforced roles.** Every team member can do everything in every console, including Finance and Settings. "Editor", "voice-over person" and "team" are settings that route work and set default views, not permissions.
- People are added with `scripts/add-team-member.js`; the team list used for mentions, calendar and site visits is set with `scripts/set-team.mjs`.
- Signing out clears the browser's local copy of the data.

### The scheduled day (IST)

| Time | Job | What it does |
| --- | --- | --- |
| 04:30 | TailorTalk nightly sync | Pulls every chat active since the last sync, creates / updates leads, runs the AI on changed leads |
| 08:00 | Finance digest | Weekly summary (Mondays), renewals in 3 days, monthly P&L (the 2nd); maintains the ledger snapshot |
| 09:00 | Follow-up digest | Needs action, overdue, today, tomorrow, day after, @mentions — by email; then rebuilds the lead views |
| 21:30 | EOD dashboard summary | Escalations and the day's metrics by email |
| Every run on the Mac | Brochure delivery + Inventory sync | Delivers finished brochures, then copies the Inventory sheet into the dashboard |
| Every 5 min (CRM open) | Live refresh | Safety-net TailorTalk pull and due AI reads |

### Database (Firestore) — what each collection is

| Collection | One record is | Written by | Read by |
| --- | --- | --- | --- |
| `properties` (+ notes, internalNotes) | A property | Sheet sync, brochure pipeline, dashboard | Every console |
| `propertyChanges` | One dashboard edit (append-only) | Dashboard | Dashboard, sheet sync (protection) |
| `leads` (+ notes, history, tailortalk/state, aiRuns) | An enquiry | CRM, TailorTalk sync, AI, board | CRM, dashboard, board, crons |
| `leadViews` | `{tenant}__meta` (layout, off switch) and `{tenant}__v{n}_{i}` — ~20 leads packed as rows in one record, each stamped `_w` (read-cost saver: the CRM opens with 39 reads instead of 760) | Every lead writer (its row, in the same batch); the 09:00 rebuild; `scripts/lead-views.mjs` | CRM, dashboard, board |
| `listings` (+ history) | A Shoot & Media card | Board, seller sync | Board, CRM Daily task, dashboard |
| `postTracker` | A property's posting row | Posting | Board, dashboard |
| `pipelines/{tenant}`, `trackPipelines/{tenant}` | CRM columns; board columns | CRM; board | Both, crons |
| `settings/{tenant}` | Team, digests, AI switch, saved views, `trackConfig` | CRM, board, scripts | All |
| `finance/{tenant}/…` | The books | Finance | Finance, finance cron |
| `brochureLog`, `brochureDeliveryLog` | Brochure requests; deliveries | API | Create brochure page |
| `aiQueue`, `aiState`, `ttState`, `ttSignalEvents`, `ttDeadLetters` | AI and TailorTalk bookkeeping | Server only | Server only |

### Database rules (Firestore ruleset `132b5f73`, deployed 13 Oct 2026)

Every read and write is checked against the caller's tenant. Points worth knowing:

- **Leads:** a team member may `get` or delete a lead that does not exist (so a page can tell "deleted" from "not yours"), but for TailorTalk ids — `tt_<tenant>_<id>`, which can carry a phone number — that answer is given only for the caller's own tenant's ids, so nobody can test whether a number is another tenant's lead. Listing leads needs the tenant field; an update may never move a lead to another tenant.
- **Lead views:** readable by the tenant's team. A page may create or update a view document only with the keys `tenantId` and `rows`, touching **one row per write** — so no page can rewrite or empty a whole document. The meta record and the daily rebuilds are the server's (Admin SDK).
- **Finance ledger** (`txns`): a new entry must balance (debits = credits), carry at least one line and be dated on or after the books' start date; an entry is never deleted — only `reversedBy` and the reconciliation marks may change. The finance settings record (`finance/{tenant}`, including the Drive folder id) is readable and writable by any team member.
- **Property change log** (`propertyChanges`): append-only.

### Look and feel (UI v2)

Every console shares `shared-assets/theme.css`: the Inter typeface (served from `shared-assets/fonts/`, OFL licence), neutral greys, one accent (#FF8A00), 11 px minimum text and 24 px minimum tap targets, light and dark. `npm run audit:ui-all` checks every page at desktop and phone width in both themes.

### Integrations

| Service | Used for | Direction |
| --- | --- | --- |
| **TailorTalk** ("AIRA") | WhatsApp, Instagram and website AI agent; source of most leads | Webhook in; API pull; widget on the home page |
| **Google Sheets** | Inventory master (property facts); Queue (brochure intake) | Read by Vercel and the Mac; the Mac writes delivery results back |
| **Google Forms** | Brochure intake | Browser → form → Queue sheet |
| **Google Drive** | Photo folders, brochure PDFs, finance attachments | Upload via API; PDFs made link-readable |
| **Google Calendar** | Site visits, team meetings, shoots (only with the board's Settings switch on; off by default) | Two-way: invitations out, RSVPs back; repeating meetings handled one occurrence at a time |
| **Google Maps** | Map, nearby places, travel times | Browser |
| **Gemini 3.5 Flash-Lite** | Default lead-automation model | Server → Google |
| **Claude Haiku 4.5** | Lead summaries, lost-reason phrasing, alternative lead-automation model | Server → Anthropic |
| **Claude Cowork** (on the Mac) | Builds the brochure PDFs | Outside this repo |
| **Gmail (SMTP)** | Every outbound email | Server → Gmail |
| **Meta** | Optional WhatsApp digest delivery; data-deletion callback | Server → Meta |

### Release process

The last release was **13 Oct 2026** (`main` at `b48bfaa`, Firestore ruleset `132b5f73`); see *Release status* for what it carried.

1. Review → fix → re-review until clean; update every caller and test double together.
2. `npm test` (41 suites), the Playwright previews, and `npm run audit:ui-all` at desktop and phone width, light and dark.
3. **Deploy Firestore rules first** (`scripts/rules-diff.mjs`, then `rules-deploy.mjs`, or `deploy-firestore-rules.js`).
4. **Push `main`** — Vercel deploys automatically (no build step).
5. Confirm the live files match the commit, then run the signed-in live smoke test.
6. If the release touched how leads are written: `node scripts/lead-views.mjs verify` must print "IN STEP". `node scripts/lead-views.mjs off` makes every page read the leads directly again, within seconds.
