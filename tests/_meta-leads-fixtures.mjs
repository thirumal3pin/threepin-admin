// Stand-in Meta lead sheets, laid out exactly like the real ones (headers copied from them) but
// with made-up people. Used by tests/meta-leads.test.mjs and tests/meta-leads-preview.mjs.
//   KDBMC  "office space - Kodambakkam"  Sheet1 (Lead Rating, Remarks, Follow up 1/2)
//                                        Sheet3 (Assigned to, Rating, Remarks + a column with no header)
//   KDBMC  "Kodabakkam office"           Sheet1 (Assigned to, Lead rating, Remarks)
//   SHR    "Koyambedu - Leads"           Sheet1 (lead rating + remarks under no header)

export const NOW = Date.parse('2026-11-07T12:00:00+05:30');
const t = (iso) => iso; // Meta's own format, e.g. 2026-10-15T01:37:51-05:00

const H1 = ['id', 'created_time', 'ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name', 'form_id', 'form_name', 'is_organic', 'platform', 'email', 'full_name', 'phone_number', '', 'inbox_url', 'lead_status', 'Lead Rating', 'Remarks', 'Follow up 1 ', 'Follow up 2 '];
const H3 = ['id', 'created_time', 'ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name', 'form_id', 'form_name', 'is_organic', 'platform', 'expected_area_(in_sq._ft.)', 'expected_budget_per_sq._ft.', 'email', 'full_name', 'phone_number', 'inbox_url', 'lead_status', 'Assigned to ', 'Rating', 'Remarks'];
const HK = ['id', 'created_time', 'ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name', 'form_id', 'form_name', 'is_organic', 'platform', 'expected_area_(in_sq._ft.)', 'expected_budget_per_sq._ft.', 'email', 'full_name', 'phone_number', 'lead_status', 'Assigned to ', 'Lead rating ', 'Remarks '];
const HY = ['id', 'created_time', 'ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name', 'form_id', 'form_name', 'is_organic', 'platform', 'what_is_your_budget?', 'how_soon_are_you_planning_to_buy?', 'email', 'full_name', 'phone_number', 'lead_status', 'lead rating '];

const ad = (v) => ['ag:1201', v, 'as:1202', 'New Leads ad set', 'c:1203'];
const r1 = (id, at, video, plat, email, name, phone, rating, remarks, f1, f2) =>
  [id, t(at), ...ad(video), 'Office space rent', 'f:1099', 'Office space-copy', 'false', plat, email, name, phone, '', '', 'CREATED', rating, remarks, f1, f2];
const r3 = (id, at, video, area, budget, email, name, phone, who, rating, remarks, extra) =>
  [id, t(at), ...ad(video), 'Office space rent', 'f:2236', 'Office space-copy-copy', 'false', 'ig', area, budget, email, name, phone, '', 'CREATED', who, rating, remarks, ...(extra ? [extra] : [])];
const rk = (id, at, area, budget, email, name, phone, who, rating, remarks) =>
  [id, t(at), ...ad('Video 1'), 'Office space rent - new page', 'f:1494', 'T nagar', 'false', 'fb', area, budget, email, name, phone, 'CREATED', who, rating, remarks];
const ry = (id, at, creative, budget, soon, email, name, phone, rating, remark) =>
  [id, t(at), ...ad(creative), 'Koyambedu | lead', 'f:1648', 'Koyambedu leads', 'false', 'ig', budget, soon, email, name, phone, 'CREATED', rating, remark];

export const SHEETS = {
  KDB: {
    id: '1KDBofficeSpaceKodambakkamAAAAAAAAAAAAAAAA', title: 'office space - Kodambakkam ',
    tabs: [
      { gid: 0, title: 'Sheet1', values: [H1,
        r1('l:1001', '2026-10-15T01:37:51-05:00', 'Video 1', 'ig', 'lp@example.com', 'Dr. Lakshmi Prasad', 'p:+919585500001', '', 'Interested, sent details on WhatsApp', 'busy follow up', 'busy follow up'),
        r1('l:1002', '2026-10-15T03:13:16-05:00', 'Video 1', 'ig', 'q@example.com', 'Queen Salon', 'p:+917010300002', '', 'Looking near Anna Nagar, 60-70/sqft', '', ''),
        r1('l:1003', '2026-10-15T03:30:02-05:00', 'Video 2', 'ig', 'arjun@example.com', 'Arjun', 'p:+919003000003', '3', 'Sent exact location — gym, 2.5 km from branch', 'Visiting today 12PM (16/10)', 'callback wednesday ( 24/10)'),
        r1('l:1004', '2026-10-15T04:20:45-05:00', 'Video 2', 'ig', 'vr@example.com', 'Vijaya Rani', '', '', 'looking for gym 4000sqft', 'not answering', ''),
        r1('l:1005', '2026-10-16T09:00:00-05:00', 'Video 1', 'fb', 'nobody@example.com', 'Fresh Lead', 'p:+919800000005', '', '', '', '')
      ] },
      { gid: 222, title: 'Sheet3', values: [H3,
        // Arjun again, five days later, from the new form: a repeat enquiry for KDBMC001.
        r3('l:3001', '2026-10-20T04:26:10-05:00', 'Video 2', '4,000+_sq._ft.', '₹70–₹100', 'arjun@example.com', 'Arjun', 'p:+919003000003', 'Swami', '3', 'Purpose: gym 50/sqft'),
        r3('l:3002', '2026-10-20T04:29:21-05:00', 'Video 2', '1,000–2,000_sq._ft.', '₹100–₹150', 'pari@example.com', 'Parinita', 'p:+916369400006', 'Swami', '2', 'Busy, Follow up', 'busy followup'),
        r3('l:3003', '2026-10-20T09:09:40-05:00', 'Video 2', '1,000–2,000_sq._ft.', '₹70–₹100', 'mv@example.com', 'Mari Vel', 'p:+919840700007', 'Ramesh', '', 'Follow up in 30 mins'),
        // Already in the CRM (lead C1), for another property.
        r3('l:3004', '2026-10-21T10:18:06-05:00', 'Video 1', '1,000–2,000_sq._ft.', '₹70–₹100', 'saravana@example.com', 'Saravana', 'p:+919042700008', '', '', '')
      ] }
    ]
  },
  KDO: {
    id: '1KDOkodabakkamOfficeBBBBBBBBBBBBBBBBBBBBBB', title: 'Kodabakkam office',
    tabs: [
      { gid: 0, title: 'Sheet1', values: [HK,
        rk('l:5001', '2026-11-02T11:56:44-05:00', '2,000–4,000_sq._ft.', '₹70–₹100', 'mp@example.com', 'Prakash', 'p:+919952000009', 'Thirumal', '', 'Busy, follow-up'),
        // Queen Salon again, three weeks later, through the other sheet.
        rk('l:5002', '2026-11-05T01:35:42-05:00', '1,000–2,000_sq._ft.', '₹70–₹100', 'q@example.com', 'Queen', 'p:+917010300002', 'Thirumal', '2', 'Asked for 1000 sqft ground floor')
      ] }
    ]
  },
  KOY: {
    id: '1KOYkoyambeduLeadsCCCCCCCCCCCCCCCCCCCCCCCC', title: 'Koyambedu - Leads',
    tabs: [
      { gid: 0, title: 'Sheet1', values: [HY,
        ry('l:7001', '2026-10-25T00:26:11-05:00', 'Creative 3', '3_cr_to_5_cr', '1_-_3_months', 'x@example.com', 'Sandeep', 'p:+9189573500010', '1', 'not interested, Hindi person'),
        ry('l:7002', '2026-10-25T02:28:57-05:00', 'Creative 1', '3_cr_to_5_cr', 'immediately', 'm@example.com', 'Murugan', 'p:9787800011', '1', 'from Tirunelveli'),
        ry('l:7003', '2026-11-06T10:03:02-05:00', 'Creative 3', '1_cr_to_2_cr', 'immediately', 'aswin@example.com', 'Aswin Ramesh', 'p:+919600000012', '', 'busy, follow up'),
        // Arjun (the gym, KDBMC001) also asked about the Koyambedu flats.
        ry('l:7004', '2026-11-06T17:29:10-05:00', 'Creative 1', '1_cr_to_2_cr', '1_-_3_months', 'arjun@example.com', 'Arjun', 'p:+919003000003', '', '')
      ] }
    ]
  }
};

export const SOURCES = [
  { spreadsheetId: SHEETS.KDB.id, title: SHEETS.KDB.title, propertyCode: 'KDBMC001', propertyName: 'Commercial Building for Rent', tabs: [{ gid: 0, title: 'Sheet1' }, { gid: 222, title: 'Sheet3' }] },
  { spreadsheetId: SHEETS.KDO.id, title: SHEETS.KDO.title, propertyCode: 'KDBMC001', propertyName: 'Commercial Building for Rent', tabs: [{ gid: 0, title: 'Sheet1' }] },
  { spreadsheetId: SHEETS.KOY.id, title: SHEETS.KOY.title, propertyCode: 'SHR0001', propertyName: 'Shriram Codename King Life', tabs: [{ gid: 0, title: 'Sheet1' }] }
];

export const ROSTER = ['swami@threepin.in', 'thirumal@threepin.in', 'rameez@threepin.in'];
export const STAGES = [{ id: 'new', name: 'New', key: 'new' }, { id: 'contacted', name: 'Contacted', key: 'options' }, { id: 'site_visit', name: 'Site Visit', key: 'visit_pending' }, { id: 'lost', name: 'Lost', key: 'lost' }];
export const CRM_LEADS = [
  { id: 'C1', name: 'Saravanan O V', phone: '90427 00008', stageId: 'site_visit', assignedAgent: 'swami@threepin.in', propertyCodes: ['ANR005'],
    propertyInterest: 'Commercial space Anna Nagar', budget: '₹1.5 L/month', source: 'tailortalk', createdAt: NOW - 40 * 86400000, updatedAt: NOW - 3 * 86400000,
    aiSummary: 'Runs a fitness studio; visited ANR005, found the rent high, open to Kodambakkam if under ₹90/sqft.' },
  { id: 'C2', name: 'Prakash MP Fitness', phone: '+91 99520 00009', stageId: 'contacted', assignedAgent: 'thirumal@threepin.in', propertyCodes: ['KDBMC001'],
    source: 'manual', createdAt: NOW - 4 * 86400000, updatedAt: NOW - 1 * 86400000, ai: { line: 'Called twice, wants a weekend visit' } },
  // Lost two months ago for the Koyambedu flats — and enquired again through the ad on 6 Nov: reopen.
  { id: 'C4', name: 'Aswin R', phone: '9600000012', stageId: 'lost', assignedAgent: 'rameez@threepin.in', propertyCodes: ['SHR0001'], lostReason: 'Budget too low',
    source: 'meta', createdAt: NOW - 60 * 86400000, updatedAt: NOW - 50 * 86400000 },
  // Made on 10 Oct for KDBMC001; her ad row of 20 Oct is a new enquiry for the same property: revisited.
  { id: 'C5', name: 'Parinita S', phone: '6369400006', stageId: 'contacted', assignedAgent: 'swami@threepin.in', propertyCodes: ['KDBMC001'],
    source: 'manual', createdAt: Date.parse('2026-10-10T11:00:00+05:30'), updatedAt: NOW - 10 * 86400000 }
];

// A Google Sheets API stand-in over SHEETS: the metadata call and values:batchGet, as Google answers.
// Sheets listed in `locked` answer 403, as a sheet not shared with the service account does.
export function fakeSheetsFetch(locked = new Set()) {
  // Its own copy, so writes land here and not in the fixtures other tests read.
  const data = JSON.parse(JSON.stringify(SHEETS));
  const byId = Object.fromEntries(Object.values(data).map(s => [s.id, s]));
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push((opts.method === 'POST' ? 'POST ' : '') + u.pathname + u.search);
    const wm = u.pathname.match(/\/v4\/spreadsheets\/([^/:]+)\/values:batchUpdate$/);
    if (wm) {
      if (locked.has(wm[1])) return res(403, { error: { message: 'no' } });
      const sh = byId[wm[1]];
      for (const d of JSON.parse(opts.body).data) {
        const mm = d.range.match(/^'((?:[^']|'')+)'!([A-Z]+)(\d+)$/);
        const tab = sh.tabs.find(t => t.title === mm[1].replace(/''/g, "'"));
        const col = mm[2].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, row = Number(mm[3]) - 1;
        while (tab.values.length <= row) tab.values.push([]);
        while (tab.values[row].length <= col) tab.values[row].push('');
        tab.values[row][col] = d.values[0][0];
      }
      return res(200, { totalUpdatedCells: JSON.parse(opts.body).data.length });
    }
    const fm = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (fm) {
      const sh = byId[decodeURIComponent(fm[1])];
      if (!sh) return res(404, { error: { message: 'File not found' } });
      // Any change to the sheet (a write here, or a test editing the data) changes its modifiedTime.
      let h = 0; const str = JSON.stringify(sh.tabs); for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
      return res(200, { modifiedTime: '2026-11-07T05:00:00.' + String(h >>> 0).padStart(10, '0') + 'Z' });
    }
    if (u.pathname === '/drive/v3/files') return res(200, { files: [...Object.values(SHEETS).map(sh => ({ id: sh.id, name: sh.title, modifiedTime: '2026-11-07T05:00:00Z', owners: [{ emailAddress: 'suriyaraja1707@gmail.com' }] })),
      { id: 'INVENTORYsheetXXXXXXXXXXXXXXXXXXXXXXXXXXXX', name: '3PIN_Inventory_Master', modifiedTime: '2026-11-07T04:00:00Z', owners: [{ emailAddress: '3pinrentals@gmail.com' }] }] });
    const one = u.pathname.match(/\/v4\/spreadsheets\/([^/:]+)\/values\/A1:AZ1$/);
    if (one) {
      if (locked.has(one[1])) return res(403, { error: { message: 'no' } });
      const sh = byId[one[1]];
      return res(200, { values: [sh ? sh.tabs[0].values[0] : ['Property_ID', 'Property_Name_Project']] });
    }
    const m = u.pathname.match(/\/v4\/spreadsheets\/([^/:]+)(\/values:batchGet)?$/);
    if (!m) return res(404, { error: { message: 'no route' } });
    if (locked.has(m[1])) return res(403, { error: { code: 403, message: 'The caller does not have permission' } });
    const sh = byId[m[1]];
    if (!sh) return res(404, { error: { message: 'Requested entity was not found.' } });
    if (!m[2]) return res(200, { properties: { title: sh.title }, sheets: sh.tabs.map(t => ({ properties: { sheetId: t.gid, title: t.title, gridProperties: { rowCount: 1000 } } })) });
    const ranges = u.searchParams.getAll('ranges');
    return res(200, { valueRanges: ranges.map(r => {
      const mm = r.match(/^'((?:[^']|'')+)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      const tab = sh.tabs.find(t => t.title === mm[1].replace(/''/g, "'"));
      const from = Number(mm[3]) - 1, to = Number(mm[5]);
      const rows = tab ? tab.values.slice(from, to) : [];
      const cols = mm[2] === 'A' && mm[4] === 'B' ? 2 : 52;
      return { range: r, values: rows.map(x => x.slice(0, cols)) };
    }) });
  };
  return { fetch, calls, data };
}

// A stand-in for the lead AI (api/_lead-ai.js classifyLead): a fixed, readable verdict from what the
// case file says, so the brief can be clicked through without Gemini.
export function fakeClassify(now = Date.now()) {
  const calls = [];
  const tomorrow11 = (() => { const d = new Date(now + 5.5 * 3600000 + 86400000); d.setUTCHours(5, 30, 0, 0); return d.getTime(); })();
  const base = { intent: 'rent', confidence: 'medium', holdReason: null, holdUntil: null, lostReason: null, urgency: 'normal', visit: { status: 'none', at: null, property: null }, want: null };
  const classify = async ({ caseFile }) => {
    calls.push(caseFile);
    // Only what the person and the team wrote — not the case file's own reading notes.
    const t = caseFile.slice(caseFile.indexOf('AD ENQUIRIES')).toLowerCase();
    let v;
    if (/not interested/.test(t)) v = { ...base, stage: 'lost', lostReason: 'not_interested', evidence: 'Remarks: not interested', next: { owner: 'none', action: null, kind: 'none', dueAt: null }, line: 'Said not interested', urgency: 'low' };
    else if (/visit/.test(t)) v = { ...base, stage: 'visit_pending', evidence: 'Note: visiting', next: { owner: 'team', action: 'Call to confirm the visit time', kind: 'confirm_visit', dueAt: tomorrow11 }, visit: { status: 'requested', at: null, property: null }, line: 'Wants to visit; confirm the time',
      want: { deal: 'rent', budget_min: null, budget_max: null, budget_unit: 'unknown', areas: ['Kodambakkam'], bhk: [], types: ['commercial'], ready_by: null, size_sqft_min: 4000, must_have: ['gym use'], deal_breakers: ['ground floor'] } };
    else if (/busy|follow up|rnr|not answering/.test(t)) v = { ...base, stage: 'new', evidence: 'Remarks: busy', next: { owner: 'team', action: 'Call again — they were busy', kind: 'call', dueAt: now - 2 * 86400000 }, line: 'Did not get through yet' };
    else v = { ...base, stage: 'new', evidence: 'Form only', next: { owner: 'team', action: 'First call: ask what they need', kind: 'call', dueAt: null }, line: 'New enquiry, not called yet' };
    return { ok: true, model: 'gemini-test', verdict: v };
  };
  return { classify, calls };
}
