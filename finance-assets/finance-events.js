// ═══════ 3 PIN REALTY — FINANCE EVENTS ═══════
//
// One event per thing that actually happens in the business. Each builds a balanced journal
// plus a plain-English explanation of what saving it will do. Ported from
// reference/3PIN-Finance-System-v2.html, with the Realtor Club partner-commission event
// removed (5040 survives as an ordinary "Commission & referral fees" category) and a new
// asset-disposal event added.
//
// build(v) MUST stay pure: it creates nothing and writes nothing, because the Record screen
// calls it on every keystroke to render the live preview. Anything that needs to be created
// is DESCRIBED in the returned `docs`/`updates` arrays and applied by finance-sync.js inside
// the same batch as the transaction, only when the user presses Save.

import {
  A, EXP, PAY_VIA, TDS_SECTIONS, num, today, ym, addMonths, mlabel, fmt, esc,
  getState, deal, pname, partySides, sideParty, bal, partyBalances,
  schedule, prepaidLeft, splitGst,
} from './finance-core.js';

// ═══════ FIELD + PARTY HELPERS ═══════

// F('key', 'Label', 'type', {extras}) — types: text number date month select textarea
//                                              party property deal
const F = (k, label, type = 'text', x = {}) => ({ k, label, type, ...x });

const S = () => getState();
const tdsOn = () => !!S().settings.tdsEnabled;
const gstRate = () => num(S().settings.gstRate) || 18;

// A party field holds either an existing id (string) or a not-yet-created
// {__new:true, name, phone, type} from the "add new" row of the picker. During preview we
// stand in a sentinel id so the journal still renders; finance-sync.js swaps in the real id
// before build() is called for real on Save.
export const pidOf = x =>
  !x ? null : (typeof x === 'string' ? x : 'pending:' + (x.name || 'New party'));

export const pnameOf = x =>
  !x ? '—' : (typeof x === 'string' ? pname(x) : (x.name || 'New party'));

const dealOpts = () => S().deals
  .filter(d => d.status !== 'cancelled')
  .map(d => [d.id, d.nickname || d.propertyName || d.id]);

const dealsWith = (code, test) => S().deals
  .filter(d => test(bal(code, { deal: d.id })))
  .map(d => [d.id, d.nickname || d.propertyName || d.id]);

const dealLabel = d => d ? (d.nickname || d.propertyName || d.id) : '';

const pick = (code, label) => Object.entries(partyBalances(code))
  .filter(([, v]) => v > 0.5)
  .map(([p, v]) => [p, `${pname(p)} — ${label} ${fmt(v)}`]);

const need = msg => ({ desc: '', lines: [], effects: [msg], incomplete: true });

export const EV = {};

// ═══════ DEALS ═══════

EV.newdeal = {
  title: 'New deal', group: 'Deals',
  when: 'Open a deal as soon as you have a property and a client. Tokens, costs and the invoice all hang off it. A deal can be created without linking a property — the nickname is what you will recognise it by.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('nickname', 'Deal nickname', 'text', { required: true, hint: 'e.g. Rajan — Nungambakkam 2BHK' }),
    F('property', 'Link a property (optional)', 'property', { hint: 'Search your dashboard by code or name' }),
    F('seller', 'Seller', 'party', { partyType: 'client' }),
    F('buyer', 'Buyer', 'party', { partyType: 'client', hint: 'Leave blank until you have one' }),
    F('expSeller', 'Expected brokerage from seller', 'number', { def: 0 }),
    F('expBuyer', 'Expected brokerage from buyer', 'number', { def: 0 }),
  ],
  build: v => {
    if (!String(v.nickname || '').trim()) return need('Give the deal a nickname.');
    const expected = num(v.expSeller) + num(v.expBuyer);
    return {
      desc: '', lines: [],
      effects: [
        `Deal "<b>${esc(v.nickname)}</b>" opens in the pipeline with expected brokerage <b>${fmt(expected)}</b>.`,
        'Nothing hits the books yet — no money has moved and nothing is owed.',
      ],
      docs: [{
        coll: 'deals',
        data: {
          nickname: String(v.nickname).trim(),
          propertyRef: v.property?.id || null,
          propertyCode: v.property?.propertyCode || '',
          propertyName: v.property?.name || '',
          seller: v.seller ? { partyId: pidOf(v.seller), name: pnameOf(v.seller), phone: v.seller?.phone || '' } : null,
          buyer: v.buyer ? { partyId: pidOf(v.buyer), name: pnameOf(v.buyer), phone: v.buyer?.phone || '' } : null,
          others: [],
          expSeller: num(v.expSeller), expBuyer: num(v.expBuyer),
          status: 'open',
          opened: v.date || today(),
        },
      }],
    };
  },
};

EV.token = {
  title: 'Token / advance received', group: 'Deals',
  when: 'Money received <b>before</b> registration is not income. It is held for the client and shows against this deal until it is adjusted on the invoice, refunded or forfeited.',
  fields: v => [
    F('date', 'Date', 'date', { def: today() }),
    F('deal', 'Deal', 'deal', { opts: dealOpts() }),
    F('from', 'From', 'select', { opts: partySides(v.deal) }),
    F('amt', 'Amount', 'number'),
    F('via', 'Received into', 'select', { opts: [['1000', 'Bank / UPI'], ['1010', 'Petty cash']], def: '1000' }),
  ],
  build: v => {
    const d = deal(v.deal);
    if (!d) return need('Pick a deal.');
    const pid = sideParty(d, v.from);
    if (!pid) return need('This deal has no ' + (v.from || 'party') + ' yet.');
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount received.');
    return {
      desc: `Token — ${dealLabel(d)} (${pname(pid)})`,
      lines: [{ acc: v.via || '1000', dr: amt }, { acc: '2100', cr: amt, party: pid, deal: d.id }],
      effects: [
        `Cash in ${fmt(amt)}, held for ${esc(pname(pid))} on this deal.`,
        '<b>Not income.</b> This month\'s profit is unchanged.',
      ],
    };
  },
};

EV.dealcost = {
  title: 'Cost for this deal', group: 'Deals',
  when: 'EC, patta, legal, documentation, travel. Choose who bears it: <b>you</b> (a deal expense) or the <b>client</b> (you paid on their behalf — it sits as recoverable from them and goes onto their settlement).',
  fields: v => [
    F('date', 'Date', 'date', { def: today() }),
    F('deal', 'Deal', 'deal', { opts: dealOpts() }),
    F('what', 'What', 'text', { hint: 'EC extract, patta transfer, lawyer opinion, site travel…' }),
    F('amt', 'Amount', 'number'),
    F('bear', 'Who bears it', 'select', {
      opts: [['self', 'Company (deal expense)'], ['seller', 'Recover from seller'], ['buyer', 'Recover from buyer']],
      def: 'self',
    }),
    F('acc', 'Expense category', 'select', {
      opts: [['5045', 'Deal costs (EC, patta, legal)'], ['5050', 'Conveyance & fuel'],
      ['5110', 'Photography & video'], ['5120', 'Professional fees'], ['5180', 'Miscellaneous']],
      def: '5045', show: x => x.bear === 'self',
    }),
    F('how', 'Paid', 'select', {
      opts: [['1000', 'Now — Bank / UPI'], ['1010', 'Now — Petty cash'],
      ['2300', 'Now — Credit card'], ['bill', 'Bill received, pay vendor later']],
      def: '1000',
    }),
    F('vendor', 'Vendor', 'party', { partyType: 'vendor', show: x => x.how === 'bill' }),
  ],
  build: v => {
    const d = deal(v.deal);
    if (!d) return need('Pick a deal.');
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    const lines = [], eff = [];

    if (v.bear === 'self') {
      lines.push({ acc: v.acc || '5045', dr: amt, deal: d.id });
      eff.push(`Deal expense ${fmt(amt)} — reduces this deal's net and this month's profit.`);
    } else {
      const pid = sideParty(d, v.bear);
      if (!pid) return need(`This deal has no ${v.bear} yet — add one on the deal, or choose "Company".`);
      lines.push({ acc: '1100', dr: amt, party: pid, deal: d.id });
      eff.push(`${fmt(amt)} paid on behalf of ${esc(pname(pid))} — <b>recoverable</b>, not your expense. It joins their settlement and your chase list.`);
    }

    if (v.how === 'bill') {
      const vid = pidOf(v.vendor);
      if (!vid) return need('Name the vendor you owe.');
      lines.push({ acc: '2000', cr: amt, party: vid });
      eff.push(`You owe ${esc(pnameOf(v.vendor))} ${fmt(amt)} — it joins payables.`);
    } else {
      lines.push({ acc: v.how || '1000', cr: amt });
    }

    return { desc: `${v.what || 'Deal cost'} — ${dealLabel(d)}`, lines, effects: eff };
  },
};

EV.invoice = {
  title: 'Deal closed — raise brokerage invoice', group: 'Deals',
  when: 'The deal registered. <b>Now</b> income is earned. Tokens held convert to income, recoverable costs are added to what the client owes, and a GST invoice is generated.',
  fields: v => [
    F('date', 'Registration date', 'date', { def: today() }),
    F('deal', 'Deal', 'deal', { opts: dealOpts() }),
    F('from', 'Invoice to', 'select', { opts: partySides(v.deal) }),
    F('base', 'Brokerage (before GST)', 'number', {
      hint: x => { const d = deal(x.deal); return d ? 'Expected: ' + fmt(x.from === 'buyer' ? d.expBuyer : d.expSeller) : ''; },
    }),
    F('gst', 'GST %', 'number', { def: gstRate() }),
    F('tds', 'TDS % the client deducts', 'number', { def: 0, show: () => tdsOn() }),
    F('adv', 'Adjust token held', 'number', {
      def: 0,
      hint: x => {
        const d = deal(x.deal); const p = d && sideParty(d, x.from);
        if (!p) return '';
        const h = bal('2100', { party: p, deal: x.deal });
        const r = bal('1100', { party: p, deal: x.deal });
        return `Held from this client on this deal: ${fmt(h)}${r ? ` · Recoverable costs already due: ${fmt(r)}` : ''}`;
      },
    }),
    F('recv', 'Balance payment', 'select', {
      opts: [['later', 'Not yet paid — will follow up'], ['now', 'Received now into bank']], def: 'later',
    }),
  ],
  onchange: (k, v) => {
    if (k === 'deal' || k === 'from') {
      const d = deal(v.deal);
      if (d) {
        v.base = v.from === 'buyer' ? d.expBuyer : d.expSeller;
        const p = sideParty(d, v.from);
        v.adv = p ? bal('2100', { party: p, deal: v.deal }) : 0;
      }
    }
  },
  build: v => {
    const d = deal(v.deal);
    if (!d) return need('Pick a deal.');
    const pid = sideParty(d, v.from);
    if (!pid) return need('No ' + (v.from || 'party') + ' on this deal yet.');
    const base = num(v.base);
    if (!base) return need('Enter the brokerage amount.');

    const rate = num(v.gst);
    const gst = base * rate / 100;
    const total = base + gst;
    const tds = tdsOn() ? Math.round(base * num(v.tds) / 100) : 0;
    const held = bal('2100', { party: pid, deal: d.id });
    const adv = Math.min(num(v.adv), held, total);
    const rem = total - tds - adv;
    const recov = bal('1100', { party: pid, deal: d.id });
    const acc = v.from === 'buyer' ? '4010' : '4000';

    const lines = [{ acc, cr: base, deal: d.id, party: pid }];
    if (gst) lines.push({ acc: '2200', cr: gst, deal: d.id });
    if (tds) lines.push({ acc: '1150', dr: tds, party: pid, deal: d.id });
    if (adv) lines.push({ acc: '2100', dr: adv, party: pid, deal: d.id });
    if (rem > 0.5) {
      lines.push(v.recv === 'now'
        ? { acc: '1000', dr: rem }
        : { acc: '1100', dr: rem, party: pid, deal: d.id });
    }

    const eff = [`Income <b>${fmt(base)}</b> earned this month (${A[acc].name}).`];
    if (gst) eff.push(`${fmt(gst)} GST collected — owed to government, not yours.`);
    if (adv) eff.push(`${fmt(adv)} token converts to income.`);
    if (tds) eff.push(`${fmt(tds)} TDS withheld by the client — claim it at year-end.`);
    if (rem > 0.5) {
      eff.push(v.recv === 'now'
        ? `${fmt(rem)} into bank.`
        : `${fmt(rem)} now owed by ${esc(pname(pid))}${recov ? ` (plus ${fmt(recov)} recoverable costs = <b>${fmt(rem + recov)}</b> to collect)` : ''}.`);
    }
    if (held - adv > 0.5) eff.push(`${fmt(held - adv)} token still held — settle it separately.`);
    if (gst) eff.push('A GST invoice will be generated and numbered automatically.');

    const st = S().settings;
    const clientState = partyState(pid) || st.state;
    const gstSplit = splitGst(base, rate, clientState, st.state);

    return {
      desc: `Brokerage — ${dealLabel(d)} (${pname(pid)})`,
      lines, effects: eff,
      updates: [{ coll: 'deals', id: d.id, data: { status: 'registered' } }],
      invoice: gst ? {
        partyId: pid, dealId: d.id, base, gstRate: rate,
        cgst: gstSplit.cgst, sgst: gstSplit.sgst, igst: gstSplit.igst,
        total, date: v.date || today(),
      } : null,
    };
  },
};

// A party's state drives CGST/SGST vs IGST. Unknown state falls back to the company's own.
function partyState(pid) {
  const p = getState().parties.find(x => x.id === pid);
  return p?.state || '';
}

EV.dealpay = {
  title: 'Client pays', group: 'Deals',
  when: 'Payment against what this client owes on this deal (invoice plus recoverable costs). <b>No income again</b> — that was recorded at registration.',
  fields: v => [
    F('date', 'Date', 'date', { def: today() }),
    F('deal', 'Deal', 'deal', { opts: dealsWith('1100', x => x > 0.5) }),
    F('from', 'From', 'select', {
      opts: partySides(v.deal),
      hint: x => { const d = deal(x.deal); const p = d && sideParty(d, x.from); return p ? 'Owes: ' + fmt(bal('1100', { party: p, deal: x.deal })) : ''; },
    }),
    F('amt', 'Amount', 'number'),
    F('via', 'Into', 'select', { opts: [['1000', 'Bank / UPI'], ['1010', 'Petty cash']], def: '1000' }),
  ],
  onchange: (k, v) => {
    if (k === 'deal' || k === 'from') {
      const d = deal(v.deal); const p = d && sideParty(d, v.from);
      if (p) v.amt = bal('1100', { party: p, deal: v.deal });
    }
  },
  build: v => {
    const d = deal(v.deal);
    if (!d) return need('No deal has money outstanding.');
    const pid = sideParty(d, v.from);
    if (!pid) return need('Pick who is paying.');
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount received.');
    return {
      desc: `Payment — ${dealLabel(d)} (${pname(pid)})`,
      lines: [{ acc: v.via || '1000', dr: amt }, { acc: '1100', cr: amt, party: pid, deal: d.id }],
      effects: [`Cash in ${fmt(amt)}. What they owe drops. Profit unchanged.`],
    };
  },
};

EV.settle = {
  title: 'Settle a token — refund / keep / hold', group: 'Deals',
  when: 'Deal fell through, or the client changed plans. Split the held token the way it actually went: <b>refund</b> (no profit effect), <b>keep</b> (becomes income now), or leave it held for a future deal.',
  fields: v => [
    F('date', 'Date', 'date', { def: today() }),
    F('deal', 'Deal', 'deal', { opts: dealsWith('2100', x => x > 0.5) }),
    F('from', 'Client', 'select', {
      opts: partySides(v.deal),
      hint: x => { const d = deal(x.deal); const p = d && sideParty(d, x.from); return p ? 'Held: ' + fmt(bal('2100', { party: p, deal: x.deal })) : ''; },
    }),
    F('refund', 'Refund to client', 'number', { def: 0 }),
    F('keep', 'Keep as income (client agreed / non-refundable)', 'number', { def: 0 }),
    F('gst', 'GST % on the kept amount', 'number', { def: gstRate(), hint: 'Forfeited amounts are normally taxable — confirm with your CA' }),
    F('move', 'Move remainder to another deal', 'select', {
      opts: x => [['', 'No — keep holding on this deal'],
      ...S().deals.filter(d => d.id !== x.deal && d.status !== 'cancelled').map(d => [d.id, dealLabel(d)])],
    }),
    F('drop', 'Mark this deal cancelled?', 'select', { opts: [['no', 'No'], ['yes', 'Yes — deal is off']], def: 'no' }),
  ],
  build: v => {
    const d = deal(v.deal);
    if (!d) return need('No deal is holding a token.');
    const pid = sideParty(d, v.from);
    if (!pid) return need('Pick the client.');
    const held = bal('2100', { party: pid, deal: d.id });
    const ref = Math.min(num(v.refund), held);
    const keep = Math.min(num(v.keep), held - ref);
    const rest = held - ref - keep;
    const lines = [], eff = [];

    if (ref) {
      lines.push({ acc: '2100', dr: ref, party: pid, deal: d.id }, { acc: '1000', cr: ref });
      eff.push(`Refund ${fmt(ref)} — cash out, profit untouched.`);
    }
    if (keep) {
      const base = keep / (1 + num(v.gst) / 100);
      const g = keep - base;
      lines.push({ acc: '2100', dr: keep, party: pid, deal: d.id },
        { acc: '4030', cr: base, deal: d.id, party: pid });
      if (g > 0.5) lines.push({ acc: '2200', cr: g, deal: d.id });
      eff.push(`Keep ${fmt(keep)} → <b>income ${fmt(base)}</b> this month${g > 0.5 ? ' + ' + fmt(g) + ' GST' : ''}. No cash moves.`);
    }
    if (rest > 0.5) {
      if (v.move) {
        const t = deal(v.move);
        lines.push({ acc: '2100', dr: rest, party: pid, deal: d.id },
          { acc: '2100', cr: rest, party: pid, deal: t.id });
        eff.push(`${fmt(rest)} moves to "${esc(dealLabel(t))}" — still held, still not income.`);
      } else {
        eff.push(`${fmt(rest)} stays held on this deal.`);
      }
    }
    if (!lines.length) return need('Enter a refund or keep amount.');

    const updates = [];
    if (v.drop === 'yes') updates.push({ coll: 'deals', id: d.id, data: { status: 'cancelled' } });
    return { desc: `Token settled — ${dealLabel(d)} (${pname(pid)})`, lines, effects: eff, updates };
  },
};

EV.writeoff = {
  title: 'Write off what a client will never pay', group: 'Corrections',
  when: 'After real effort to collect. Removes the receivable and books the loss, so your books stop claiming money you do not have.',
  fields: v => [
    F('date', 'Date', 'date', { def: today() }),
    F('deal', 'Deal', 'deal', { opts: dealsWith('1100', x => x > 0.5) }),
    F('from', 'Client', 'select', {
      opts: partySides(v.deal),
      hint: x => { const d = deal(x.deal); const p = d && sideParty(d, x.from); return p ? 'Owes: ' + fmt(bal('1100', { party: p, deal: x.deal })) : ''; },
    }),
    F('amt', 'Amount', 'number'),
    F('why', 'Reason (kept for audit)', 'text'),
  ],
  build: v => {
    const d = deal(v.deal);
    if (!d) return need('Nothing outstanding to write off.');
    const pid = sideParty(d, v.from);
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount to write off.');
    return {
      desc: `Write-off — ${dealLabel(d)} (${pname(pid)})${v.why ? ': ' + v.why : ''}`,
      lines: [{ acc: '5190', dr: amt, deal: d.id }, { acc: '1100', cr: amt, party: pid, deal: d.id }],
      effects: [`Loss ${fmt(amt)} this month. Keep evidence of your follow-ups.`],
    };
  },
};

EV.absorb = {
  title: 'Recoverable cost not recovered — absorb it', group: 'Corrections',
  when: 'You paid something for the client and they will not pay it back. Moves it from "recoverable" to your own deal expense.',
  fields: v => [
    F('date', 'Date', 'date', { def: today() }),
    F('deal', 'Deal', 'deal', { opts: dealsWith('1100', x => x > 0.5) }),
    F('from', 'Client', 'select', {
      opts: partySides(v.deal),
      hint: x => { const d = deal(x.deal); const p = d && sideParty(d, x.from); return p ? 'Owed by them on this deal: ' + fmt(bal('1100', { party: p, deal: x.deal })) : ''; },
    }),
    F('amt', 'Amount to absorb', 'number'),
  ],
  build: v => {
    const d = deal(v.deal);
    if (!d) return need('Pick a deal.');
    const pid = sideParty(d, v.from);
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    return {
      desc: `Absorbed cost — ${dealLabel(d)}`,
      lines: [{ acc: '5045', dr: amt, deal: d.id }, { acc: '1100', cr: amt, party: pid, deal: d.id }],
      effects: [`${fmt(amt)} becomes your deal expense. Receivable from ${esc(pname(pid))} drops.`],
    };
  },
};

// ═══════ SERVICES ═══════

EV.subnew = {
  title: 'Add a service / subscription', group: 'Services',
  when: 'Sets the <b>expected</b> monthly charge. Each month you confirm what was <b>actually</b> charged. Upfront plans are paid once and their cost is released monthly at month-end.',
  fields: () => [
    F('date', 'Start date', 'date', { def: today() }),
    F('name', 'Service', 'text'),
    F('vendor', 'Vendor', 'text'),
    F('use', 'What for', 'text'),
    F('payMode', 'Payment', 'select', {
      opts: [['monthly', 'Charged every month'], ['upfront', 'Paid upfront for a term']], def: 'monthly',
    }),
    F('amount', 'Amount', 'number', {
      hint: x => x.payMode === 'upfront' ? 'Total paid upfront' : 'Expected per month (pay-as-you-go: your best estimate)',
    }),
    F('months', 'Term (months)', 'number', { def: 12, show: x => x.payMode === 'upfront' }),
    F('via', 'Charged to', 'select', { opts: PAY_VIA, def: '1000' }),
  ],
  build: v => {
    const amt = num(v.amount);
    if (!amt) return need('Enter the amount.');
    if (!String(v.name || '').trim()) return need('Name the service.');
    const up = v.payMode === 'upfront';
    const m = up ? Math.max(1, num(v.months)) : 1;
    const monthly = up ? amt / m : amt;
    const start = ym(v.date || today());
    const lines = up ? [{ acc: '1200', dr: amt }, { acc: v.via || '1000', cr: amt }] : [];

    return {
      desc: up ? `Subscription paid upfront — ${v.name}` : '',
      lines,
      effects: up
        ? [`Cash out ${fmt(amt)} now — but it is <b>not</b> all this month's cost.`,
        `Cost ${fmt(monthly)}/month for ${m} months, released automatically at each month-end.`]
        : [`Expected ${fmt(amt)}/month from ${mlabel(start)}.`,
        'Confirm the actual charge each month on the Services tab.'],
      docs: [{
        coll: 'subscriptions',
        data: {
          name: v.name, vendor: v.vendor || '', use: v.use || '',
          payMode: v.payMode || 'monthly', amount: amt, monthly, via: v.via || '1000',
          start, end: up ? addMonths(start, m - 1) : null, months: m,
          amortized: [], charges: {}, status: 'active', hasTxns: up,
        },
      }],
    };
  },
};

EV.confirmcharge = {
  title: "Confirm this month's charge", group: 'Services',
  when: 'The debit happened. Enter the real amount — pay-as-you-go services often differ from the estimate. If it was not charged this month, mark it skipped.',
  fields: () => [
    F('sub', 'Service', 'select', {
      opts: S().subs.filter(s => s.payMode === 'monthly' && s.status === 'active')
        .map(s => [s.id, `${s.name} — expected ${fmt(s.monthly)}`]),
    }),
    F('month', 'For month', 'month', { def: ym(today()) }),
    F('date', 'Charged on', 'date', { def: today() }),
    F('result', 'What happened', 'select', {
      opts: [['charged', 'Charged'], ['skipped', 'Not charged this month']], def: 'charged',
    }),
    F('amt', 'Actual amount', 'number', { show: x => x.result !== 'skipped' }),
  ],
  onchange: (k, v) => {
    if (k === 'sub') { const s = S().subs.find(x => x.id === v.sub); if (s) v.amt = s.monthly; }
  },
  build: v => {
    const s = S().subs.find(x => x.id === v.sub);
    if (!s) return need('Pick a service.');
    const month = v.month || ym(today());

    if (v.result === 'skipped') {
      return {
        desc: '', lines: [],
        effects: [`${esc(s.name)} marked not charged for ${mlabel(month)}. Run-rate is unaffected.`],
        updates: [{ coll: 'subscriptions', id: s.id, data: { [`charges.${month}`]: { actual: 0, skipped: true } } }],
      };
    }
    const amt = num(v.amt);
    if (!amt) return need('Enter the actual amount charged.');
    const diff = amt - num(s.monthly);
    return {
      desc: `${s.name} — ${mlabel(month)}`,
      lines: [{ acc: '5080', dr: amt }, { acc: s.via || '1000', cr: amt }],
      effects: [`Actual ${fmt(amt)} for ${mlabel(month)}${Math.abs(diff) > 0.5 ? ` (${diff > 0 ? '+' : ''}${fmt(diff)} vs expected)` : ' — as expected'}.`],
      updates: [{ coll: 'subscriptions', id: s.id, data: { [`charges.${month}`]: { actual: amt }, hasTxns: true } }],
    };
  },
};

EV.subchange = {
  title: 'Upgrade / downgrade a service', group: 'Services',
  when: 'The old line closes on the effective date and a new one opens. Past months stay correct. Any unused upfront balance is refunded or written off.',
  fields: () => [
    F('date', 'Effective date', 'date', { def: today() }),
    F('sub', 'Service', 'select', { opts: S().subs.filter(s => s.status === 'active').map(s => [s.id, s.name]) }),
    F('plan', 'New plan', 'text'),
    F('payMode', 'New payment', 'select', {
      opts: [['monthly', 'Charged every month'], ['upfront', 'Paid upfront']], def: 'monthly',
    }),
    F('amount', 'New amount', 'number'),
    F('months', 'Term (months)', 'number', { def: 12, show: x => x.payMode === 'upfront' }),
    F('refund', 'Refund of old unused prepaid', 'number', {
      def: 0,
      show: x => S().subs.find(s => s.id === x.sub)?.payMode === 'upfront',
      hint: x => { const s = S().subs.find(y => y.id === x.sub); return s?.payMode === 'upfront' ? 'Unused: ' + fmt(prepaidLeft(s)) : ''; },
    }),
  ],
  build: v => {
    const s = S().subs.find(x => x.id === v.sub);
    if (!s) return need('Pick a service.');
    const amt = num(v.amount);
    if (!amt) return need('Enter the new amount.');
    const up = v.payMode === 'upfront';
    const m = up ? Math.max(1, num(v.months)) : 1;
    const monthly = up ? amt / m : amt;
    const st = ym(v.date || today());
    const lines = [], eff = [];

    if (s.payMode === 'upfront') {
      const left = prepaidLeft(s);
      const ref = Math.min(num(v.refund), left);
      const loss = left - ref;
      if (ref) lines.push({ acc: '1000', dr: ref });
      if (loss > 0.5) lines.push({ acc: '5210', dr: loss });
      if (left > 0.5) {
        lines.push({ acc: '1200', cr: left });
        eff.push(`Old plan unused ${fmt(left)}: ${ref ? fmt(ref) + ' refunded' : ''}${ref && loss > 0.5 ? ', ' : ''}${loss > 0.5 ? fmt(loss) + ' lost this month' : ''}.`);
      }
    }
    if (up) {
      lines.push({ acc: '1200', dr: amt }, { acc: s.via || '1000', cr: amt });
      eff.push(`New plan ${fmt(amt)} upfront → ${fmt(monthly)}/month for ${m} months.`);
    } else {
      eff.push(`Expected ${fmt(amt)}/month from ${mlabel(st)}.`);
    }
    eff.push('The old line closes as "changed" — history stays intact.');

    return {
      desc: lines.length ? `Plan change — ${s.name} → ${v.plan || 'new plan'}` : '',
      lines, effects: eff,
      updates: [{ coll: 'subscriptions', id: s.id, data: { status: 'changed', end: st, closedOut: true } }],
      docs: [{
        coll: 'subscriptions',
        data: {
          name: `${s.name} (${v.plan || 'changed'})`, vendor: s.vendor, use: s.use,
          payMode: v.payMode || 'monthly', amount: amt, monthly, via: s.via || '1000',
          start: st, end: up ? addMonths(st, m - 1) : null, months: m,
          amortized: [], charges: {}, status: 'active', parent: s.id, hasTxns: up,
        },
      }],
    };
  },
};

EV.subcancel = {
  title: 'Cancel / pause / resume a service', group: 'Services',
  when: 'Monthly plans simply stop (or restart). For an upfront plan the unused balance must leave the books — either refunded, or booked as a loss.',
  fields: () => [
    F('date', 'Effective date', 'date', { def: today() }),
    F('sub', 'Service', 'select', {
      opts: S().subs.filter(s => ['active', 'paused'].includes(s.status)).map(s => [s.id, `${s.name} (${s.status})`]),
    }),
    F('action', 'Action', 'select', {
      opts: x => S().subs.find(s => s.id === x.sub)?.status === 'paused'
        ? [['resume', 'Resume'], ['cancel', 'Cancel']]
        : [['cancel', 'Cancel'], ['pause', 'Pause']],
    }),
    F('refund', 'Refund received', 'number', {
      def: 0,
      show: x => S().subs.find(s => s.id === x.sub)?.payMode === 'upfront' && x.action === 'cancel',
      hint: x => { const s = S().subs.find(y => y.id === x.sub); return s ? 'Unused: ' + fmt(prepaidLeft(s)) : ''; },
    }),
  ],
  build: v => {
    const s = S().subs.find(x => x.id === v.sub);
    if (!s) return need('Pick a service.');
    const eff = [], lines = [];
    const when = ym(v.date || today());

    if (v.action === 'resume') {
      return {
        desc: '', lines: [],
        effects: [`${esc(s.name)} resumes from ${mlabel(when)}. Run-rate goes back up by ${fmt(s.monthly)}.`],
        updates: [{ coll: 'subscriptions', id: s.id, data: { status: 'active', end: null } }],
      };
    }

    if (v.action === 'cancel' && s.payMode === 'upfront') {
      const left = prepaidLeft(s);
      const ref = Math.min(num(v.refund), left);
      const loss = left - ref;
      if (ref) lines.push({ acc: '1000', dr: ref });
      if (loss > 0.5) lines.push({ acc: '5210', dr: loss });
      if (left > 0.5) lines.push({ acc: '1200', cr: left });
      eff.push(left > 0.5
        ? `Unused ${fmt(left)}: ${ref ? fmt(ref) + ' refunded' : ''}${ref && loss > 0.5 ? ', ' : ''}${loss > 0.5 ? '<b>' + fmt(loss) + ' lost</b> — hits profit this month' : ''}.`
        : 'Nothing left to settle.');
    } else {
      eff.push(`${v.action === 'pause' ? 'Paused' : 'Stopped'} from ${mlabel(when)}. Run-rate drops by ${fmt(s.monthly)}.`);
    }

    const data = { status: v.action === 'pause' ? 'paused' : 'cancelled', end: when };
    if (v.action === 'cancel' && s.payMode === 'upfront') data.closedOut = true;
    return {
      desc: lines.length ? `Cancelled — ${s.name}` : '',
      lines, effects: eff,
      updates: [{ coll: 'subscriptions', id: s.id, data }],
    };
  },
};

// ═══════ MONEY OUT ═══════

EV.expense = {
  title: 'Expense paid now', group: 'Money out',
  when: 'Rent, EB, fuel, a print job — used and paid in the same period. Deal-related? Use "Cost for this deal" instead so it counts against that deal.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('desc', 'What', 'text'),
    F('acc', 'Category', 'select', { opts: EXP.map(a => [a.code, a.name]) }),
    F('amt', 'Amount', 'number'),
    F('gstin', 'GST input you can claim', 'number', { def: 0, hint: '0 if unsure' }),
    F('via', 'Paid via', 'select', { opts: PAY_VIA, def: '1000' }),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    if (!v.acc) return need('Pick a category.');
    const gi = Math.min(num(v.gstin), amt);
    const lines = [{ acc: v.acc, dr: amt - gi }];
    if (gi) lines.push({ acc: '1400', dr: gi });
    lines.push({ acc: v.via || '1000', cr: amt });
    return {
      desc: v.desc || A[v.acc].name,
      lines,
      effects: [
        `Cost ${fmt(amt - gi)} this month.`,
        gi ? `${fmt(gi)} GST input credit claimed — reduces your GST bill.` : '',
        v.via === '2300' ? 'On the card: your card balance grows. Paying the card bill later is a transfer, not another expense.' : '',
      ].filter(Boolean),
    };
  },
};

EV.bill = {
  title: 'Bill received — pay later', group: 'Money out',
  when: 'The cost belongs to now; the payment is a separate event later.',
  fields: () => [
    F('date', 'Bill date', 'date', { def: today() }),
    F('vendor', 'Vendor', 'party', { partyType: 'vendor' }),
    F('desc', 'What for', 'text'),
    F('acc', 'Category', 'select', { opts: EXP.map(a => [a.code, a.name]) }),
    F('amt', 'Bill amount', 'number'),
    F('gstin', 'GST input you can claim', 'number', { def: 0 }),
    F('tds', 'TDS section', 'select', { opts: TDS_SECTIONS.map(t => [t[0], t[1]]), show: () => tdsOn() }),
    F('tdsrate', 'TDS %', 'number', { def: 0, show: () => tdsOn(), hint: 'Auto-filled from the section — verify rates with your CA' }),
  ],
  onchange: (k, v) => {
    if (k === 'tds') { const t = TDS_SECTIONS.find(x => x[0] === v.tds); if (t) v.tdsrate = t[2]; }
  },
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the bill amount.');
    if (!v.acc) return need('Pick a category.');
    const pid = pidOf(v.vendor);
    if (!pid) return need('Name the vendor.');
    const gi = Math.min(num(v.gstin), amt);
    const net = amt - gi;
    const tds = tdsOn() ? Math.round(net * num(v.tdsrate) / 100) : 0;
    const lines = [{ acc: v.acc, dr: net }];
    if (gi) lines.push({ acc: '1400', dr: gi });
    if (tds) lines.push({ acc: '2250', cr: tds });
    lines.push({ acc: '2000', cr: amt - tds, party: pid });
    return {
      desc: `${v.desc || A[v.acc].name} — ${pnameOf(v.vendor)}`,
      lines,
      effects: [
        `Cost ${fmt(net)} this month. No cash has moved yet.`,
        `You owe ${esc(pnameOf(v.vendor))} ${fmt(amt - tds)}.`,
        tds ? `${fmt(tds)} TDS to deposit by the 7th of next month.` : '',
      ].filter(Boolean),
    };
  },
};

EV.paybill = {
  title: 'Pay a vendor', group: 'Money out',
  when: 'Settles a bill you already recorded. This is not an expense again — the cost was booked when the bill arrived.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('party', 'Who', 'select', { opts: pick('2000', 'owes') }),
    F('amt', 'Amount', 'number'),
    F('via', 'Paid via', 'select', { opts: PAY_VIA, def: '1000' }),
  ],
  onchange: (k, v) => { if (k === 'party') v.amt = bal('2000', { party: v.party }); },
  build: v => {
    if (!v.party) return need('Pick who you are paying.');
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    return {
      desc: `Paid ${pname(v.party)}`,
      lines: [{ acc: '2000', dr: amt, party: v.party }, { acc: v.via || '1000', cr: amt }],
      effects: [`What you owe ${esc(pname(v.party))} drops by ${fmt(amt)}. Profit unchanged.`],
    };
  },
};

EV.salary = {
  title: 'Salary / bonus', group: 'Money out',
  when: 'The cost is the gross. Deductions are held for the government until you deposit them.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('emp', 'Employee', 'party', { partyType: 'employee' }),
    F('kind', 'Kind', 'select', { opts: [['5010', 'Salary'], ['5020', 'Bonus / incentive']], def: '5010' }),
    F('gross', 'Gross', 'number'),
    F('tds', 'TDS', 'number', { def: 0, show: () => tdsOn() }),
    F('pf', 'PF / ESI', 'number', { def: 0 }),
  ],
  build: v => {
    const g = num(v.gross);
    if (!g) return need('Enter the gross amount.');
    const t = tdsOn() ? num(v.tds) : 0;
    const p = num(v.pf);
    const net = g - t - p;
    const pid = pidOf(v.emp);
    const lines = [{ acc: v.kind || '5010', dr: g, party: pid || undefined }, { acc: '1000', cr: net }];
    if (t) lines.push({ acc: '2250', cr: t });
    if (p) lines.push({ acc: '2550', cr: p });
    return {
      desc: `${A[v.kind || '5010'].name} — ${pnameOf(v.emp)}`,
      lines,
      effects: [
        `Cost ${fmt(g)} this month; net paid ${fmt(net)}.`,
        (t || p) ? `${fmt(t + p)} statutory dues held until you deposit them.` : '',
      ].filter(Boolean),
    };
  },
};

EV.asset = {
  title: 'Buy an asset', group: 'Money out',
  when: 'Something that lasts over a year is not an expense. Its cost spreads over its useful life as monthly depreciation.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('name', 'Item', 'text'),
    F('cost', 'Cost', 'number', {
      hint: () => `Anything under ${fmt(S().settings.capitalisationThreshold)} is normally a straight expense, not an asset`,
    }),
    F('gstin', 'GST input you can claim', 'number', { def: 0 }),
    F('life', 'Useful life (months)', 'number', { def: 36 }),
    F('via', 'Paid via', 'select', { opts: PAY_VIA, def: '1000' }),
  ],
  build: v => {
    const c = num(v.cost);
    if (!c) return need('Enter the cost.');
    if (!String(v.name || '').trim()) return need('Name the item.');
    const gi = Math.min(num(v.gstin), c);
    const net = c - gi;
    const life = Math.max(1, num(v.life));
    const lines = [{ acc: '1300', dr: net }];
    if (gi) lines.push({ acc: '1400', dr: gi });
    lines.push({ acc: v.via || '1000', cr: c });
    return {
      desc: `Asset — ${v.name}`,
      lines,
      effects: [
        `Cash out ${fmt(c)}, but profit is <b>unchanged</b> right now.`,
        `Depreciation ${fmt(net / life)}/month for ${life} months, posted automatically at each month-end.`,
      ],
      docs: [{
        coll: 'assets',
        data: {
          name: v.name, cost: net, date: v.date || today(), start: ym(v.date || today()),
          life, monthly: net / life, depreciated: [], status: 'in use', hasTxns: true,
        },
      }],
    };
  },
};

EV.assetdispose = {
  title: 'Sell or scrap an asset', group: 'Money out',
  when: 'Removes the asset and the depreciation built up against it. Anything you get above the written-down value is a gain; below it, a loss.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('assetId', 'Asset', 'select', {
      opts: S().assets.filter(a => a.status === 'in use').map(a => {
        const wdv = num(a.cost) - (a.depreciated || []).length * num(a.monthly);
        return [a.id, `${a.name} — value left ${fmt(wdv)}`];
      }),
    }),
    F('proceeds', 'Amount received', 'number', { def: 0, hint: 'Zero if scrapped' }),
    F('via', 'Received into', 'select', { opts: [['1000', 'Bank / UPI'], ['1010', 'Petty cash']], def: '1000' }),
  ],
  build: v => {
    const a = S().assets.find(x => x.id === v.assetId);
    if (!a) return need('Pick an asset.');
    const accumulated = (a.depreciated || []).length * num(a.monthly);
    const wdv = num(a.cost) - accumulated;
    const proceeds = num(v.proceeds);
    const gain = proceeds - wdv;

    // Remove the asset at cost and clear the depreciation stacked against it, then book
    // whatever the sale did or did not recover.
    const lines = [];
    if (proceeds) lines.push({ acc: v.via || '1000', dr: proceeds });
    if (accumulated > 0.5) lines.push({ acc: '1350', dr: accumulated });
    lines.push({ acc: '1300', cr: num(a.cost) });
    if (gain > 0.5) lines.push({ acc: '4040', cr: gain });
    else if (gain < -0.5) lines.push({ acc: '5220', dr: -gain });

    return {
      desc: `Disposed — ${a.name}`,
      lines,
      effects: [
        `Asset removed at cost ${fmt(a.cost)}; ${fmt(accumulated)} of depreciation cleared with it.`,
        `Value left on the books was ${fmt(wdv)}; you received ${fmt(proceeds)}.`,
        gain > 0.5 ? `<b>Gain ${fmt(gain)}</b> booked to Other income this month.`
          : gain < -0.5 ? `<b>Loss ${fmt(-gain)}</b> booked this month.`
            : 'No gain or loss — it sold for exactly its written-down value.',
        'No more depreciation will be posted for it at month-end.',
      ],
      updates: [{ coll: 'assets', id: a.id, data: { status: 'disposed', disposedOn: v.date || today() } }],
    };
  },
};

EV.petty = {
  title: 'Petty cash — enter vouchers', group: 'Money out',
  when: 'Do this weekly. Enter up to three categories at once. Top the box up with "Move money".',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('a1', 'Amount', 'number'),
    F('c1', 'Category', 'select', { opts: EXP.map(a => [a.code, a.name]) }),
    F('a2', 'Amount', 'number', { def: 0 }),
    F('c2', 'Category', 'select', { opts: EXP.map(a => [a.code, a.name]) }),
    F('a3', 'Amount', 'number', { def: 0 }),
    F('c3', 'Category', 'select', { opts: EXP.map(a => [a.code, a.name]) }),
  ],
  build: v => {
    const lines = [];
    let tot = 0;
    [[v.a1, v.c1], [v.a2, v.c2], [v.a3, v.c3]].forEach(([a, c]) => {
      const amt = num(a);
      if (amt > 0 && c) { lines.push({ acc: c, dr: amt }); tot += amt; }
    });
    if (!tot) return need('Enter at least one voucher.');
    lines.push({ acc: '1010', cr: tot });
    return {
      desc: 'Petty cash spends',
      lines,
      effects: [`${fmt(tot)} out of the box. Box after this: ${fmt(bal('1010') - tot)}.`],
    };
  },
};

EV.director = {
  title: 'Director paid a company cost personally', group: 'Money out',
  when: 'The cost is recorded now and the company owes you. Reimburse yourself later with "Move money".',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('desc', 'What', 'text'),
    F('acc', 'Category', 'select', { opts: EXP.map(a => [a.code, a.name]) }),
    F('amt', 'Amount', 'number'),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    if (!v.acc) return need('Pick a category.');
    return {
      desc: `${v.desc || A[v.acc].name} (paid by director)`,
      lines: [{ acc: v.acc, dr: amt }, { acc: '2450', cr: amt }],
      effects: [`Cost ${fmt(amt)} this month.`, `The company now owes the director ${fmt(amt)}.`],
    };
  },
};

// ═══════ MONEY IN & FUNDING ═══════

EV.otherinc = {
  title: 'Other income', group: 'Money in',
  when: "Interest, a referral fee, anything earned that is not a deal.",
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('desc', 'What', 'text'),
    F('acc', 'Type', 'select', {
      opts: [['4040', 'Other income'], ['4020', 'Consultancy income'], ['4050', 'Bad debt recovered']],
      def: '4040',
    }),
    F('amt', 'Amount', 'number'),
    F('via', 'Into', 'select', { opts: [['1000', 'Bank / UPI'], ['1010', 'Petty cash']], def: '1000' }),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    return {
      desc: v.desc || A[v.acc || '4040'].name,
      lines: [{ acc: v.via || '1000', dr: amt }, { acc: v.acc || '4040', cr: amt }],
      effects: [`Income ${fmt(amt)} this month.`],
    };
  },
};

EV.funding = {
  title: 'Capital / director loan received', group: 'Money in',
  when: '<b>Never income.</b> Share capital is ownership; a director loan is repayable. Either way your profit does not change.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('kind', 'Kind', 'select', { opts: [['3000', 'Share capital'], ['2450', "Director's loan"]], def: '3000' }),
    F('who', 'From', 'text'),
    F('amt', 'Amount', 'number'),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    const kind = v.kind || '3000';
    return {
      desc: `${A[kind].name} — ${v.who || ''}`.trim(),
      lines: [{ acc: '1000', dr: amt }, { acc: kind, cr: amt }],
      effects: [
        `Bank up ${fmt(amt)}. Profit unchanged — this is <b>not</b> income.`,
        kind === '3000' ? 'Share capital needs a board resolution and an ROC filing — tell your CA.' : 'Repayable to the director.',
      ],
    };
  },
};

EV.bankloan = {
  title: 'Bank / NBFC loan (EMI)', group: 'Money in',
  when: 'Creates the loan with its month-by-month principal and interest schedule.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('lender', 'Lender', 'party', { partyType: 'lender' }),
    F('purpose', 'Purpose', 'text'),
    F('amt', 'Amount', 'number'),
    F('rate', 'Interest % p.a.', 'number', { def: 12 }),
    F('n', 'Tenure (months)', 'number', { def: 24 }),
    F('fee', 'Processing fee', 'number', { def: 0 }),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the loan amount.');
    const pid = pidOf(v.lender);
    if (!pid) return need('Name the lender.');
    const fee = num(v.fee);
    const n = Math.max(1, num(v.n));
    const lines = [{ acc: '1000', dr: amt - fee }, { acc: '2400', cr: amt, party: pid }];
    if (fee) lines.push({ acc: '5150', dr: fee });
    const sch = schedule(amt, num(v.rate), n, addMonths(ym(v.date || today()), 1));
    const totalInterest = sch.reduce((s, x) => s + x.int, 0);
    return {
      desc: `Loan — ${pnameOf(v.lender)}${v.purpose ? ' (' + v.purpose + ')' : ''}`,
      lines,
      effects: [
        `Bank up ${fmt(amt - fee)}. Loan owed ${fmt(amt)}. <b>Not income.</b>`,
        `EMI ≈ ${fmt(sch[0].emi)} × ${n} months. Total interest over the life: <b>${fmt(totalInterest)}</b>.`,
        fee ? `${fmt(fee)} processing fee is a cost this month.` : '',
      ].filter(Boolean),
      docs: [{
        coll: 'loans',
        data: {
          lender: pnameOf(v.lender), purpose: v.purpose || '', principal: amt,
          rate: num(v.rate), n, start: addMonths(ym(v.date || today()), 1),
          schedule: sch, paid: [], status: 'active', partyId: pid, hasTxns: true,
        },
      }],
    };
  },
};

// ═══════ LOANS & ADJUSTMENTS ═══════

EV.emi = {
  title: 'Pay an EMI', group: 'Move money',
  when: 'Principal returns money you borrowed — that is not a cost. Only the interest is. The split comes from the schedule.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('loan', 'Loan', 'select', {
      opts: S().loans.filter(l => l.status === 'active').map(l => [l.id, `${l.lender} — ${l.purpose || 'loan'}`]),
    }),
    F('extra', 'Late fee / penalty', 'number', { def: 0 }),
  ],
  build: v => {
    const l = S().loans.find(x => x.id === v.loan);
    if (!l) return need('No active loan.');
    const i = l.schedule.find(s => !(l.paid || []).includes(s.n));
    if (!i) return need('This loan is fully paid.');
    const x = num(v.extra);
    const lines = [
      { acc: '2400', dr: i.prin, party: l.partyId },
      { acc: '5150', dr: i.int },
      { acc: '1000', cr: i.emi + x },
    ];
    if (x) lines.push({ acc: '5140', dr: x });
    return {
      desc: `EMI ${i.n}/${l.n} — ${l.lender}`,
      lines,
      effects: [
        `Cash out ${fmt(i.emi + x)}.`,
        `Cost this month is only <b>${fmt(i.int)} interest</b>${x ? ' + ' + fmt(x) + ' penalty' : ''} — the ${fmt(i.prin)} principal is not a cost.`,
        `Loan balance after this: ${fmt(i.bal)}.`,
      ],
      updates: [{
        coll: 'loans', id: l.id,
        data: {
          paid: [...(l.paid || []), i.n],
          status: (l.paid || []).length + 1 >= l.n ? 'closed' : 'active',
        },
      }],
    };
  },
};

EV.card2emi = {
  title: 'Convert a card purchase to EMI', group: 'Move money',
  when: 'The purchase is already recorded. This only restructures the debt and adds a financing cost.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('what', 'What', 'text'),
    F('amt', 'Amount converted', 'number', { hint: () => 'Card outstanding: ' + fmt(bal('2300')) }),
    F('rate', 'Interest % p.a.', 'number', { def: 14 }),
    F('n', 'Tenure (months)', 'number', { def: 12 }),
    F('fee', 'Conversion fee', 'number', { def: 0 }),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount to convert.');
    const fee = num(v.fee);
    const n = Math.max(1, num(v.n));
    const pid = pidOf(v.__lender || { __new: true, name: 'Card EMI', type: 'lender' });
    const lines = [{ acc: '2300', dr: amt }, { acc: '2400', cr: amt, party: pid }];
    if (fee) lines.push({ acc: '5150', dr: fee }, { acc: '2300', cr: fee });
    const sch = schedule(amt, num(v.rate), n, addMonths(ym(v.date || today()), 1));
    const totalInterest = sch.reduce((s, x) => s + x.int, 0);
    return {
      desc: `Card → EMI: ${v.what || 'purchase'}`,
      lines,
      effects: [
        `Card balance down ${fmt(amt)}, loan up ${fmt(amt)}. Your total debt is unchanged.`,
        `This will cost <b>${fmt(totalInterest)}</b> in interest over ${n} months${fee ? ' plus a ' + fmt(fee) + ' fee' : ''}.`,
      ],
      newParty: { name: 'Card EMI', type: 'lender' },
      docs: [{
        coll: 'loans',
        data: {
          lender: 'Card EMI', purpose: v.what || '', principal: amt, rate: num(v.rate), n,
          start: addMonths(ym(v.date || today()), 1),
          schedule: sch, paid: [], status: 'active', partyId: pid, hasTxns: true,
        },
      }],
    };
  },
};

EV.transfer = {
  title: 'Move money between your own pockets', group: 'Move money',
  when: 'Bank to petty cash, paying the card bill, reimbursing the director. <b>Never an expense</b> — the money is still yours (or still owed).',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('kind', 'Move', 'select', {
      opts: [
        ['1000>1010', 'Bank → petty cash'],
        ['1010>1000', 'Petty cash → bank'],
        ['1000>2300', 'Pay the credit-card bill'],
        ['1000>2450', 'Reimburse the director'],
        ['2450>1000', 'Director puts money in'],
      ], def: '1000>1010',
    }),
    F('amt', 'Amount', 'number'),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    const [f, t] = (v.kind || '1000>1010').split('>');
    return {
      desc: `Transfer: ${A[f].name} → ${A[t].name}`,
      lines: [{ acc: t, dr: amt }, { acc: f, cr: amt }],
      effects: [`${fmt(amt)} moved. Profit unchanged — this is not a cost.`],
    };
  },
};

EV.statutory = {
  title: 'Pay GST / TDS / PF to government', group: 'Move money',
  when: 'Remitting what you collected or withheld on someone else\'s behalf. Not an expense — you were only holding it.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('kind', 'Which', 'select', {
      opts: [['gst', 'GST (net of input credit)'], ['tds', 'TDS'], ['pf', 'PF / ESI']], def: 'gst',
    }),
    F('amt', 'Paid from bank', 'number', {
      hint: x => ({
        gst: `GST payable ${fmt(bal('2200'))} · input credit available ${fmt(bal('1400'))}`,
        tds: 'TDS payable ' + fmt(bal('2250')),
        pf: 'Dues ' + fmt(bal('2550')),
      }[x.kind || 'gst']),
    }),
    F('input', 'Input credit used', 'number', { def: 0, show: x => (x.kind || 'gst') === 'gst' }),
    F('late', 'Interest / late fee', 'number', { def: 0 }),
  ],
  build: v => {
    const amt = num(v.amt);
    const inp = num(v.input);
    const late = num(v.late);
    if (!amt && !inp) return need('Enter what you paid.');
    const acc = { gst: '2200', tds: '2250', pf: '2550' }[v.kind || 'gst'];
    const lines = [{ acc, dr: amt + inp - late }];
    if (inp) lines.push({ acc: '1400', cr: inp });
    if (late) lines.push({ acc: '5160', dr: late });
    lines.push({ acc: '1000', cr: amt });
    return {
      desc: `${(v.kind || 'gst').toUpperCase()} remitted`,
      lines,
      effects: [
        `Liability cleared by ${fmt(amt + inp - late)}.`,
        inp ? `${fmt(inp)} settled using input credit rather than cash.` : '',
        late ? `${fmt(late)} late fee is a real cost this month.` : '',
      ].filter(Boolean),
    };
  },
};

EV.vendorrefund = {
  title: 'Vendor refunded you', group: 'Corrections',
  when: 'Reduces the original cost rather than counting as income.',
  fields: () => [
    F('date', 'Date', 'date', { def: today() }),
    F('desc', 'What', 'text'),
    F('acc', 'Original category', 'select', { opts: EXP.map(a => [a.code, a.name]) }),
    F('amt', 'Amount', 'number'),
    F('via', 'Into', 'select', { opts: [['1000', 'Bank'], ['2300', 'Card reversal']], def: '1000' }),
  ],
  build: v => {
    const amt = num(v.amt);
    if (!amt) return need('Enter the amount.');
    if (!v.acc) return need('Pick the category it was originally booked to.');
    return {
      desc: `Refund — ${v.desc || A[v.acc].name}`,
      lines: [{ acc: v.via || '1000', dr: amt }, { acc: v.acc, cr: amt }],
      effects: [`${fmt(amt)} back. ${A[v.acc].name} for this month is reduced, not treated as income.`],
    };
  },
};

// ═══════ GROUPING FOR THE RECORD SCREEN ═══════

export const CHOOSER = [
  ['Deals', ['newdeal', 'token', 'dealcost', 'invoice', 'dealpay', 'settle']],
  ['Money out', ['expense', 'bill', 'paybill', 'salary', 'asset', 'assetdispose', 'petty', 'director']],
  ['Money in & funding', ['otherinc', 'funding', 'bankloan']],
  ['Services', ['subnew', 'confirmcharge', 'subchange', 'subcancel']],
  ['Move money', ['emi', 'card2emi', 'transfer', 'statutory']],
  ['Corrections', ['writeoff', 'absorb', 'vendorrefund']],
];

// Which field keys on each event hold a party, so finance-sync.js knows what to
// materialise before it calls build() for real.
export const PARTY_FIELDS = {
  newdeal: ['seller', 'buyer'],
  dealcost: ['vendor'],
  bill: ['vendor'],
  salary: ['emp'],
  bankloan: ['lender'],
};

export function fieldsFor(key, v) {
  const ev = EV[key];
  if (!ev) return [];
  const list = typeof ev.fields === 'function' ? ev.fields(v || {}) : ev.fields;
  return list.filter(f => typeof f.show !== 'function' || f.show(v || {}));
}
