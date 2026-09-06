# Claude Code Build Kit — 3pinfinance.html

Paste these prompts into Claude Code **one at a time, in order**. Each phase ends with Claude Code committing and reporting back. Do not paste the next phase until the previous one runs and you've clicked through it.

**Before you start:** copy `3PIN-Finance-System-v2.html` into your repo at `reference/3PIN-Finance-System-v2.html`. Claude Code will read the event logic, chart of accounts and month-end engine from it instead of re-inventing them.

---

## How to work with Claude Code on this

- One phase per session. Say "continue" only after you've opened the page and tried it.
- If Claude Code asks a question, answer it — don't say "just do it". The questions are usually about your existing code.
- After each phase: `git commit`, push, check the Vercel preview URL, then move on.
- If something breaks: paste the browser console error and say "fix this, don't change anything else".

---

## PHASE 0 — Discover the existing setup (no code changes)

```
You are adding a finance module to this repo. Before writing any code, study the existing codebase and report back. Do NOT create or modify files in this phase.

Context: This repo is deployed on Vercel at admin.threepin.in. It already contains plain HTML pages (a CRM and a property dashboard) that use Firebase directly via script tags. I want a new page at /3pinfinance (file: 3pinfinance.html) that follows the exact same conventions.

Find and report, with file paths and code snippets:
1. How existing pages load Firebase (SDK version, compat vs modular, where firebaseConfig lives, whether it's in a shared JS file).
2. How auth works: sign-in method, how a page checks the user is allowed (allow-list? custom claims? a Firestore users collection?), what happens on sign-out. Show the exact code I should reuse.
3. The shared layout: nav/header, CSS files, fonts, brand colors (we use orange #FE8D00 + black on white), any shared JS utilities.
4. The property dashboard's Firestore collection(s): collection name, document shape, the fields for property code, name, location, price, status. I want the finance page to reference properties by document ID.
5. Any existing Firebase Storage usage and its rules file. Any Google Drive API usage (there is one for brochures) — show how it's authenticated and called.
6. Any existing email-sending mechanism (Cloud Function, EmailJS, SMTP, an API route). Show how a page triggers an email today.
7. Whether Cloud Functions exist in this repo (functions/ folder), and the Firebase project ID.
8. How routing works on Vercel for these HTML files (vercel.json rewrites? file-based?). Confirm what I need so that admin.threepin.in/3pinfinance serves 3pinfinance.html.
9. Existing firestore.rules — show the current rules so the finance rules can be added without breaking CRM/dashboard.

Then propose, in a short list, exactly what you will create in Phase 1 and anything you're unsure about. Wait for my confirmation.
```

---

## PHASE 1 — Data model, Firestore collections, security rules

```
Now build the data layer for the finance module. Read reference/3PIN-Finance-System-v2.html first — it contains the chart of accounts, the transaction/journal structure, the event definitions, and the month-end engine. Port the logic; keep the behaviour.

Create the following, following the conventions you found in Phase 0:

A) Firestore structure — everything under one root document so it never mixes with CRM data:
   finance/3pin                          (settings document, see below)
   finance/3pin/accounts/{code}          chart of accounts (seeded from the reference file, MINUS anything mentioning "Realtor Club" — rename that expense account to "Commission & referral fees")
   finance/3pin/parties/{id}             {name, type: client|vendor|employee|lender|other, phone, email, gstin, crmRef (nullable), createdAt}
   finance/3pin/deals/{id}               {nickname, propertyRef (nullable doc ref to the property dashboard collection), propertyCode, propertyName, buyer: {partyId, name, phone}, seller: {partyId, name, phone}, others: [{role, partyId, name, phone}], status: open|registered|cancelled, createdAt}
   finance/3pin/txns/{id}                {date, event, desc, lines: [{acc, dr, cr, party?}], totals: {dr, cr}, meta, attachments: [], reversedBy?, reversalOf?, auto: bool, createdBy, createdAt, fy}
   finance/3pin/subscriptions/{id}       as in the reference (name, vendor, use, payMode, amount, monthly, start, end, months, amortized[], charged[], status, parent?, via)
   finance/3pin/loans/{id}               as in the reference (lender, purpose, principal, rate, n, start, schedule[], paid[], status, partyId)
   finance/3pin/assets/{id}              as in the reference (name, cost, date, start, life, monthly, depreciated[], status)
   finance/3pin/invoices/{id}            {txnId, invoiceNo, date, partyId, dealId, base, gstRate, cgst, sgst, igst, total, pdfPath, uploadedPath?, status}
   finance/3pin/bankStatements/{id}      {account, importedAt, fileName, rows: [{date, desc, debit, credit, balance, matchedTxnId?, status: matched|created|ignored|unmatched}]}
   finance/3pin/monthEnds/{YYYY-MM}      {ranAt, ranBy, entriesPosted}

   Settings document finance/3pin: {companyName: "3 PIN Realty Pvt Ltd", gstin, state: "Tamil Nadu", gstRate: 18, fyStartMonth: 4, booksStartDate: "2026-09-01", tdsEnabled: false, tdsRates: {194H: 2, 194J: 10, 194I: 10}, invoicePrefix: "3PIN/26-27/", nextInvoiceNo: 1, capitalisationThreshold: 5000, emailDigest: {enabled: true, to: []}, bankAccounts: [{id, name, last4}]}

B) A shared module finance-core.js (loaded by 3pinfinance.html) containing:
   - the chart of accounts constant and helpers (A[code], type lookup)
   - post(txn): validates lines balance (|ΣDr − ΣCr| < 0.5), rejects empty, stamps totals/fy/createdBy, writes to Firestore
   - reverse(txnId): writes a new txn with dr/cr swapped and sets reversedBy on the original via a single batched write
   - bal(code, {party, upto, from}), partyBalances(code), pl(month) — same semantics as the reference, computed from a locally cached snapshot of txns (load once, listen for changes)
   - all EV event builders from the reference, ported unchanged in logic, except: remove the "Realtor Club partner commission" event entirely; keep TDS fields in the forms but hide them when settings.tdsEnabled is false
   - runMonthEnd(month): idempotent, writes the auto entries and the monthEnds/{month} doc in one batch
   - Indian number formatting helper fmt()

C) Firestore security rules appended to the existing rules (do not touch existing CRM/dashboard rules):
   - Only signed-in users who pass the same allow-check the CRM uses may read/write anything under finance/3pin/**
   - txns: create allowed only if request.resource.data.totals.dr == request.resource.data.totals.cr and lines.size() > 0 and date >= settings booksStartDate; update allowed ONLY when the changed keys are exactly ['reversedBy']; delete never allowed
   - monthEnds: create only, never update/delete
   - everything else: create/update allowed, delete only for subscriptions/loans/assets that have no linked txns (check a hasTxns flag we maintain)

D) A one-time seed script (seed-finance.html or a button on a hidden /3pinfinance?setup page) that writes the chart of accounts and the settings document if they don't exist.

E) Storage: use Firebase Storage under finance/3pin/{yyyy}/{txnId}/{filename}. Rules: same auth check, max 10 MB, only image/* and application/pdf. If you found in Phase 0 that Storage is not enabled or is restricted, fall back to the existing Drive API used for brochures: create a "3PIN Finance/{FY}" folder and store the Drive file ID in attachments[]. Implement whichever applies and tell me which you chose and why.

Write unit-style checks (a small test.html or a node script) that: seeds a few txns in an emulator or a test doc set, and asserts trial balance balances, balance sheet balances, reversal nets to zero, month-end is idempotent. Run them and show me the output.

Commit as "finance: data layer, core engine, rules".
```

---

## PHASE 2 — The page: layout, auth, Overview, Record, Transactions

```
Build 3pinfinance.html. All markup, styles and page logic live in this single file (plus finance-core.js from Phase 1), matching how the other admin pages are built. Reuse the existing auth check and header/nav so it looks like a sibling of the CRM and property dashboard. Brand: orange #FE8D00 as the only accent, black text on white, one sans-serif family, tabular numbers. Mobile-first: bottom tab bar on phones, side nav on desktop. Must work well on a phone — this is where it will mostly be used.

Views (tabs): Overview, Record, Transactions, Owed, Services, Loans, Assets, Invoices, Bank, Reports, Books, Settings, Guide. Build these three now, the rest in later phases:

1. Overview — replicate the reference's overview: income / expenses / profit for the current month; cash by source (bank, petty cash, credit card owed, "actually free to use" = cash − vendor dues − client tokens held); clients owe you / you owe vendors / tokens held / loans outstanding; services run-rate; GST due (net); month-end runner with a month picker and list of completed months. Add "Books start 1 Sep 2026" note if the settings say so.

2. Record — the single entry point. Left: event buttons grouped exactly as the reference (Money in / Money out / Services / Move money / Corrections). Right (below on mobile): a live preview that shows, before saving, (a) "When to use this", (b) "What saving does" in plain English, (c) a collapsed "double-entry this creates" section with a Balanced ✓ indicator. Save is disabled unless balanced. Every form has:
   - a Date field defaulting to today, rejected if before settings.booksStartDate
   - an Attach button: camera/file input → uploads to Storage (or Drive per Phase 1) → shows thumbnails → paths saved in txn.attachments
   - party pickers that search finance/3pin/parties and allow "add new" inline (name + phone)
   - for "Deal closed": a Deal picker that lists finance/3pin/deals AND lets me create a new deal inline: nickname (required), optional link to a property from the property dashboard collection (searchable by code/name; store propertyRef + copy code/name), buyer, seller and other parties with phone. A deal without a property link is allowed.
   - the preview must be a dry run: it must not create parties/deals until Save.
   After Save: toast "Saved", stay on Record with the form cleared, and show a small "Undo (reverse)" link for 10 seconds.

3. Transactions — newest first, columns: date, description (+ tags: auto / reversal / attachment icon), effect on profit, cash moved, Reverse button (confirm dialog, explains both entries stay). Filters: month, event type, party, text search. Tap a row → drawer with the full journal lines, meta, attachments, and "Reverse".

Empty states must tell the user what to do next. Loading states everywhere Firestore is awaited. Keyboard focus visible. Respect prefers-reduced-motion.

Wire the Vercel routing so admin.threepin.in/3pinfinance serves this page (per Phase 0 findings). Commit as "finance: page shell, overview, record, transactions". Give me the preview URL.
```

---

## PHASE 3 — Owed, Services, Loans, Assets

```
Add these four views to 3pinfinance.html, deriving everything from Firestore data via finance-core.js. No separate data entry anywhere in these views — they only display and launch the relevant Record event pre-filled.

1. Owed — four tables from partyBalances(): clients owe you (with days since invoice, sorted oldest first, a "Record payment" button per row that opens Record → Client pays with the party pre-selected, and a "Write off" button), you owe vendors (with "Pay" button → Record → Pay a bill pre-filled), client tokens held (with "Adjust on deal", "Refund", "Forfeit" buttons), TDS deducted by clients (only when tdsEnabled).

2. Services — cards: monthly run-rate, annual commitment, unused prepaid sitting with vendors. Table of active services with per-month cost regardless of payment mode, period, "this month: charged / not yet", status. Buttons per row: Record monthly charge (pay-monthly only), Upgrade/downgrade, Cancel/pause. History section below for non-active ones. Highlight any service whose end/renewal is within 7 days.

3. Loans — one card per loan: borrowed, outstanding, interest paid so far vs total interest, next EMI with its principal/interest split, "Pay this EMI" button (pre-fills Record → Pay an EMI). Expandable schedule table with paid rows marked.

4. Assets — table: item, bought, cost, per-month depreciation, written down so far, value left. Totals row. "Sell / scrap" action that opens a Record form (add this event to finance-core.js if not present: removes the asset and its accumulated depreciation, books gain/loss to Other income / Loss on disposal).

Commit as "finance: owed, services, loans, assets".
```

---

## PHASE 4 — Invoices (GST PDF) and attachments

```
Add the Invoices view and invoice generation.

1. When "Deal closed" is saved with GST > 0, also create finance/3pin/invoices/{id} with a sequential number from settings.invoicePrefix + nextInvoiceNo (increment atomically with a transaction). Split GST as CGST + SGST when the client's state is Tamil Nadu (or unknown), IGST otherwise — store all three.

2. Generate a simple, clean A4 PDF client-side (use a library already in the repo if any; otherwise jsPDF from a CDN, no build step). Content: 3 PIN Realty Pvt Ltd header in brand orange/black, company GSTIN/address from settings, "Tax Invoice", invoice number and date, bill-to party (name, phone, GSTIN if any), deal nickname and property code/name, one line: "Brokerage / consultancy services", SAC code field from settings (default 997221), taxable value, CGST/SGST or IGST, total, amount in words, bank details from settings, a signature line. Keep it to one page. Save the PDF to Storage/Drive at finance/3pin/invoices/{invoiceNo}.pdf and store the path.

3. Invoices view — list with number, date, client, deal, total, status (unpaid/part/paid derived from the receivable balance for that party+deal), buttons: View PDF, Share (Web Share API on mobile, download otherwise), "Upload my own" (replace/attach an externally created invoice PDF — store as uploadedPath, keep the generated one).

4. Attachments — on any Transaction drawer, allow adding more attachments after the fact (this is the one allowed update on txns besides reversedBy — update the security rules so changed keys may be exactly ['attachments'] as well).

Commit as "finance: GST invoices and attachments".
```

---

## PHASE 5 — Bank statement import and reconciliation

```
Add the Bank view. Purpose: make sure every line on the bank/card statement exists in the books, and nothing exists in the books that isn't on the statement.

1. Import: choose account (from settings.bankAccounts, plus "Credit card"), upload a CSV or XLSX. Show a column-mapping step (date, description, debit, credit, balance) with auto-detection and a preview of the first 5 rows; remember the mapping per account in settings so it's one-tap next time. Save the parsed rows to finance/3pin/bankStatements/{id}.

2. Auto-match: for each statement row, look for a txn in the same account (Bank=1000, Card=2300) with the same amount within ±3 days and not already matched; mark matched and store matchedTxnId. Show match confidence (exact date vs ±3 days).

3. Reconcile screen: three lists — Matched (collapsed), Unmatched statement rows, Book entries with no statement line for that period. For each unmatched statement row: buttons "Create entry" (opens Record with date, amount and paid-via pre-filled; after save, links automatically), "Match to…" (pick an existing txn), "Ignore" (with reason — e.g. bank interest already recorded, transfer between own accounts). For book entries not on the statement: "Find on statement" or "Flag for review".

4. Header stat: statement closing balance vs book balance for that account as of the statement end date, with the difference in red until it's zero. Show "Reconciled ✓ for {month}" when the difference is zero and no unmatched rows remain, and store that flag in monthEnds/{month}.

5. Guard: block "Run month-end" for a month until that month is reconciled, with an "override" checkbox that logs who overrode it.

Commit as "finance: bank import and reconciliation".
```

---

## PHASE 6 — Reports, Books, exports, Settings, opening balances

```
Add the remaining views.

1. Reports — Profit & loss for a selected month and for a selected FY (Apr–Mar, from settings.fyStartMonth), last-6-months bar trend, income by category, expenses by category, cash-flow summary (money in/out by type: income, expense, funding, repayment, advance, asset, transfer). Every table has a "Download CSV" button.

2. Books — trial balance (with balanced indicator), balance sheet as of a chosen date (assets = liabilities + equity + retained profit check), ledger per account with running balance and party filter, general journal for a date range. "Download journal CSV" in the exact format: Txn, Date, Description, Account code, Account name, Debit, Credit, Party, Event — plus a second export in Tally-friendly layout (Voucher Type = Journal, Ledger names = account names). Also "Export everything (JSON)" for backup.

3. Settings — edit every field of finance/3pin (company details, GSTIN, GST rate, SAC code, invoice prefix/next number, TDS enabled + rates, capitalisation threshold, bank accounts list, email digest recipients). Manage parties (edit/merge duplicates: merging rewrites party refs on lines via a batched update). Manage categories: allow adding new expense/income accounts under the chart with a code in the right range.

4. Opening balances — a guided screen used once, for books starting 1 Sep 2026: enter bank balance, petty cash, credit card outstanding, each existing loan (lender, outstanding, rate, remaining months → generates schedule), each existing asset (cost, purchase date, life → computes depreciation to date), share capital, any client advances held, any vendor dues. It posts ONE balanced opening journal dated booksStartDate against a "3100 Opening balance equity" account (add it to the chart), and creates the loan/asset/subscription master records. Lock the screen after it's used once (store openingPosted: true in settings).

5. Guide — port the Guide tab from the reference, removing anything about Realtor Club, and updating the scenario map to match the events that exist now. Add a "Bank reconciliation — how to" section describing the Phase 5 flow.

Commit as "finance: reports, books, settings, opening balances, guide".
```

---

## PHASE 7 — Email reminders using the current system

```
Using the existing email mechanism you found in Phase 0 (reuse it, don't add a new provider), add:

1. A weekly digest (Monday 8:00 IST) to settings.emailDigest.to: cash position, clients overdue > 14 days, vendor bills due this week, services renewing in the next 7 days, pay-monthly services not yet charged this month, GST/TDS due dates approaching, and whether last month's month-end and reconciliation are done.
2. A same-day alert when a subscription's renewal is 3 days away.
3. A monthly P&L summary on the 2nd of each month for the previous month, with the CSV attached.

If the existing mechanism is client-triggered only (no scheduler), implement it as a Cloud Function with a Pub/Sub schedule in the functions/ folder, reusing the same sending code; tell me what needs to be deployed (firebase deploy --only functions) and any IAM/API enablement I must do in the Firebase console.

Commit as "finance: email digests".
```

---

## PHASE 8 — Hardening, tests, deploy

```
Finish and ship.

1. Run through every event in Record with the reference's demo scenario (three months of activity, including: token received → deal closed with advance adjusted; token refunded; token forfeited; bill received → paid; annual subscription upfront → cancel with partial refund; monthly subscription → upgrade; asset on credit card → converted to EMI → two EMIs paid; card bill paid; petty cash top-up and spends; salary; write-off; reversal of a wrong entry; month-end for each month). Do this against the Firebase emulator, then assert: trial balance balances, balance sheet balances, every reversal nets to zero, month-end twice posts nothing the second time, the P&L for each month equals the expected figures you compute by hand in the test. Show me the output.
2. Firestore rules tests with the emulator: a signed-out user is denied; an allowed user can post a balanced txn; an unbalanced txn is rejected; updating a txn's amount is rejected; deleting a txn is rejected; dates before booksStartDate are rejected.
3. Performance: cache txns in memory with onSnapshot; never re-read all txns per view render. Verify the page works with 5,000 txns without lag on a mid-range phone (throttle CPU 4x in DevTools).
4. Accessibility pass: labels on every input, focus order, contrast ≥ 4.5:1, touch targets ≥ 44px.
5. Deploy to production on Vercel and deploy rules/storage rules/functions to Firebase. Give me: the live URL, the list of Firebase console steps I must do manually (if any), and a 10-line "first day" checklist (seed, opening balances, add bank account, import first statement).

Commit as "finance: v1.0 release".
```

---

# Answers to your questions

### Q7 — "What happens if I import bank statements? Need more instruction."

This is the reconciliation loop, built in Phase 5. In plain terms:

1. **Download the statement** from your bank (CSV/XLSX) for the month. Same for the credit card.
2. **Import** it in the Bank tab. First time, map the columns; after that it's one tap.
3. The app **auto-matches** each statement line to a transaction you already recorded (same amount, within 3 days).
4. **What's left is your to-do list**, and every line falls into one of three buckets:
   - **On the statement but not in the books** → you forgot to record it. Tap "Create entry", the amount and date are pre-filled, you just pick what it was.
   - **In the books but not on the statement** → either you recorded something that didn't actually go through (reverse it), or it's on next month's statement (leave it).
   - **Both exist but don't match** → wrong amount or date — reverse and re-record.
5. When the statement closing balance equals your book balance and nothing is unmatched, the month shows **Reconciled ✓**. Only then run month-end.

Rule of thumb: **the bank statement is the truth; the books must mirror it line for line.** Reconciliation isn't extra work — it's the only check that proves your books are right. Do it monthly, 20–30 minutes.

Adding a second bank account or card later: add it in Settings → Bank accounts; imports and matching are per account.

### Q6 — Property mapping

Deals get an optional link to a property from your dashboard collection (searchable by code/name), plus a required nickname, and buyer/seller/other parties with phone numbers. You can create a deal with no property linked. Phase 0 will discover the exact field names in your property collection so nothing is guessed.

### Q10 — TDS on hold

All TDS logic stays in the engine but is hidden behind `settings.tdsEnabled = false`. When your CA says go, flip the switch — nothing to rebuild.

### Q12 — Realtor Club

Removed everywhere: no event, no account, no wording. A plain "Commission & referral fees" expense category remains, since brokers do occasionally pay referral fees.

### Q9 — Invoices

Generated automatically from "Deal closed" as a one-page GST PDF (CGST+SGST for Tamil Nadu clients, IGST otherwise), stored, shareable from the phone. You can also upload an invoice you made elsewhere against the same record.

---

# Two things only you can do

1. **Firebase console**: confirm Storage is enabled and check its rules; if you prefer Drive, tell Claude Code in Phase 1 ("use Drive, not Storage").
2. **Your CA, before go-live**: GSTIN + registered address for the invoice header, SAC code for brokerage (997221 is common — confirm), bank details to print on invoices, and confirmation that opening balances as of 1 Sep 2026 are what they'll accept.
