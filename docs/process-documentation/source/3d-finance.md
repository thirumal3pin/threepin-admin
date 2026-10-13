## 3D · Finance — the agency's own books

**Console:** `3pinfinance.html` (`/3pinfinance`). **Data:** everything under `finance/{tenant}` — settings, `txns` (the ledger), `parties`, `deals`, `invoices`, `bills`, `subscriptions`, `loans`, `assets`, `bankStatements`, `monthEnds`.

Finance keeps 3 PIN Realty's own accrual-basis, double-entry books. Nobody needs to know accounting: the user picks a plain-language action ("Token received", "Invoice the buyer", "Bill received — pay later", "Pay an EMI"), and the app builds a balanced journal against a fixed chart of 63 accounts, plus any bills, invoices, deals, recurring costs, loans or assets it implies — all in one transaction with gapless numbering. Every report is derived live from the ledger.

### Screens

| Group | Screen | What it is for |
| --- | --- | --- |
| Daily | Overview | Month income, costs, profit; **Free to use**; bank, petty, card, loans; who owes whom; GST due; compliance dates; month-end runner |
| Daily | **Record** | The only screen that writes entries: 7 category tiles (Money in, Money out, Bills, Invoices, Service costs, Deals, Fix something), ~35 actions, live journal preview "Balanced ✓", attach a photo or PDF, Undo within 30 min |
| Daily | This month | Paid / invoiced / due / late / estimated, "Can I spend?", 3-month outlook |
| Daily | Transactions | Every entry with filters; drawer with journal, "where this stands" actions and **Reverse** |
| Daily | Owed | Clients owe you (ageing 0–30 / 31–60 / 61–90 / 90+), you owe vendors, advances, tokens held |
| Business | Deals & invoices | Deal pipeline per property and side; invoice list with PDF, Share, Upload my own |
| Business | Recurring | Services, rent, salaries, utilities: expected vs billed, "Record this month" |
| Business | Budget | Expected vs actual per account, typed overrides |
| Money | Bank & card statements | Import CSV/XLSX, auto-match, reconcile |
| Money | Petty cash, Loans, Assets | Box balance; EMI schedules; depreciation |
| Tax & reports | GST | Output tax, credit, GSTR-3B by head, ITC register, GSTR-1, 180-day rule |
| Tax & reports | Reports, Analytics, Books | P&L, cash book, cash flow, break-even; trends; trial balance, balance sheet, ledgers, the 15-test books check, exports for the CA (journal, Tally CSV, JSON) |
| Setup | Profile, Settings, Guide | Company, GSTIN, bank details, digest recipients; rates, prefixes, TDS; an 8-tab in-app guide |

A passcode locks every screen except Record (a convenience lock, not security).

**Attachments** (the photo or PDF on an entry) go to the finance folder in Google Drive, filed by financial year and transaction. The upload route accepts only images and PDFs, and will publish (make link-readable) or delete only a *file* that sits inside the finance folder — the file, its transaction folder, its year folder, then the root: at most three hops. Anything else in Drive cannot be touched through it. The folder is the `driveFolderId` in the finance settings record.

### Process 1 — The deal and brokerage cycle

| Step | Action | What the books record |
| --- | --- | --- |
| Open a deal | Add a deal | Nickname, optional property (code and name copied from the Property dashboard), property state, seller and/or buyer, expected brokerage per side, expected close month. No journal |
| Token | Token received | Money in, held as a **client advance** (not income) |
| Registration | Mark registered | Status registered, date, deed number |
| Invoice a side | Invoice the buyer / seller | Brokerage income + GST (CGST/SGST or IGST by the **property's** state); the token is applied; the rest is receivable. A numbered invoice is always created |
| Get paid | Client pays | Allocated to invoices oldest first; short-pay as discount or bank charge; extra held as advance |
| Settle a token | Apply / refund / keep (forfeit) / move | Forfeit becomes income (GST optional) and can cancel the deal |
| Deal cost | Deal cost | Borne by the company (expense) or recoverable from the client |
| Problems | Write off, Absorb, Credit note | Bad debt; absorbed cost; numbered credit note reversing income and GST |

"Settled" is worked out, not stored: registered, invoiced, nothing owed, nothing held.

### Process 2 — Costs, from estimate to settled

1. **Expense** (paid now) or **Bill received — pay later** (creates a bill due in 30 days). "Which month is this cost for?" books it to the right period.
2. **Bill arrived** adds the vendor's bill number to an accrual and releases parked GST credit.
3. **Pay a bill** — oldest first; TDS withheld; a let-off amount reduces the cost.
4. Other actions: petty-cash vouchers, director paid, salary (gross, net, TDS, PF/ESI), buy an asset, sell/scrap an asset, vendor refund.

### Process 3 — Recurring costs, loans, month-end

- **Recurring:** set up a service (monthly or paid upfront); each month **Record this month** (paid / not paid yet / skipped), with the variance and its reason; change, pause or cancel (unused prepaid refunded or lost).
- **Loans:** EMI schedule; **Pay an EMI** splits principal, interest, charges, penalty; prepayment rebuilds the schedule; card-to-EMI conversion.
- **Month-end (by hand):** posts prepaid releases and depreciation; asks for a reconciled bank statement first (override recorded).
- **Bank reconciliation:** import a statement → auto-match within ₹1 and ±3 days → suggested entries for unmatched lines (learned rules, ATM = petty top-up, card bill, open bill, EMI, invoice…) → Save reconciliation.

### Process 4 — Fixing mistakes

The ledger is **append-only** (enforced by the database rules). A mistake is fixed with **Reverse**: a mirror entry that unwinds payments, voids bills it created and issues a credit note for any invoice it raised. It is refused once an invoice or bill has payments against it.

### Key calculations

| Figure | Formula |
| --- | --- |
| Free to use | Bank + Petty cash − Card balance − Payables − Client advances |
| GST due | Output GST − Input credit + Reverse charge |
| GST split | Same state → CGST + SGST (half each); otherwise IGST. Brokerage follows the **property** state; other income the client's state |
| TDS | Base (before GST) × rate (194H 2 %, 194J 10 %, 194I 10 %, 194C 2 %) — off by default |
| EMI | P·r(1+r)^n / ((1+r)^n − 1), r = annual rate / 1200 |
| Depreciation | Cost ÷ life (default 36 months), straight line |
| Profit before tax | Revenue − direct costs + other income − operating costs − depreciation − interest − exceptional items |

### Field reference — main records

| Record | Key fields | Why |
| --- | --- | --- |
| Entry (`txns`) | Number, date, action, narration, journal lines (account, debit, credit, party, deal, method), totals, attachments, reversal links | The single source of truth; rules require debits = credits and a date on or after books start |
| Party | Name, type (client / vendor / employee / lender / director), phone, email, GSTIN, state | Who money moves with; B2B vs B2C; place of supply |
| Deal | Nickname, property code + name (copied once), property state, seller, buyer, expected amounts, expected month, status (open / registered / cancelled), deed no. | Brokerage per property and side |
| Invoice | Kind (brokerage / fee / other / forfeit / credit note), number, dates, party, deal, base, GST split, total, paid, status (open / part / paid / void) | What clients owe; the GST invoice PDF |
| Bill | Vendor, bill number (blank = accrual), dates, period, account, taxable, GST, TDS, total, paid, status | What we owe vendors |
| Subscription | Kind, vendor, plan, monthly or upfront, history, per-month charges with variance and reason | Recurring commitments |
| Loan / Asset | Lender, principal, rate, schedule, paid / cost, life, depreciated | Debt and fixed assets |
| Bank statement | Account, file, mapping, closing balance, rows with match status | Reconciliation evidence |

### Links to other modules

- **Property dashboard → Finance:** a one-time, read-only copy of property code and name onto a deal.
- **CRM → Finance: none.** A Won lead creates nothing in Finance; deals are entered by hand. This is deliberate for now (TailorTalk's "converted" fires at site visits, so it must never raise an invoice).
- **Daily digest email** at **08:00 IST**: weekly summary on Mondays, renewal alerts 3 days ahead, monthly P&L with the journal CSV on the 2nd.
