# Release status (live 13 Oct 2026), remaining gaps and known issues

**Live** is the deployed `main` at commit `b48bfaa` (13 Oct 2026, 22:48 IST) with Firestore ruleset `132b5f73`. Everything the documents above describe is live unless it is marked here as *by hand* or *in progress*. The lead views were built and verified **IN STEP** after the release.

## What went live on 13 Oct 2026

| Module | Change | Process it affects |
| --- | --- | --- |
| Shoot & Media | **Reference on cards** ("Ref: Lux49 4Bhk"), editable on the card | Posting plan |
| Shoot & Media | **Create a CRM lead from a card** (a duplicate phone offers the existing lead) | Owner onboarding |
| Shoot & Media | **Move to…** menu on every card; a card can be dropped anywhere on a column | Every stage move |
| Shoot & Media | **Listing type** Normal / Exclusive / Collab (`listingType`) | Onboarding |
| Shoot & Media | **Documents checklist** (`docs`; 7 defaults, the list in Settings → Configurations as `docItems`) | Documents lane |
| Shoot & Media | **Final video link** per cut (`finalLinks`), optional | Final media |
| Shoot & Media | **Brochure v2 reminder** when the shoot came after the brochure (`broV2Seen` dismisses it) | Brochure |
| Shoot & Media | **Shoots on the team calendar** — Settings switch `shootCalendar`, **off by default**; sends real Google invitations; `shootEventId` / `shootEventBy` | Shoot scheduling |
| Shoot & Media | One card per lead; typing-safe live updates; live inventory watch | Mapping, editing |
| CRM | Keeps scroll; note drafts stay with their lead; follow-ups moved by the AI or a teammate are kept; saves send only changed fields; "⋯" menu on phones | Daily work |
| CRM | Search and filters hidden on Daily task, Team calendar and Analytics; **Leads for property** by id or code; a seller's **Listing** row opens its card | Navigation |
| CRM | Team calendar: occurrences of a repeating meeting recognised — the edit form says "Repeats — this change is for this one only"; a single occurrence may be dragged | Meetings |
| All consoles | **Back** closes the top dialog, then the panel, never the page; a lead or card opened from a link is not reopened once closed | Navigation |
| All consoles | Saves from a device's old local copy are refused until the server's list has arrived ("Still connecting"): board moves, stage changes and dialogs; dashboard saves except the partial map-pin save | Data safety |
| Property dashboard | **"Shoot & Media and posts"** block on every property; delete says which cards and leads still point at it; a failed delete is undone and noted in the change log | Property detail |
| All | **Lead views** (`leadViews`) — the CRM opens with **39 reads instead of 760**; every writer writes the lead's row in the same batch; rebuilt daily at 09:00 after the digest has marked its day as sent | Cost and speed |
| All | **UI v2**: Inter, neutral greys, #FF8A00 accent, 11 px minimum text, 24 px tap targets (`shared-assets/theme.css`) | Every screen |
| Finance | **Attachments guard**: images and PDFs only; publish or delete only a file inside the finance Drive folder (at most three hops to the root) | Attachments |
| Platform | Data-deletion status page escapes everything it prints; TailorTalk safety-net pull resumes where it stopped | Compliance, intake |
| Database rules | `leads` read split into `get` and `list`, with the "does not exist" answer limited to the caller's own `tt_<tenant>_` ids; new `leadViews` rules (one row per write, keys `tenantId` + `rows` only) | Security |

## Still to do by hand

| Item | Why | How |
| --- | --- | --- |
| **Lead-views index exemption** | Nothing queries inside a view document, and a busy one could otherwise reach Firestore's 40,000 index entries and refuse writes | `node scripts/lead-views.mjs exempt` answered **403**, so set it in the Firebase Console: Firestore → Indexes → Single field → add an exemption for collection `leadViews`, field `rows`, with every index off |

## In progress — not live

The working copy carries further changes made after the release (CRM, board, dashboard and finance assets, `firestore.rules`, the finance digest, the lead-views client and its test — see `git status`). None of it is deployed; this documentation describes none of it. The same release steps apply when it is ready: review → fix → re-review, `npm test`, previews and `npm run audit:ui-all`, deploy the rules, push `main`, verify the lead views.

## Gaps against the owner's lifecycle

| Owner's step | Today | Gap |
| --- | --- | --- |
| Find on 99acres / WhatsApp / by agent → shortlist | Cards come from CRM seller leads or by hand | No "where found" field or shortlist stage |
| **Gate: Swami approves** before any agreement | Not recorded anywhere | No approval step; "Owner approved" means the *property owner* approved the photos |
| Agreement for Exclusive / Collab before the shoot | Listing type recorded, gates nothing | No agreement fields or shoot gate |
| Documents: non-blocking, **frequent alerts** | Checklist on every card, non-blocking | No alerts or Daily-task items for missing papers |
| Brochure v1 and v2 | Redo after the shoot; a v2 reminder on the card | Versions not labelled |
| **Gate: Swami plans the post** (plan + V/O) before editing | Anyone can plan; editing can start without a post plan | No approver or gate |
| Final media to Drive | Final link optional | Not a required step |
| Save the URL against the property | Saved on the Posting row, shown on the dashboard's Shoot & Media block | Not on the lead |

Where the app is arguably better than the reference: per-outlet edits and V/O decisions; "posted" confirmed by a person with the URL; mapping by hand with one property per card; a card for every seller automatically.

## Known issues in the live code

| Area | Issue | Effect | Risk |
| --- | --- | --- | --- |
| Shoot & Media | A removed final-video link comes back | The card is saved whole with a merge, so a deleted map key survives; the link reappears on the next refresh | Low |
| Shoot & Media | Deleting a card leaves its code on the lead | The lead keeps `listingCode`; the seller still looks linked | Low |
| CRM | AI-written visit dates are not sent to Google Calendar | Invitation keeps the old time until a person re-saves | Medium |
| CRM | A deleted TailorTalk lead returns on the next sync | Delete is not permanent | Low |
| CRM | Manage Stages reorder does not persist; a new custom stage jumps to second | Column order | Low |
| CRM | Matching ignores TailorTalk's requirement text | Weaker buyer matches | Low |
| CRM | AI Bot editor and WhatsApp digest are largely dead | Use the email digest; replies come from TailorTalk | Low |
| CRM | Edit dialog → Lost skips the reason | Reason recorded as "other" | Low |
| Lead views | A lead saved while this browser cannot confirm the view layout is written without its row | The lead is correct; it is missing from lists read through the views until the 09:00 rebuild (or `scripts/lead-views.mjs build`) | Low |
| Lead views | The rules do not check that a row's `_w` stamp is the server's time | A page could write a wrongly stamped row; the daily rebuild's "keep newer rows" guard then trusts it until the next rebuild from the leads | Low |
| Property | Toggles re-save the whole property from the page | A stale tab can re-write sheet fields without a log entry (the "Still connecting" guard covers only the first load) | Medium |
| Property | Deleting a property leaves its notes behind | Orphaned notes | Low |
| Property | Code patterns differ between board and CRM | Some codes never auto-link to leads | Low |
| Finance | Reconciled flag usually fails silently; month-end re-run errors | Month-end needs the override | Medium |
| Finance | Party merge blocked by rules; bank accounts all share id 1000 | Duplicate parties stay; one bank ledger | Low |
| Finance | Opening balances screen probably unreachable | Verify before go-live of a new year | Low |
| Finance | The finance settings record, including the Drive folder id (`driveFolderId`) the attachments guard trusts, is writable by every team member | A team member could point attachments at another folder | Low |
| Platform | No enforced roles; Finance passcode is in the page code | Everyone can do everything | Medium |
| Platform | Team list, default agent, TailorTalk workspace, lead-views switch have no settings screen | Set by script or by hand | Low |
| Platform | Docs describe removed WhatsApp bot routes; privacy policy is a draft | Documentation and compliance | Low |

Fixed in this release and removed from the list: the shoot calendar call now sends the time and a 60-minute length; the data-deletion status page escapes its output; the `leads` rule no longer reveals other tenants' ids.
