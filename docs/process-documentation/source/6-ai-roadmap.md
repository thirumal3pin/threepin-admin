# AI & Automation Roadmap (text copy)

> **Superseded on 14 Oct 2026** by `7-ai-proptech-strategy.md` (the 10× plan), which covers every area with current status, why, financial and business impact, agent time and sequencing. Kept for reference.

Mirror of the living doc https://claude.ai/code/artifact/5dc896b9-92c5-46cc-a802-500142160b36 — keep both in step. Sources are listed in the living doc. As of 13 Oct 2026.

## Verdict

3 PIN is ahead of most brokerages in AI lead placement, buyer–property matching and the shoot-to-post media pipeline, but behind the best platforms in capturing calls, acting on a spoken or typed command, chasing sellers automatically, and pushing listings to portals and buyers.

| Area | 3 PIN today | Best in class, Oct 2026 | Position |
| --- | --- | --- | --- |
| Chat intake and AI qualification | TailorTalk + lead AI | Ylopo, Lofty, Sell.Do | On par |
| AI pipeline placement with human override | Forward-only moves, suggestions, 7-day undo | Few products move stages at all | Ahead |
| Buyer ↔ property matching | One engine in three consoles | BoldTrail, Zillow Pro (behaviour signals) | On par |
| Shoot → edit → V/O → post tracking | Per-outlet cuts, gates, URL saved | Aryeo booking only | Ahead |
| Call recording → notes → next step | Not built | Sell.Do, Follow Up Boss, CINC | Gap |
| Voice / text command assistant | Not built | Rechat, Lofty, Compass | Gap |
| AI voice agent for new leads | Not built | Sell.Do Jarvis (Tamil), Ylopo | Gap |
| Chasing sellers for missing details | Staff worklist only | No vendor does it well | Chance to lead |
| Portal syndication | By hand, URL recorded | Sell.Do two-way sync | Gap |
| New listing → matched-buyer outreach | By hand | BoldTrail, 99acres | Gap |
| Daily briefing / weekly AI report | Rule-based digests | Compass AI briefing | Partly |
| Listing media AI | Brochure via Claude Cowork | Virtual Staging AI, AutoReel, Restb.ai | Partly |
| E-sign | Not built | Leegality, Digio | Gap |

## Four flagship workflows

1. **One command books a site visit** — “Schedule the site visit for client Shiva at Anne property, 2 pm tomorrow”: finds lead and property, picks a free agent by rule, one-tap confirm, WhatsApp confirmation with map pin and agent, reminders and a task. Plugs into `api/tailortalk.js ?action=assistant`, `_calendar-shared.js`, Daily task.
2. **Every call updates the lead** — calls through Exotel/Ozonetel numbers, recorded with consent, Tamil + English transcription, read by the existing lead AI: note, follow-up, interest, stage, visit.
3. **Seller autopilot** — WhatsApp intake against the 30-field checklist, document reading and checks, one-tap Swami approval, e-signed agreement for Exclusive/Collab, shoot booked by rule, nudges for missing papers, website and 99acres listing, matched-buyer outreach.
4. **Briefings write themselves** — agent morning brief; Monday report on visits, feedback themes, media pipeline and what to change.

## Re-analysis: data already held, unused by any AI

Scale: about 519 leads and 131 properties (0 with map coordinates, 60 with details text) — use transparent scores, simple statistics recalibrated quarterly, and LLM judgement over text; no trained models.

| Data | Where | Could power |
| --- | --- | --- |
| TailorTalk signals with quotes (no match, loan help, ready to close) | `ttSignalEvents` — read by nothing | Unmet-demand ledger, loan-partner feed, prompt quality |
| Chat history, AI profile, bookings, payments | `leads/{id}/tailortalk/state` | Objections, price ceilings, coaching, referrals |
| Milestone dates and who moved the lead | `lead.reached`, `history` | Conversion and speed by source, ad, locality, agent |
| AI verdicts and human dismissals / undos | `aiRuns`, `ai.dismissed` | Measured AI accuracy, regression set |
| Ad origin, escalation and reply times | `tt.adTitle`, `escalatedAt → escalationReplyAt` | Return per ad, response-time scorecards |
| Visit decline reasons and outcomes | `siteVisitReplies.reason`, visit notes | Feedback themes, visit-to-negotiation conversion |
| Price changes and edits | `propertyChanges` | Days on market, price-cut signals |
| Property interest level | `properties.interestLevel` — read by nothing | Demand scoring label |
| Edit timings, postponed shoots | `listings.cuts`, `rescheduled` | Editor forecasts, unreliable sellers |
| Post live times and URLs | `postTracker.channels.*.liveAt` | Leads per post, channel and hour |
| Expected brokerage, ledger | `finance/{tenant}` | Cash forecast, return per source |
| Locality graph | `area-model.js` | Comparables and demand map without map pins |
| Match vetoes and objections | match engine | “Vetoed for price by 4 buyers” |

## Advanced ideas (27)

Effort: S weeks · M months · L quarters. Impact: H high · M medium.

| # | Theme | Idea | Effort | Impact | Builds on |
| --- | --- | --- | --- | --- | --- |
| 1 | Foundation | Nightly fact store | M | H | Finance snapshot pattern; 09:00 cron |
| 2 | Foundation | 3 PIN MCP server (ask Claude/ChatGPT about live data) | M | H | Match engine, analytics, attention rules |
| 3 | Foundation | Supervised AI back office (5 agents, one approval queue) | L | H | AI queue, suggestions, undo |
| 4 | Foundation | AI self-audit and ops sentinel | S | M | `aiRuns`, `ttState`, dead letters |
| 5 | Sales | Deal score and next-best-action (advisory) | M | H | Milestones, match confidence, objections |
| 6 | Sales | Going-cold warning + drafted nudge | S | M | Stage age, last message, heat |
| 7 | Sales | Parked-buyer revival on new stock or price drop | S | H | Match engine, inventory sync, price log |
| 8 | Sales | Pre-visit negotiation brief | S | H | Case file, internal notes, price desk |
| 9 | Sales | Objection library and rebuttal playbook | S | M | Chat profiles, visit notes |
| 10 | Sales | “Likely to move” engine from owned event signals | M | H | Lead history, rentals, past deals |
| 11 | Sales | Coaching flywheel (Tamil role-play) | M | M | Transcripts, agent replies |
| 12 | Inventory | Demand–supply gap engine → sourcing targets | M | H | Requirement profiles, no-match signals, locality graph |
| 13 | Inventory | Chennai price desk (guideline value floor + own comps) | M | H | TNREGINET values, `propertyChanges`, objections |
| 14 | Inventory | Inventory data-quality agent | M | M | Duplicates, Missing data, `tt.facts` |
| 15 | Inventory | “3 PIN Verified” badge (KYC, patta QR, EC, RERA, forgery) | M | H | Documents checklist |
| 16 | Media | Tamil-first language layer (Indic speech, Tamil V/O) | S | H | Sarvam / AI4Bharat / Bhashini |
| 17 | Media | Copy and script generator (Tamil + English) | S | M | `detailsText`, buyer asks per locality |
| 18 | Media | ₹-per-home 3D tour (Gaussian splat, floor plan) | M | M | Shoot media |
| 19 | Media | Post → lead attribution, best slots | M | M | Post live times, codes in chats |
| 20 | Media | Editor capacity forecast | S | M | Edit timings |
| 21 | Commerce | WhatsApp-native commerce (Flows, carousels, fee payments, ads for visits) | M | H | TailorTalk, match engine |
| 22 | Commerce | AI transaction coordinator (token → registration → patta) | M | H | Finance deal, CRM stages |
| 23 | Commerce | Cash forecast and ledger watch | S | M | Finance outlook, deal score |
| 24 | Commerce | PMLA / KYC autopilot (required above ₹20 lakh turnover) | S | H | Finance parties, deals |
| 25 | Commerce | Embedded services (loan DSA, legal, interiors, movers) | M | H | Signals, Finance |
| 26 | Commerce | Rental management (UPI AutoPay / e-NACH, verification, maintenance) | L | H | CRM, Finance |
| 27 | Commerce | “Ask 3 PIN” conversational search + answer-engine optimisation | M | M | Inventory, match engine |

**Where to start:** quick wins — fix the blockers, 7, 8, 16, 24. Big bets — 1, 2, 3, 5, 10, 12, 13, 15, 21, 22, 25, 26. Fill-ins — 4, 6, 9, 17, 20, 23. Later — 11, 14, 18, 19, 27.

## Fix these first: blockers in today's code

| Blocker | Fix |
| --- | --- |
| Matching reads a TailorTalk profile never copied onto the lead | Copy a short profile onto the lead on each sync (highest-return fix) |
| Two property-code patterns (board vs CRM) | One shared code module + lookup by posting reference |
| No CRM lead ↔ Finance deal link | Optional lead link on a deal |
| No “do not contact” flag | A flag every outbound draft respects |
| No enforced roles | Role claims checked by the database rules |
| AI visit times not sent to Calendar | Route AI visit changes through the calendar sync |
| Analytics would read thousands of records | Nightly compressed snapshot |
| Signal log never marked handled | Mark handled when a person acts |
| All 12 server functions used | Retire the two dead AI Bot routes or keep multiplexing |
| AI spend capped only for lead automation | One daily AI budget per feature |

## Roadmap (proposed; targets, not commitments)

| Phase | When | Ships | Outcome |
| --- | --- | --- | --- |
| 1 Foundations | Nov–Dec 2026 | Blocker fixes, fact store, roles, calls → notes, WhatsApp templates, PMLA/KYC, ops sentinel | Data you can trust |
| 2 Assistant | Jan–Feb 2027 | Voice/text commands, visit confirmations, morning brief, weekly report, pre-visit brief, revive lost buyers, Tamil layer | Say it; it is booked |
| 3 Seller autopilot | Mar–May 2027 | WhatsApp intake, documents, approval + e-sign, shoot by rule, gap engine, price desk, verified badge | Sellers fill listings |
| 4 Growth engine | Jun–Sep 2027 | AI calls new leads, buyer outreach, reels + API posting, 99acres feed, deal score, attribution, MCP server | Buyers found for you |
| 5 New revenue | Oct 2027–Mar 2028 | AI back office, transaction coordinator, embedded services, rental management, WhatsApp commerce, Ask 3 PIN, 3D tours | New revenue lines |

## Guardrails

- A person approves Won, listings, agreements, prices and first contact; every AI action is logged and undoable.
- DPDP: consent on recorded calls, purpose limits, deletion schedules, processor agreements; duties apply from 13 May 2027.
- WhatsApp: free-form only inside the 24-hour window; templates otherwise; keep confirmations as pure utility messages.
- TRAI: no cold AI calls; promotional calls only from registered 140-series numbers.
- PMLA: KYC and records once turnover passes ₹20 lakh.
- AI-generated visuals labelled; no misleading property advertising (RERA, consumer protection).
