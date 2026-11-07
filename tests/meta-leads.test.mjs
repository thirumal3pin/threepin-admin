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
eq('Ratings 1 to 5, as typed', ['5', '4 ', '3', '2', '1', '4/5', '3.5', 'hot', 'Warm', 'cold', '', 'abc', '7'].map(M.parseRating), [5, 4, 3, 2, 1, 4, 4, 5, 3, 1, null, null, null]);
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
  eq('A copied row is one enquiry', [p2.enquiries, p2.people.find(p => p.name === 'Sandeep').enquiries[0].alsoIn.length, p2.issues.some(i => /already read/.test(i.text))], [4, 1, true]);
}

// ── Analysis ──
{
  const a = M.analyse(plan, 'KDBMC001', NOW);
  eq('KDBMC001 analysis: totals', [a.enquiries, a.people, a.repeats, a.inCrm, a.contacted, a.assigned, a.problems], [11, 9, 2, 3, 7, 5, 2]);
  eq('By ad', a.byAd, [{ label: 'Video 1', n: 6 }, { label: 'Video 2', n: 5 }]);
  eq('By platform', a.byPlatform, [{ label: 'Instagram', n: 8 }, { label: 'Facebook', n: 3 }]);
  eq('Ratings 1–5 (latest per person)', a.ratings, { 1: 0, 2: 2, 3: 1, 4: 0, 5: 0, none: 6 });
  eq('Form answers tallied', a.questions.find(q => /area/.test(q.label)).answers[0], { label: '1,000–2,000 sq. ft.', n: 4 });
  eq('Series: one bar per day since the first enquiry, newest last', [a.series.length, a.series[a.series.length - 1].day, a.series.reduce((s, x) => s + x.n, 0)], [24, '2026-11-07', 11]);
  eq('Per tab, side by side', a.byTab.map(t => [t.sheetTitle.trim() + ' › ' + t.title, t.enquiries, t.people, t.duplicates, t.topAd]),
    [['office space - Kodambakkam › Sheet1', 5, 5, 2, 'Video 1'], ['office space - Kodambakkam › Sheet3', 4, 4, 1, 'Video 2'], ['Kodabakkam office › Sheet1', 2, 2, 1, 'Video 1']]);
  const one = M.analyse(plan, 'KDBMC001', NOW, 30, a.byTab[1].key);
  eq('One tab\'s own analysis', [one.enquiries, one.people, one.byAd], [4, 4, [{ label: 'Video 2', n: 3 }, { label: 'Video 1', n: 1 }]]);
  eq('Agents: who holds how many, contacted, untouched, rated 4–5, rated 3, rated at all', a.agents.map(x => [x.agent, x.people, x.contacted, x.untouched, x.top, x.mid, x.rated]),
    [['swami@threepin.in', 2, 2, 0, 0, 1, 2], ['thirumal@threepin.in', 2, 2, 0, 0, 0, 1], ['Ramesh', 1, 1, 0, 0, 0, 0], ['', 4, 2, 2, 0, 0, 0]]);
  eq('Ad quality: per ad, people, rated 4–5, rated 3+, contacted, average rating', a.adQuality.map(x => [x.ad, x.enquiries, x.people, x.top, x.threePlus, x.contacted, x.avg]), [['Video 1', 6, 5, 0, 0, 3, 2], ['Video 2', 5, 4, 0, 1, 4, 2.5]]);
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
  [r, s] = await act('agent@threepin.in', { action: 'available' });
  eq('Available sheets: managers only', s, 403);
  [r, s] = await act('admin@threepin.in', { action: 'available' });
  eq('Available sheets: every sheet shared with the app, the Meta ad lead ones marked', [s, r.files.map(f => [f.title.trim(), f.isMeta, f.mapped])],
    [200, [['office space - Kodambakkam', true, false], ['Kodabakkam office', true, false], ['Koyambedu - Leads', true, false], ['3PIN_Inventory_Master', false, false]]]);
  [r, s] = await act('admin@threepin.in', { action: 'save', sources: [...SOURCES, { spreadsheetId: 'not-a-sheet' }, { ...SOURCES[0] }] });
  eq('Save: bad and repeated sheets dropped, who and when kept', [s, r.sources.length, r.sources[0].addedBy, r.sources[2].propertyCode], [200, 3, 'admin@threepin.in', 'SHR0001']);
  eq('…a mapped sheet is marked mapped', (await act('admin@threepin.in', { action: 'available' }))[0].files.filter(f => f.mapped).length, 3);
  [r, s] = await act('agent@threepin.in', { action: 'read' });
  eq('Read (any team member): every tab of every sheet', [s, r.tabs.map(t => [t.sheetTitle, t.title, t.values.length - 1, t.propertyCode]), r.errors], [200,
    [['office space - Kodambakkam ', 'Sheet1', 5, 'KDBMC001'], ['office space - Kodambakkam ', 'Sheet3', 4, 'KDBMC001'], ['Kodabakkam office', 'Sheet1', 2, 'KDBMC001'], ['Koyambedu - Leads', 'Sheet1', 4, 'SHR0001']], []]);
  const cfg = (await db.collection('metaLeadConfigs').doc('t_3pin').get()).data();
  eq('Read: remembered for the monitor (who, when, rows per tab)', [cfg.lastRead.by, cfg.lastRead.at, cfg.lastRead.sheets.map(x => x.rows.map(y => y.rows))], ['agent@threepin.in', NOW, [[5, 4], [2], [4]]]);
  // Test mode writes nothing else: no lead, no note — only the setup doc and the taskConfigs seed.
  const paths = [...db._store.keys()].sort();
  eq('Test mode: nothing but the setup is written', paths, ['metaLeadConfigs/t_3pin', 'taskConfigs/t_3pin']);
  ok('Reads went to Google, not to cells being written', sheets.calls.every(c => !/:batchUpdate|:append|:clear/.test(c)));
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
{
  // Two tabs of one sheet for two properties; reading one sheet keeps the others' last read.
  const { db, act } = await server();
  await act('admin@threepin.in', { action: 'save', sources: [
    { spreadsheetId: SHEETS.KDB.id, title: SHEETS.KDB.title, propertyCode: '', tabs: [{ gid: 0, title: 'Sheet1', propertyCode: 'kdbmc001' }, { gid: 222, title: 'Sheet3', propertyCode: 'ANR005' }] },
    { spreadsheetId: SHEETS.KOY.id, title: SHEETS.KOY.title, tabs: [{ gid: 0, title: 'Sheet1', propertyCode: 'SHR0001' }] }] });
  let [r] = await act('admin@threepin.in', { action: 'read' });
  eq('Each tab read for its own property', r.tabs.map(t => [t.title, t.propertyCode]), [['Sheet1', 'KDBMC001'], ['Sheet3', 'ANR005'], ['Sheet1', 'SHR0001']]);
  await act('admin@threepin.in', { action: 'save', sources: [{ spreadsheetId: SHEETS.KOY.id, title: 'K', tabs: [{ gid: 0, title: 'Sheet1', propertyCode: 'SHR0001', tag: '  Creative test  ', remark: 'Budget 1-5 Cr form' }] }] });
  [r] = await act('admin@threepin.in', { action: 'read' });
  eq('A tab\'s tag and remark are kept and read back', [r.tabs[0].tag, r.tabs[0].remark], ['Creative test', 'Budget 1-5 Cr form']);
  await act('admin@threepin.in', { action: 'save', sources: [
    { spreadsheetId: SHEETS.KDB.id, title: SHEETS.KDB.title, propertyCode: '', tabs: [{ gid: 0, title: 'Sheet1', propertyCode: 'kdbmc001' }, { gid: 222, title: 'Sheet3', propertyCode: 'ANR005' }] },
    { spreadsheetId: SHEETS.KOY.id, title: SHEETS.KOY.title, tabs: [{ gid: 0, title: 'Sheet1', propertyCode: 'SHR0001' }] }] });
  [r] = await act('admin@threepin.in', { action: 'read' });
  [r] = await act('admin@threepin.in', { action: 'read', sourceId: SHEETS.KOY.id });
  eq('Read one sheet: only its tabs', r.tabs.map(t => t.sheetTitle), ['Koyambedu - Leads']);
  const lr = (await db.collection('metaLeadConfigs').doc('t_3pin').get()).data().lastRead;
  eq('…its last read updated, the other sheet\'s kept, in setup order', lr.sheets.map(x => x.id), [SHEETS.KDB.id, SHEETS.KOY.id]);
}
// ── The independent review's findings, pinned ──
{
  const V = SHEETS.KDB.tabs[1].values;   // Sheet3: answers M, N; Assigned to T; Rating U; Remarks V; a header-less note W
  const w = edits => M.planSheetWrite({ values: V, edits });
  eq('A form answer is never written', w([{ metaId: 'l:3001', col: 12, value: 'HACK' }]).errors, ['Column M (expected_area_(in_sq._ft.)) is a form answer and is not written']);
  eq('Nothing outside the columns read', [w([{ metaId: 'l:3001', col: 60, value: 'x' }]).errors.length, w([{ metaId: 'l:3001', col: -1, value: 'x' }]).errors.length, w([{ metaId: 'l:3001', col: 'abc', value: 'x' }]).errors.length], [1, 1, 1]);
  eq('A team column by index, with the header seen: written', w([{ metaId: 'l:3001', col: 21, header: 'Remarks', value: 'ok', from: 'Purpose: gym 50/sqft' }]).updates, [{ range: 'V2', value: 'ok' }]);
  eq('…a column inserted since the read (header now different): refused', w([{ metaId: 'l:3001', col: 21, header: 'Site visit', value: 'ok' }]).conflicts.map(c => c.reason), ['The sheet\'s columns changed since it was read']);
  eq('The header-less note column is the team\'s: writable', w([{ metaId: 'l:3002', col: 22, header: '', value: 'called', from: 'busy followup' }]).updates, [{ range: 'W3', value: 'called' }]);
  const gap = [['id', 'created_time', 'Follow up 1', 'Follow up 3'], ['l:1', '2026-11-01T10:00:00-05:00', 'a', 'b']];
  eq('A new follow-up never repeats a name already there', M.planSheetWrite({ values: gap, edits: [{ metaId: 'l:1', field: 'followup', next: true, value: 'c' }] }).added, [{ col: 4, header: 'Follow up 4' }]);
  eq('Agents: a full name or email, or a first name only one teammate has',
    [M.matchAgent('Raj M', ['raj.k@x.in', 'raj.m@x.in']), M.matchAgent('Raj', ['raj.k@x.in', 'raj.m@x.in']), M.matchAgent('raj.k@x.in', ['raj.k@x.in', 'raj.m@x.in']), M.matchAgent('Swami', ROSTER), M.matchAgent('rameez', ROSTER)],
    ['raj.m@x.in', null, 'raj.k@x.in', 'swami@threepin.in', 'rameez@threepin.in']);
  // A remark written only in a copied tab is contact; its rating counts too.
  const t1 = { spreadsheetId: 'S', sheetTitle: 'S', title: 'A', gid: 1, propertyCode: 'P', values: [['id', 'created_time', 'full_name', 'phone_number', 'Rating', 'Remarks'], ['l:9', '2026-11-01T10:00:00-05:00', 'Ann', 'p:+919800011111', '', '']] };
  const t2 = { ...t1, title: 'Copy of A', gid: 2, values: [t1.values[0], ['l:9', '2026-11-01T10:00:00-05:00', 'Ann', 'p:+919800011111', '3', 'Called, wants visit']] };
  const pc = M.buildPlan({ tabs: [t1, t2], crmLeads: [], roster: [] }).people[0];
  eq('Contact or rating written only in a copied tab counts', [pc.team.contacted, pc.team.rating], [true, 3]);
}
// Contacted = a conversation happened. Assigned only is not contact.
{
  const base = { team: { assigned: '', ratingRaw: '', remarks: [], followups: [], visit: '', notes: [] } };
  eq('Assigned only is not "contacted"; a remark, follow-up or rating is',
    [M.teamWrote({ team: { ...base.team, assigned: 'Swami' } }), M.teamWrote({ team: { ...base.team, remarks: [{ text: 'RNR' }] } }), M.teamWrote({ team: { ...base.team, ratingRaw: '2' } })], [false, true, true]);
}
// ── Writing back: which cell each edit lands in ──
{
  const V = SHEETS.KDB.tabs[0].values;   // Sheet1: Lead Rating (S), Remarks (T), Follow up 1 (U), Follow up 2 (V); no Assigned to
  const w = M.planSheetWrite({ values: V, edits: [
    { metaId: 'l:1003', field: 'assigned', value: 'Swami' },                                   // no column yet → added at W
    { metaId: 'l:1002', field: 'assigned', value: 'Thirumal' },                                // the same new column
    { metaId: 'l:1003', field: 'rating', value: '3', from: '3' },                              // unchanged → nothing written
    { metaId: 'l:1002', field: 'remarks', value: 'Wants 1000 sqft, ground floor', from: 'Looking near Anna Nagar, 60-70/sqft' },
    { metaId: 'l:1002', field: 'followup', next: true, value: 'Called, visiting Sat' },        // Follow up 1 empty → U
    { metaId: 'l:1003', field: 'followup', next: true, value: 'Visited, liked it' },           // both full → Follow up 3 at X
    { metaId: 'l:1001', field: 'remarks', value: 'x', from: 'something else' },                // changed in the sheet → conflict
    { metaId: 'l:9999', field: 'remarks', value: 'x' }                                         // not in the sheet
  ] });
  eq('New columns added at the end: Assigned to, Follow up 3', w.added, [{ col: 22, header: 'Assigned to' }, { col: 23, header: 'Follow up 3' }]);
  eq('Cells written, by Meta lead id', w.updates, [
    { range: 'W1', value: 'Assigned to' }, { range: 'W4', value: 'Swami' }, { range: 'W3', value: 'Thirumal' },
    { range: 'T3', value: 'Wants 1000 sqft, ground floor' }, { range: 'U3', value: 'Called, visiting Sat' },
    { range: 'X1', value: 'Follow up 3' }, { range: 'X4', value: 'Visited, liked it' }]);
  eq('Refused: a cell changed since it was read, and a lead no longer there', w.conflicts.map(c => [c.metaId, c.reason]), [['l:1001', 'Changed in the sheet since it was read'], ['l:9999', 'This lead is no longer in the sheet']]);
  // The sheet sorted differently: rows are found by id, not by position.
  const sorted = [V[0], ...V.slice(1).reverse()];
  {
    const H = ['id', 'created_time', 'full_name', 'Remarks', 'Follow up 1', 'Follow up 2'];
    const L = rows => M.planSheetWrite({ values: [H].concat(rows), edits: [{ metaId: 'l:1', field: 'log', value: 'new' }] });
    eq('Next note: Remarks empty → Remarks', L([['l:1', '', 'A', '', '', '']]).updates, [{ range: 'D2', value: 'new' }]);
    eq('Next note: Remarks written → Follow up 1', L([['l:1', '', 'A', 'r', '', '']]).updates, [{ range: 'E2', value: 'new' }]);
    eq('Next note: after the LAST written, not into a gap', L([['l:1', '', 'A', '', 'f1', '']]).updates, [{ range: 'F2', value: 'new' }]);
    const full = L([['l:1', '', 'A', 'r', 'f1', 'f2']]);
    eq('Next note: all full → a new "Follow up 3" column', [full.added, full.updates], [[{ col: 6, header: 'Follow up 3' }], [{ range: 'G1', value: 'Follow up 3' }, { range: 'G2', value: 'new' }]]);
    const two = M.planSheetWrite({ values: [H, ['l:1', '', 'A', 'r', '', '']], edits: [{ metaId: 'l:1', field: 'log', value: 'x' }, { metaId: 'l:1', field: 'log', value: 'y' }] });
    eq('Two notes in one save: one after the other', two.updates, [{ range: 'E2', value: 'x' }, { range: 'F2', value: 'y' }]);
    const bare = M.planSheetWrite({ values: [['id', 'full_name'], ['l:1', 'A']], edits: [{ metaId: 'l:1', field: 'log', value: 'z' }] });
    eq('Next note: no Remarks column yet → one is added', bare.added, [{ col: 2, header: 'Remarks' }]);
    eq('The note chain: Remarks, then follow-ups left to right', M.noteChain(M.classifyColumns(H, [])).map(c => c.header), ['Remarks', 'Follow up 1', 'Follow up 2']);
  }
  eq('A sorted sheet: still the right row', M.planSheetWrite({ values: sorted, edits: [{ metaId: 'l:1003', field: 'remarks', value: 'y' }] }).updates, [{ range: 'T4', value: 'y' }]);
  eq('Meta\'s own columns are never written', M.planSheetWrite({ values: V, edits: [{ metaId: 'l:1003', col: 14, value: '999' }] }).errors, ['Column O (phone_number) is Meta\'s own and is not written']);
  eq('A column added by name; a name already there refused', [M.planSheetWrite({ values: V, edits: [{ field: 'header', header: 'Budget (confirmed)' }] }).updates, M.planSheetWrite({ values: V, edits: [{ field: 'header', header: 'remarks' }] }).errors],
    [[{ range: 'W1', value: 'Budget (confirmed)' }], ['There is already a column "remarks"']]);
}
// ── The server writes it ──
{
  const { db, sheets, act } = await server();
  await act('admin@threepin.in', { action: 'save', sources: SOURCES });
  let [r, s] = await act('agent@threepin.in', { action: 'write', spreadsheetId: SHEETS.KDB.id, gid: 222, edits: [
    { metaId: 'l:3003', field: 'assigned', value: 'Thirumal', from: 'Ramesh' },
    { metaId: 'l:3003', field: 'followup', next: true, value: 'Call back Monday' }] });
  eq('Write (a team member): assigned changed, a follow-up column added to Sheet3', [s, r.applied.map(a => [a.row, a.header, a.value]), r.added], [200, [[4, 'Assigned to', 'Thirumal'], [4, 'Follow up 1', 'Call back Monday']], [{ col: 23, header: 'Follow up 1' }]]);
  const tab = sheets.data.KDB.tabs[1].values;
  eq('…and it is in the sheet', [tab[0][23], tab[3][19], tab[3][23]], ['Follow up 1', 'Thirumal', 'Call back Monday']);
  ok('…written with RAW values (a "=" stays text)', sheets.calls.some(c => /^POST .*values:batchUpdate/.test(c)));
  const log = [...db._store.entries()].filter(([k]) => k.startsWith('metaLeadEdits/')).map(([, v]) => v);
  eq('…and logged: who, which tab, what', [log.length, log[0].by, log[0].tab, log[0].applied.length], [1, 'agent@threepin.in', 'Sheet3', 2]);
  [r, s] = await act('agent@threepin.in', { action: 'write', spreadsheetId: SHEETS.KDB.id, gid: 222, edits: [{ field: 'header', header: 'Budget' }] });
  eq('Adding a column: managers only', s, 403);
  [r, s] = await act('admin@threepin.in', { action: 'write', spreadsheetId: SHEETS.KDB.id, gid: 222, edits: [{ field: 'header', header: 'Budget' }] });
  eq('A manager adds a column', [s, r.added], [200, [{ col: 24, header: 'Budget' }]]);
  [r, s] = await act('admin@threepin.in', { action: 'write', spreadsheetId: 'notconnected', gid: 0, edits: [{ metaId: 'x', field: 'remarks', value: 'x' }] });
  eq('A sheet not connected is never written', s, 404);
  [r, s] = await act('admin@threepin.in', { action: 'write', spreadsheetId: SHEETS.KDB.id, gid: 222, edits: [{ metaId: 'l:3003', field: 'assigned', value: 'Swami', from: 'Ramesh' }] });
  eq('Someone changed it meanwhile: refused, not overwritten', [r.applied.length, r.conflicts[0].now], [0, 'Thirumal']);
  // A tab switched off is not written; a lost edit log does not turn a written sheet into a failure.
  const cfgNow = (await db.collection('metaLeadConfigs').doc('t_3pin').get()).data();
  const off = JSON.parse(JSON.stringify(cfgNow.sources)); off[0].tabs[1].on = false;
  await act('admin@threepin.in', { action: 'save', sources: off });
  [r, s] = await act('admin@threepin.in', { action: 'write', spreadsheetId: SHEETS.KDB.id, gid: 222, edits: [{ metaId: 'l:3003', field: 'remarks', value: 'x' }] });
  eq('A tab switched off: not written', s, 409);
  await act('admin@threepin.in', { action: 'save', sources: cfgNow.sources });
  const realAdd = db.collection('metaLeadEdits').add;
  const brokenDb = { ...db, collection: n => n === 'metaLeadEdits' ? { add: async () => { throw new Error('RESOURCE_EXHAUSTED'); } } : db.collection(n) };
  const [r2, s2] = await metaLeadsAction({ tenantId: 't_3pin', email: 'admin@threepin.in' }, { action: 'write', spreadsheetId: SHEETS.KDB.id, gid: 222, edits: [{ metaId: 'l:3004', field: 'remarks', value: 'Called' }] },
    { db: brokenDb, fetch: sheets.fetch, serviceAccount: { client_email: 'sa@x' }, token: async () => 'tok', now: () => NOW });
  eq('The edit log failing: the sheet was written and the answer says so', [s2, r2.applied.length, sheets.data.KDB.tabs[1].values[4][21]], [200, 1, 'Called']);
}
// ── The AI brief: what the agent needs before the call ──
{
  const B = await import('../api/_meta-leads-brief.js');
  const db = createFakeDb();
  const calls = [];
  let reply = { ok: true, model: 'gemini-test', verdict: { intent: 'rent', stage: 'visit_pending', confidence: 'high', evidence: 'Remarks: probably visit on Monday', next: { owner: 'team', action: 'Call to confirm the Monday visit to KDBMC001', kind: 'confirm_visit', dueAt: NOW + 86400000 }, visit: { status: 'requested', at: null, property: 'KDBMC001' }, holdReason: null, holdUntil: null, lostReason: null, urgency: 'normal', line: 'Visit likely Monday; confirm', want: null } };
  const classify = async o => { calls.push(o.caseFile); return reply; };
  const deps = { db, fetch: async () => { throw new Error('no sheets here'); }, serviceAccount: null, token: async () => 'x', now: () => NOW, classify };
  const act = body => metaLeadsAction({ tenantId: 't_3pin', email: 'agent@threepin.in' }, body, deps);
  const person = {
    k: 'p:919884184215', sig: 's1', name: 'Murenu Murugan', crmId: '',
    props: [{ code: 'KDBMC001', name: 'Commercial Building for Rent' }],
    rows: [
      { at: NOW - 15 * 86400000, code: 'KDBMC001', where: 'office space - Kodambakkam › Sheet1', tag: 'old leads', ad: 'Video 2', platform: 'Instagram', form: 'Office space-copy', answers: [['Expected area (in sq. ft.)', '1,000–2,000 sq. ft.'], ['Expected budget per sq. ft.', '₹70–₹100']], assigned: 'Thirumal', rating: '3', notes: [['Remarks', 'Interested, send details']] },
      { at: NOW - 4 * 86400000, code: 'KDBMC001', where: 'Kodabakkam office › Sheet1', ad: 'Video 1', form: 'T nagar', answers: [['Expected area', '4,000+ sq. ft.']], assigned: 'Thirumal', rating: '3', notes: [['Remarks', 'sent details - probably visit on monday - call back on monday on Nov9, his no 98841 84215']] }
    ]
  };
  let [r, s] = await act({ action: 'brief', person });
  eq('Brief: read by the lead AI and stored', [s, r.ok, calls.length, r.brief.v.stage, r.brief.v.next.action, r.brief.src], [200, true, 1, 'visit_pending', 'Call to confirm the Monday visit to KDBMC001', { rows: 2, notes: 2, crm: false, crmNotes: 0, chat: 0 }]);
  const cf = calls[0];
  ok('The case file: how to read undated sheet notes and dates written in them', /written left to right, oldest first/.test(cf) && /day\/month, this year/.test(cf));
  ok('…every enquiry with its form answers, oldest first', cf.indexOf('1,000–2,000 sq. ft.') < cf.indexOf('4,000+ sq. ft.') && /Form answers: Expected area \(in sq\. ft\.\): 1,000–2,000 sq\. ft\.; Expected budget per sq\. ft\.: ₹70–₹100/.test(cf));
  ok('…the team\'s notes and rating in each row', /Remarks: sent details - probably visit on monday/.test(cf) && /rating 3\/5/.test(cf) && /assigned to Thirumal/.test(cf));
  ok('…a phone number written in a note never leaves the CRM', !/98841 84215/.test(cf) && /\[phone\]/.test(cf));
  ok('…not a CRM lead: said so', /CRM: not a CRM lead yet/.test(cf));
  [r] = await act({ action: 'brief', person: { ...person, sig: 's2' } });
  eq('Asked again with nothing new: the stored answer, no AI call', [r.cached, calls.length, r.brief.sig], [true, 1, 's2']);
  const more = JSON.parse(JSON.stringify(person)); more.rows[1].notes.push(['Follow up 1', 'Visited, wants 2 floors (9 Nov)']);
  [r] = await act({ action: 'brief', person: more });
  eq('A new note: read again', calls.length, 2);
  reply = { ok: false, error: 'rate limited' };
  more.rows[1].notes.push(['Follow up 2', 'RNR']);
  [r] = await act({ action: 'brief', person: more });
  eq('The AI failing: the error is kept, and so is the last good brief', [r.ok, r.brief.err, r.brief.v.stage], [false, 'rate limited', 'visit_pending']);
  [r] = await act({ action: 'briefs' });
  eq('briefs: every stored brief by person', [Object.keys(r.briefs), r.briefs['p:919884184215'].err], [['p:919884184215'], 'rate limited']);
  // Already a CRM lead: its record, notes and chat are read too — another tenant's lead never.
  reply = { ok: true, model: 'gemini-test', verdict: { ...reply, intent: 'rent', stage: 'lost', confidence: 'high', evidence: 'x', next: { owner: 'none', action: null, kind: 'none', dueAt: null }, visit: { status: 'none', at: null, property: null }, holdReason: null, holdUntil: null, lostReason: 'not_interested', urgency: 'low', line: 'Took another place', want: null } };
  await db.collection('leads').doc('L1').set({ tenantId: 't_3pin', name: 'Murenu M', stageId: 'contacted', phone: '9884184215' });
  await db.collection('leads').doc('L1').collection('notes').doc('n1').set({ text: 'Said he took a place in T Nagar', createdAt: NOW - 3600000, by: 'swami@threepin.in' });
  await db.collection('leads').doc('L1').collection('tailortalk').doc('state').set({ chat: [{ role: 'user', content: 'Not needed now, thanks', at: NOW - 7200000 }] });
  await db.collection('pipelines').doc('t_3pin').set({ stages: STAGES });
  await db.collection('leads').doc('X9').set({ tenantId: 'someone_else', name: 'Other' });
  [r] = await act({ action: 'brief', person: { ...more, crmId: 'L1' } });
  const cf2 = calls[calls.length - 1];
  ok('A CRM lead: its notes and chat are in the case file', /CRM RECORD/.test(cf2) && /took a place in T Nagar/.test(cf2) && /Not needed now, thanks/.test(cf2) && !/\nNow: .*\n[\s\S]*\nNow: /.test(cf2));
  eq('…and counted', [r.brief.src.crm, r.brief.src.crmNotes, r.brief.src.chat, r.brief.v.lostReason], [true, 1, 1, 'not_interested']);
  [r] = await act({ action: 'brief', person: { ...more, k: 'p:910000000000', crmId: 'X9' } });
  ok('Another tenant\'s CRM lead is never read', !/CRM RECORD/.test(calls[calls.length - 1]) && r.brief.src.crm === false);
  [r, s] = await act({ action: 'brief', person: { k: 'x', rows: [] } });
  eq('Nothing to read: refused', s, 400);
  eq('Briefs run on Claude Haiku 4.5, the CRM\'s Claude', B.BRIEF_MODEL, 'claude-haiku-4-5');
  // The day's cap: past it, nothing is read and the page is told so.
  await db.collection('metaLeadBriefs').doc('t_3pin').set({ day: new Date(NOW + 5.5 * 3600000).toISOString().slice(0, 10), runs: B.BRIEF_DAILY_CAP }, { merge: true });
  const before = calls.length;
  const capped = JSON.parse(JSON.stringify(more)); capped.rows[0].notes.push(['Follow up 1', 'one more']);
  [r] = await act({ action: 'brief', person: capped });
  eq('The daily cap reached: no AI call, and the page is told', [calls.length - before, r.ok, r.capped], [0, false, true]);
}
eq('cleanSources keeps only known roles', cleanSources([{ spreadsheetId: SHEETS.KOY.id, tabs: [{ gid: 0, overrides: { 18: 'rating', 19: 'meta', x: 'note', 20: 'bogus' } }] }], [], 'a', 1)[0].tabs[0].overrides, { 18: 'rating' });

console.log(failed ? `\n${failed} of ${checks} failed` : `\nAll good (${checks} checks).`);
process.exit(failed ? 1 : 0);
