// Meta ads leads: reading the sheets, the plan a sync would follow, the analysis, and the server's
// setup and read — over stand-in sheets laid out like the real ones.   node tests/meta-leads.test.mjs
import * as M from '../crm-assets/metaLeadsModel.js';
import { metaLeadsAction, cleanSources } from '../api/_meta-leads.js';
import { createFakeDb } from './_fake-firestore.mjs';
import { SHEETS, SOURCES, ROSTER, STAGES, CRM_LEADS, NOW, fakeSheetsFetch } from './_meta-leads-fixtures.mjs';

let failed = 0, checks = 0;
const eq = (l, a, b) => { checks++; if (JSON.stringify(a) !== JSON.stringify(b)) { failed++; console.log(`  FAIL  ${l}\n        got      ${JSON.stringify(a)}\n        expected ${JSON.stringify(b)}`); } };
const ok = (l, c) => eq(l, !!c, true);

console.log('3 PIN Realty — Meta ads leads');

// ── Links and values ──
eq('Sheet link with gid', M.parseSheetLink('https://docs.google.com/spreadsheets/d/17kaZCqDhOszTBwBkj8qEGHHsy7E1TBRjAYAWOO2aMk0/edit?gid=0#gid=0'), { spreadsheetId: '17kaZCqDhOszTBwBkj8qEGHHsy7E1TBRjAYAWOO2aMk0', gid: 0 });
eq('Not a sheet link', M.parseSheetLink('https://drive.google.com/drive/folders/abc'), null);
eq('Meta phone p:+91…', M.phoneKey('p:+919585509459'), '919585509459');
eq('Meta phone with no country code', M.phoneKey('p:9787866502'), '919787866502');
eq('A mistyped 13-digit number is kept but not valid', [M.phoneKey('p:+9189573526441'), M.isValidMobile(M.phoneKey('p:+9189573526441'))], ['9189573526441', false]);
eq('Display phone', M.displayPhone('p:+919585509459'), '+91 95855 09459');
eq('Meta time is read in its own offset', M.fmtWhen(M.parseTime('2026-10-15T01:37:51-05:00')), '15 Oct 2026, 12:07 pm');
eq('A typed day-first date', M.dayKey(M.parseTime('27-8-2026')), '2026-08-27');
eq('Ratings as typed', ['3', '2 ', '1', 'hot', 'Warm', 'cold', '', 'abc'].map(M.parseRating), [3, 2, 1, 3, 2, 1, null, null]);
eq('Agent from a first name', [M.matchAgent('Swami', ROSTER), M.matchAgent('Thirumal ', ROSTER), M.matchAgent('Ramesh', ROSTER), M.matchAgent('', ROSTER)], ['swami@threepin.in', 'thirumal@threepin.in', null, null]);

// ── Columns ──
{
  const roles = h => M.classifyColumns(h, []).map(c => c.role);
  const kdb1 = M.classifyColumns(SHEETS.KDB.tabs[0].values[0], SHEETS.KDB.tabs[0].values.slice(1));
  eq('KDBMC Sheet1: team columns found', kdb1.filter(c => c.role !== 'meta').map(c => [c.header, c.role]),
    [['', 'ignore'], ['Lead Rating', 'rating'], ['Remarks', 'remarks'], ['Follow up 1', 'followup'], ['Follow up 2', 'followup']]);
  const kdb3 = M.classifyColumns(SHEETS.KDB.tabs[1].values[0], SHEETS.KDB.tabs[1].values.slice(1));
  eq('KDBMC Sheet3: form answers, team columns, and the column with no header', kdb3.filter(c => c.role !== 'meta').map(c => [c.label, c.role]),
    [['Expected area (in sq. ft.)', 'answer'], ['Expected budget per sq. ft.', 'answer'], ['Assigned to', 'assigned'], ['Rating', 'rating'], ['Remarks', 'remarks'], ['Column W (no header)', 'note']]);
  eq('Header spellings the team uses', roles(['Notes ', 'Follow Up -1 ', 'Follow up 2', 'Visit sheduled date', 'Site visit shceduled date', 'lead rating ', 'Assigned to ']),
    ['remarks', 'followup', 'followup', 'visit', 'visit', 'rating', 'assigned']);
  eq('Koyambedu: questions are answers', M.classifyColumns(SHEETS.KOY.tabs[0].values[0], []).filter(c => c.role === 'answer').map(c => c.label),
    ['What is your budget?', 'How soon are you planning to buy?']);
  const ov = M.classifyColumns(SHEETS.KDB.tabs[1].values[0], SHEETS.KDB.tabs[1].values.slice(1), { 22: 'followup', 0: 'ignore', 13: 'remarks' });
  eq('A person can name a column; Meta\'s own can only be switched off', [ov[22].role, ov[0].role, ov[13].role], ['followup', 'ignore', 'answer'.replace('answer', 'remarks')]);
  eq('Issues: no header', M.columnIssues(kdb3), ['1 column holds data with no header (W) — read as notes until named']);
}

// ── A tab ──
{
  const r = M.readTab({ spreadsheetId: SHEETS.KOY.id, sheetTitle: SHEETS.KOY.title, title: 'Sheet1', gid: 0, propertyCode: 'SHR0001', values: SHEETS.KOY.tabs[0].values });
  eq('Koyambedu: four enquiries', r.enquiries.length, 4);
  const e = r.enquiries[0];
  eq('An enquiry: who, when, from which ad, what they answered, what the team wrote',
    [e.metaId, e.name, e.phone, e.phoneOk, e.ad, e.campaign, e.form, e.platform, e.answers, e.team.rating, e.team.notes.map(n => n.text), e.row, e.propertyCode],
    ['l:7001', 'Sandeep', '+9189573500010', false, 'Creative 3', 'Koyambedu | lead', 'Koyambedu leads', 'ig',
      [{ label: 'What is your budget?', value: '3 cr to 5 cr' }, { label: 'How soon are you planning to buy?', value: '1 - 3 months' }], 1, ['not interested, Hindi person'], 2, 'SHR0001']);
}

// ── The plan ──
const tabsFor = (sources) => sources.flatMap(s => {
  const sh = Object.values(SHEETS).find(x => x.id === s.spreadsheetId);
  return s.tabs.map(t => ({ sourceId: s.spreadsheetId, spreadsheetId: s.spreadsheetId, sheetTitle: sh.title, title: t.title, gid: t.gid, propertyCode: s.propertyCode, values: sh.tabs.find(x => x.gid === t.gid).values }));
});
const plan = M.buildPlan({ tabs: tabsFor(SOURCES), crmLeads: CRM_LEADS, roster: ROSTER, properties: { KDBMC001: 'Commercial Building for Rent', SHR0001: 'Shriram Codename King Life' }, stages: STAGES });
{
  eq('Every row read once: 5 + 4 + 2 + 4', plan.enquiries, 15);
  const P = c => plan.properties.find(p => p.code === c);
  eq('KDBMC001: enquiries, people, repeats, in CRM, would create, would add the property',
    [P('KDBMC001').enquiries, P('KDBMC001').people, P('KDBMC001').repeats, P('KDBMC001').inCrm, P('KDBMC001').create, P('KDBMC001').attach], [11, 9, 2, 3, 6, 1]);
  eq('SHR0001 (Koyambedu sheet)', [P('SHR0001').enquiries, P('SHR0001').people, P('SHR0001').alsoOther], [4, 4, 1]);
  const arjun = plan.people.find(p => p.name === 'Arjun');
  eq('Arjun: one person, three enquiries over two properties, each with its date and time',
    [arjun.enquiries.length, arjun.properties, arjun.enquiries.map(e => [M.fmtWhen(e.at), e.where.sheetTitle.trim() + ' › ' + e.where.tab, e.ad])],
    [3, ['KDBMC001', 'SHR0001'], [['15 Oct 2026, 2:00 pm', 'office space - Kodambakkam › Sheet1', 'Video 2'], ['20 Oct 2026, 2:56 pm', 'office space - Kodambakkam › Sheet3', 'Video 2'], ['7 Nov 2026, 3:59 am', 'Koyambedu - Leads › Sheet1', 'Creative 1']]]);
  eq('Arjun: latest assignee and rating, every note with where it was written',
    [arjun.team.agent, arjun.team.rating, arjun.team.notes.map(n => n.text)],
    ['swami@threepin.in', 3, ['Sent exact location — gym, 2.5 km from branch', 'Visiting today 12PM (16/10)', 'callback wednesday ( 24/10)', 'Purpose: gym 50/sqft']]);
  const queen = plan.people.find(p => p.phoneKey === '917010300002');
  eq('Queen Salon: the same person through two KDBMC001 sheets three weeks apart', [queen.enquiries.length, queen.properties, queen.name, queen.team.agent], [2, ['KDBMC001'], 'Queen', 'thirumal@threepin.in']);
  const sara = plan.people.find(p => p.phoneKey === '919042700008');
  eq('Saravana: already in the CRM for another property → the property would be added, with his CRM summary',
    [sara.action, sara.missingCodes, sara.crm.id, sara.crm.stage, sara.crm.agent, /fitness studio/.test(sara.crm.summary)], ['attach', ['KDBMC001'], 'C1', 'Site Visit', 'swami@threepin.in', true]);
  const prakash = plan.people.find(p => p.phoneKey === '919952000009');
  eq('Prakash: in the CRM with KDBMC001 already → nothing to add', [prakash.action, prakash.crm.summary], ['linked', 'Called twice, wants a weekend visit']);
  eq('Problems: no phone, a wrong number, a name not on the team',
    plan.people.filter(p => p.issues.length).map(p => [p.name, p.issues]).sort(),
    [['Mari Vel', ['"Ramesh" is not on the team list']], ['Sandeep', ['Phone looks wrong (+9189573500010)']], ['Vijaya Rani', ['No phone number']]]);
  // The agreed outcomes (7 Nov 2026).
  const who = n => plan.people.find(p => p.name === n);
  eq('Parinita: CRM lead for KDBMC001 since 10 Oct, new ad row on 20 Oct → revisited, priority for the agent',
    [who('Parinita').action, who('Parinita').revisited, who('Parinita').priority, who('Parinita').newRows], ['revisit', true, true, 1]);
  eq('Aswin: Lost in the CRM, enquired again on 6 Nov → reopen, duplicate, priority',
    [who('Aswin Ramesh').action, who('Aswin Ramesh').crm.closed, who('Aswin Ramesh').crm.stage, who('Aswin Ramesh').revisited, who('Aswin Ramesh').priority], ['reopen', true, 'Lost', true, true]);
  eq('Prakash: his CRM lead was made from this same row (row older than the lead) → nothing new, not priority',
    [who('Prakash').action, who('Prakash').priority, who('Prakash').newRows], ['linked', false, 0]);
  eq('Arjun: new lead, but two rows for KDBMC001 → revisited, priority', [who('Arjun').action, who('Arjun').revisited, who('Arjun').priority], ['create', true, true]);
  eq('Murugan: new lead, one row → not priority', [who('Murugan').action, who('Murugan').priority], ['create', false]);
  eq('Saravana: in the CRM, another property → attach, not a revisit', [who('Saravana').action, who('Saravana').revisited], ['attach', false]);
  eq('Arjun is priority for KDBMC001 (two rows there), not for SHR0001 (one first enquiry)', [M.isPriorityFor(who('Arjun'), 'KDBMC001'), M.isPriorityFor(who('Arjun'), 'SHR0001'), who('Arjun').revisitCodes], [true, false, ['KDBMC001']]);
  eq('SHR0001 priority: only Aswin (reopen)', P('SHR0001').priority, 1);
  eq('Priority and reopen counts', [M.analyse(plan, '', NOW).priority, M.analyse(plan, '', NOW).reopen, P('KDBMC001').priority, P('SHR0001').reopen], [4, 1, 3, 1]);
  const pari = plan.people.find(p => p.name === 'Parinita');
  eq('The column with no header is kept as a note, not lost', pari.team.notes.map(n => [n.label, n.text]), [['Remarks', 'Busy, Follow up'], ['Column W (no header)', 'busy followup']]);
  const dups = M.duplicatesOf(plan, 'KDBMC001');
  eq('Duplicates for KDBMC001: Arjun and Queen, newest first', dups.map(d => [d.name, d.rows.length]), [['Queen', 2], ['Arjun', 2]]);
  eq('Across all properties: still only same-property repeats — Arjun\'s Koyambedu enquiry is not a duplicate',
    M.duplicatesOf(plan).map(d => [d.name, d.code, d.rows.length, d.otherCodes]), [['Queen', 'KDBMC001', 2, []], ['Arjun', 'KDBMC001', 2, ['SHR0001']]]);
  eq('Arjun: a duplicate for KDBMC001 only, and enquired for two properties', [arjun.dupCodes, arjun.duplicate, arjun.multiProperty], [['KDBMC001'], true, true]);
  eq('Murugan: one row, one property — neither', [plan.people.find(p => p.name === 'Murugan').duplicate, plan.people.find(p => p.name === 'Murugan').multiProperty], [false, false]);
  eq('SHR0001 has no duplicates (Arjun\'s one Koyambedu row is a new enquiry there)', [M.duplicatesOf(plan, 'SHR0001').length, M.analyse(plan, 'SHR0001', NOW).repeats], [0, 0]);
  eq('All properties: 2 people with duplicates, 1 enquiring for two properties', [M.analyse(plan, '', NOW).repeats, M.analyse(plan, '', NOW).multiProperty], [2, 1]);
}
// A copied tab (as "Copy of Updated form" is) repeats a lead: it is counted once, the copy noted.
{
  const copy = { ...tabsFor([SOURCES[2]])[0], title: 'Copy of Sheet1', gid: 9, values: SHEETS.KOY.tabs[0].values.slice(0, 2) };
  const p2 = M.buildPlan({ tabs: [...tabsFor([SOURCES[2]]), copy], crmLeads: [], roster: ROSTER });
  eq('A copied row is one enquiry', [p2.enquiries, p2.people.find(p => p.name === 'Sandeep').enquiries[0].alsoIn.length, p2.issues.some(i => /a copy of a lead/.test(i.text))], [4, 1, true]);
}

// ── Analysis ──
{
  const a = M.analyse(plan, 'KDBMC001', NOW);
  eq('KDBMC001 analysis: totals', [a.enquiries, a.people, a.repeats, a.inCrm, a.contacted, a.assigned, a.problems], [11, 9, 2, 3, 7, 5, 2]);
  eq('By ad', a.byAd, [{ label: 'Video 1', n: 6 }, { label: 'Video 2', n: 5 }]);
  eq('By platform', a.byPlatform, [{ label: 'Instagram', n: 8 }, { label: 'Facebook', n: 3 }]);
  eq('Ratings (latest per person)', a.ratings, { 3: 1, 2: 2, 1: 0, none: 6 });
  eq('Form answers tallied', a.questions.find(q => /area/.test(q.label)).answers[0], { label: '1,000–2,000 sq. ft.', n: 4 });
  eq('Series: one bar per day since the first enquiry, newest last', [a.series.length, a.series[a.series.length - 1].day, a.series.reduce((s, x) => s + x.n, 0)], [24, '2026-11-07', 11]);
  eq('By agent', a.byAgent, [{ label: 'Not assigned', n: 4 }, { label: 'swami@threepin.in', n: 2 }, { label: 'thirumal@threepin.in', n: 2 }, { label: 'Ramesh', n: 1 }]);
}

// ── The server ──
const managers = { managers: ['admin@threepin.in'] };
async function server(locked) {
  const db = createFakeDb();
  await db.collection('taskConfigs').doc('t_3pin').set(managers);
  const sheets = fakeSheetsFetch(locked);
  const deps = { db, fetch: sheets.fetch, serviceAccount: { client_email: 'firebase-adminsdk-fbsvc@pin-realty.iam.gserviceaccount.com' }, token: async () => 'tok', now: () => NOW };
  const act = (email, body) => metaLeadsAction({ tenantId: 't_3pin', email }, body, deps);
  return { db, sheets, act };
}
{
  const { db, sheets, act } = await server();
  let [r, s] = await act('admin@threepin.in', { action: 'config' });
  eq('Config: empty, a manager, test mode, the address to share with', [s, r.sources, r.manager, r.mode, r.shareWith], [200, [], true, 'test', 'firebase-adminsdk-fbsvc@pin-realty.iam.gserviceaccount.com']);
  [r, s] = await act('agent@threepin.in', { action: 'inspect', link: SHEETS.KDB.id });
  eq('Inspect: managers only', [s, r.ok], [403, false]);
  [r, s] = await act('admin@threepin.in', { action: 'inspect', link: `https://docs.google.com/spreadsheets/d/${SHEETS.KDB.id}/edit#gid=222` });
  eq('Inspect: title, tabs, counts, Meta or not', [s, r.title, r.gid, r.tabs.map(t => [t.title, t.count, t.looksMeta])], [200, 'office space - Kodambakkam ', 222, [['Sheet1', 5, true], ['Sheet3', 4, true]]]);
  eq('Inspect: Sheet3\'s columns and issue', [r.tabs[1].cols.find(c => c.index === 22).role, r.tabs[1].issues.length], ['note', 1]);
  [r, s] = await act('admin@threepin.in', { action: 'save', sources: [...SOURCES, { spreadsheetId: 'not-a-sheet' }, { ...SOURCES[0] }] });
  eq('Save: bad and repeated sheets dropped, who and when kept', [s, r.sources.length, r.sources[0].addedBy, r.sources[2].propertyCode], [200, 3, 'admin@threepin.in', 'SHR0001']);
  [r, s] = await act('agent@threepin.in', { action: 'read' });
  eq('Read (any team member): every tab of every sheet', [s, r.tabs.map(t => [t.sheetTitle, t.title, t.values.length - 1, t.propertyCode]), r.errors], [200,
    [['office space - Kodambakkam ', 'Sheet1', 5, 'KDBMC001'], ['office space - Kodambakkam ', 'Sheet3', 4, 'KDBMC001'], ['Kodabakkam office', 'Sheet1', 2, 'KDBMC001'], ['Koyambedu - Leads', 'Sheet1', 4, 'SHR0001']], []]);
  const cfg = (await db.collection('metaLeadConfigs').doc('t_3pin').get()).data();
  eq('Read: remembered for the monitor (who, when, rows per tab)', [cfg.lastRead.by, cfg.lastRead.at, cfg.lastRead.sheets.map(x => x.rows.map(y => y.rows))], ['agent@threepin.in', NOW, [[5, 4], [2], [4]]]);
  // Test mode writes nothing else: no lead, no note — only the setup doc and the taskConfigs seed.
  const paths = [...db._store.keys()].sort();
  eq('Test mode: nothing but the setup is written', paths, ['metaLeadConfigs/t_3pin', 'taskConfigs/t_3pin']);
  ok('Reads went to Google, not to cells being written', sheets.calls.every(c => !/:batchUpdate|:append|values\//.test(c) || /values:batchGet/.test(c)));
}
{
  const { act } = await server(new Set([SHEETS.KOY.id]));
  await act('admin@threepin.in', { action: 'save', sources: SOURCES });
  const [r] = await act('admin@threepin.in', { action: 'read' });
  eq('A sheet not shared: the others still read, and it says who to share with', [r.tabs.length, r.errors.map(e => [e.title, e.code])], [3, [['Koyambedu - Leads', 'share']]]);
  ok('…naming the service account', /firebase-adminsdk-fbsvc@pin-realty\.iam\.gserviceaccount\.com/.test(r.errors[0].error));
  const [i, s] = await act('admin@threepin.in', { action: 'inspect', link: SHEETS.KOY.id });
  eq('Inspect a sheet not shared', [s, i.code], [403, 'share']);
}
eq('cleanSources keeps only known roles', cleanSources([{ spreadsheetId: SHEETS.KOY.id, tabs: [{ gid: 0, overrides: { 18: 'rating', 19: 'meta', x: 'note', 20: 'bogus' } }] }], [], 'a', 1)[0].tabs[0].overrides, { 18: 'rating' });

console.log(failed ? `\n${failed} of ${checks} failed` : `\nAll good (${checks} checks).`);
process.exit(failed ? 1 : 0);
