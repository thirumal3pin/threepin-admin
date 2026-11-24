// Properties tab, the smart box: realistic requirements a sales person types.
import { smart, read, summary, shot, errorsOf, mask } from './_h.mjs';

export default async function ({ S, admin, OUT, log }) {
  const page = admin.page;
  await page.goto(S.BASE + '/match.html');
  await page.waitForSelector('#q');
  await page.waitForTimeout(800);
  log('boot errors:', await errorsOf(page));
  const Q = [
    '2 BHK in Anna Nagar under 2 Cr',
    '3bhk anna nagr 3 cr not mogappair',
    'villa in ECR with pool',
    'land for sale in Porur',
    '2 grounds land Choolaimedu',
    '4 grounds JV chennai',
    'commercial space for rent Valasaravakkam 2.5 L per month',
    'office space for rent OMR 3000 sqft',
    '2bhk for rent velachery 25k',
    'independent house velachery 2.5 cr',
    '3 BHK Adyar ready to move',
    '3bhk anna nagar la venum 3 cr kulla',
    'asdkjh qwe zzz',
    '3 cr',
    'Porur',
    'Client called yesterday, wants 3 BHK apartment preferably in Anna Nagar or Kilpauk, budget around 2.5 to 3 Cr, ready to move, east facing, covered car parking needed, not interested in Mogappair or Ambattur. Wife works in Nungambakkam. Will visit on Sunday. Has loan pre-approval from SBI. Follow up after Diwali.',
    'plot in Kundrathur under 50 L',
    '2 BHK for rent Alwarpet 45000',
  ];
  let k = 0;
  for (const q of Q) {
    const t = await smart(page, q);
    const r = await read(page);
    log(`\n▶ "${q.slice(0, 80)}"  ${t.ms} ms (server ${t.serverMs} ms, ${t.status}) mode=${t.body && t.body.mode} total=${t.body && t.body.total}`);
    log(summary(r, 10));
    // Server-side facts for every row: deal / type / status / source, for mix-ups.
    if (t.body && Array.isArray(t.body.rows)) {
      const odd = t.body.rows.slice(0, 30).map(x => `${x.pct}% ${x.source}/${x.type || '-'}/${x.deal || '-'}${x.jv ? '/jv' : ''} ${x.status || ''} ${x.name || ''} @${x.location || ''} ${x.price || ''}`);
      log(mask('  server rows: \n    ' + odd.join('\n    ')));
      if (t.body.reading) log('  reading.item: ' + JSON.stringify(t.body.reading.item));
    }
    const e = await errorsOf(page);
    if (e.length) log('  ERRORS: ' + mask(e.join(' | ')));
    await shot(page, OUT, 'p10-' + String(++k).padStart(2, '0'), true);
  }
  // Empty submit: nothing should happen, focus stays in the box.
  await page.fill('#q', '');
  const before = await read(page);
  await page.click('#qGo');
  await page.waitForTimeout(500);
  const after = await read(page);
  log('\n▶ empty submit: title before/after', before.title, '|', after.title, 'focus:', await page.evaluate(() => document.activeElement && document.activeElement.id));
}
