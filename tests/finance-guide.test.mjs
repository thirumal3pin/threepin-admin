// ═══════ GUIDE — EVERY TAB RENDERS, EVERY EXAMPLE BUILDS ═══════
//
// The guide runs the real builders and validators against sample books. If an example stops
// building, or a form would refuse a scenario meant to succeed, this is where it shows.
//
//   node tests/finance-guide.test.mjs

globalThis.window = { fin: { repaint() {} } };
const { renderGuide } = await import('../finance-assets/views-guide.js');
const { CHOOSER, EV } = await import('../finance-assets/finance-events.js');
const { getState, setState, blank, ACCOUNTS } = await import('../finance-assets/finance-core.js');
const { check, section, report } = await import('./_harness.mjs');

console.log('3 PIN Realty — guide');
setState(blank());
const realBefore = JSON.stringify(getState());

const bad = html => {
  const m = html.match(/undefined|NaN|\[object Object\]|could not be built/);
  return m ? m[0] + ' near "' + html.slice(Math.max(0, m.index - 80), m.index + 40).replace(/\s+/g, ' ') + '"' : '';
};

for (const t of ['start', 'screens', 'sop', 'actions', 'scenarios', 'accounting', 'charts', 'faq']) {
  section('Tab: ' + t);
  window.finGuide.setTab(t);
  const html = renderGuide();
  check(`${t} renders`, html.length > 2000, String(html.length));
  check(`${t} has no undefined / NaN / build errors`, !bad(html), bad(html));
  if (t === 'scenarios') {
    const refused = (html.match(/The form would refuse this: ([^<]*)/g) || []);
    check('No worked example is refused by its own form', refused.length === 0, refused.join(' | '));
    const cards = (html.match(/guide-scenario/g) || []).length;
    check('Every scenario rendered a card', cards >= 30, String(cards));
    check('Guards section shows red and amber notes', /ferr err/.test(html) && /ferr warn/.test(html));
    check('The Claude upgrade example shows the new expectation', /expected charge becomes <b>₹10,000<\/b>/.test(html));
  }
  if (t === 'actions') {
    // Distinct buttons: a key listed in two groups (dealcost) is documented once.
    const n = new Set(CHOOSER.flatMap(([, items]) => items.filter(i => EV[i.key]).map(i => i.key + '|' + JSON.stringify(i.preset || {})))).size;
    const cards = (html.match(/guide-action/g) || []).length;
    check(`One reference card per Record button (${n})`, cards === n, String(cards));
    check('Conditional fields are surfaced ("appears when")', /appears when/.test(html));
  }
  if (t === 'faq') check('Glossary present', /Glossary/.test(html) && /Reverse charge/.test(html));
  if (t === 'screens') {
    for (const page of ['Overview', 'Record', 'This month', 'Transactions', 'Owed', 'Deals & invoices',
      'Recurring', 'Budget', 'Bank & card statements', 'Petty cash', 'Loans', 'Assets', 'GST',
      'Reports', 'Analytics', 'Books', 'Profile', 'Settings']) {
      // Page names are escaped in the markup, so an ampersand arrives as &amp;.
      check(`The screens tab covers ${page}`, html.includes(page.replace(/&/g, '&amp;')));
    }
    check('Each screen says what question it answers', (html.match(/Where the figures come from/g) || []).length >= 12);
    check('…and what to do there', (html.match(/What to do here/g) || []).length >= 12);
  }
  if (t === 'accounting') {
    for (const topic of ['The chart of accounts', 'When a cost or income is recognised', 'Documents, allocation',
      'GST', 'TDS', 'Assets, prepaid costs and borrowing', 'The statements', 'The check, test by test',
      'What the app will not let you do', 'The audit trail']) {
      check(`The accounting tab covers ${topic}`, html.includes(topic));
    }
    check('Every account in the chart is listed', ACCOUNTS.every(a => html.includes(a.code)),
      ACCOUNTS.filter(a => !html.includes(a.code)).map(a => a.code).join(','));
    check('Every account says what lands in it', !/<td class="small"><\/td>/.test(html));
    check('The statutory basis is cited, not just asserted',
      /s\.16\(2\)/.test(html) && /s\.17\(5\)/.test(html) && /Rule 88A/.test(html) && /Rule 30\(2\)/.test(html) && /AS 5/.test(html));
    check('Blocked credits name the four accounts', ['5030', '5050', '5075', '5185'].every(c => html.includes(c)));
  }
}

section('Search');
window.finGuide.find('prorated');
let html = renderGuide();
check('Search finds the upgrade story across tabs', /prorated/i.test(html) && /Worked examples/.test(html) && /FAQ/.test(html));
window.finGuide.find('zzzzqqq');
html = renderGuide();
check('No-match search says so', /Nothing in the guide matches/.test(html));
window.finGuide.setTab('start');

section('Isolation');
check('Rendering the guide never touches the real books', JSON.stringify(getState()) === realBefore);

report();
