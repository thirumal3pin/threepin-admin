// Search timings straight against /api/match (server + network, as the page sees them).
export default async function ({ S, admin, log }) {
  const page = admin.page;
  await page.goto(S.BASE + '/match.html'); await page.waitForSelector('#q');
  const call = body => page.evaluate(async b => {
    const { auth } = await import('/shared-assets/agent-client.js');
    const tok = await auth.currentUser.getIdToken(); const t0 = performance.now();
    const r = await fetch('/api/match', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ action: 'search', limit: 60, ...b }) });
    const j = await r.json(); return { ms: Math.round(performance.now() - t0), total: j.total, bytes: JSON.stringify(j).length };
  }, body);
  const cases = [['props warm', { mode: 'smart', text: '3 BHK Anna Nagar 3 Cr' }], ['props broad "3 cr"', { mode: 'smart', text: '3 cr' }], ['clients ANR003', { mode: 'clients', propertyId: 'ANR003' }],
    ['clients broad "house"', { mode: 'clients', details: { type: 'Independent House' } }], ['demand unprocessed', { mode: 'smart', text: 'unprocessed seller leads that match active buyer requirements' }],
    ['demand shoot', { mode: 'smart', text: 'properties in shoot stage with matching clients' }], ['show ruled out 200', { mode: 'smart', text: '3 BHK Anna Nagar 3 Cr', filters: { showRuledOut: true }, limit: 200 }]];
  for (const [l, b] of cases) { const a = await call(b); const c = await call(b); log(`${l}: ${a.ms} ms then ${c.ms} ms · ${a.total} rows · ${Math.round(a.bytes / 1024)} KB`); }
  log('waiting 65 s for the leads cache to expire…');
  await page.waitForTimeout(65000);
  for (const [l, b] of cases.slice(0, 3)) { const a = await call(b); log(`after idle — ${l}: ${a.ms} ms`); }
}
