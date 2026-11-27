// ═══════════════════════════════════════════════════════════════════════
// META ADS LEADS — the server half (POST /api/meta-leads, routed through api/sync-inventory.js
// because the plan allows 12 functions and all 12 are taken; see vercel.json).
//
// Reads the Google Sheets Meta writes its ad leads into, as the app's service account, and writes
// the TEAM's columns of them back (assigned to, rating, remarks, follow-ups) when someone edits a
// lead here. No CRM lead is created or changed (that sync is not switched on yet). What the rows
// mean (and what a sync would do with them) is crm-assets/metaLeadsModel.js, shared with the page,
// which has the CRM's leads in memory already — so matching against them costs no reads here.
//
//   metaLeadConfigs/{tenant}  { sources: [{ id, spreadsheetId, title, propertyCode, propertyName,
//                               on, tabs: [{ gid, title, on, overrides }], addedAt, addedBy }],
//                               updatedAt, updatedBy, lastRead: { at, by, sheets: [...] } }
//
// Actions (body.action):
//   config   the setup, who may change it, and the address sheets must be shared with
//   inspect  a sheet link → its tabs, columns (what each means), first rows, lead count  [managers]
//   save     the setup                                                                  [managers]
//   available  the sheets shared with the app, Meta ad lead sheets marked                 [managers]
//   read     every connected tab's rows, for the page to plan from                     [the team]
//            — with since: { sourceId: modifiedTime }, a sheet Google Drive says has not
//              changed since is skipped (unchanged: [ids]); mods: each sheet's modifiedTime
//   brief    the AI's reading of one person: stage, next step and when, requirement, objections
//   briefs   every stored brief                                                         [the team]
//   write    the team's columns of a connected tab (assigned, rating, remarks, follow-ups) [the team]
//            — a new column                                                             [managers]
//            — "Assigned to": agents never; to or from an agent: admins only (api/_meta-assign.js)
//   set-auto-assign  { scope: 'sheet' | 'property', key, email | null } — the default person for new
//            leads of a sheet or a property; null removes it                                [admins]
//
// Who gets a lead, the grants an agent's lead brings, the default person and the "new lead" e-mail:
// api/_meta-assign.js.
//
// Adding a column outright (field 'header') is for managers; a write that needs Rating / Assigned to /
// Follow up N where the tab has none adds that one column for anyone working the lead.
// Firestore cost per call: config 2 reads; inspect 1; save 2 + 1 write; read 1 + 1 write.
// ═══════════════════════════════════════════════════════════════════════

import { getDb, verifyCrmUser } from './_bot-shared.js';
import { effectiveConfig } from '../shared-assets/agent-config.js';
import { getSheetsToken, TENANT_ID } from './_inventory-shared.js';
import * as TM from '../shared-assets/task-model.js';
import { parseSheetLink, classifyColumns, columnIssues, ROLES, planSheetWrite } from '../crm-assets/metaLeadsModel.js';
import { briefAction, briefsAction, defaultClassify } from './_meta-leads-brief.js';
import { sendEmail } from './_bot-shared.js';
import * as MA from './_meta-assign.js';
import { relabel } from './_usage.js';

const COLLECTION = 'metaLeadConfigs';
const EDITS = 'metaLeadEdits';
const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';
const MAX_SOURCES = 60, MAX_TABS = 40, MAX_ROWS = 5000;
const READ_RANGE = `A1:AZ${MAX_ROWS}`;

const quoteTab = t => `'${String(t).replace(/'/g, "''")}'`;
// One entry per person and lead (a lead's several rows assigned at once is still one lead to call).
const dedupeBy = list => { const seen = new Set(); return list.filter(a => { const k = a.email + '|' + ((a.enquiry && (a.enquiry.phoneKey || a.enquiry.metaId)) || Math.random()); if (seen.has(k)) return false; seen.add(k); return true; }); };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export function makeDeps(overrides = {}) {
  return {
    db: overrides.db || getDb(),
    fetch: overrides.fetch || ((...a) => fetch(...a)),
    serviceAccount: overrides.serviceAccount,
    token: overrides.token || ((sa, scope) => getSheetsToken(sa, scope)),
    now: overrides.now || (() => Date.now()),
    // The lead AI (api/_lead-ai.js classifyLead) — a stand-in in the tests.
    classify: overrides.classify || defaultClassify,
    // Who is on the team (Auth); the "new lead for you" e-mail; rebuilding an agent's copy after a grant.
    team: overrides.team,
    mail: overrides.mail || ((to, m) => sendEmail(to, m.subject, m.text, m.html)),
    rebuildAgents: overrides.rebuildAgents || (async (db, T, emails) => (await import('./_agent-work.js')).rebuildAgents(db, T, emails)),
    appUrl: overrides.appUrl || process.env.APP_URL || 'https://admin.threepin.in',
  };
}

// A Google answer → data, or an Error that says what to do about it.
async function google(deps, tokenP, url, what, shareWith, body) {
  const token = await tokenP;
  let res;
  try {
    res = await deps.fetch(url, body
      ? { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { headers: { Authorization: `Bearer ${token}` } });
  }
  catch { throw Object.assign(new Error(`Could not reach Google Sheets for ${what}`), { code: 'network' }); }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  if (res.status === 403) throw Object.assign(new Error(`The app cannot open ${what} — share it with ${shareWith} (Editor)`), { code: 'share' });
  if (res.status === 404) throw Object.assign(new Error(`${what} was not found — check the link`), { code: 'missing' });
  throw Object.assign(new Error(`Google Sheets refused ${what} (${res.status}): ${String((data.error && data.error.message) || '').slice(0, 160)}`), { code: 'google' });
}

async function sheetMeta(deps, tokenP, spreadsheetId, shareWith) {
  const d = await google(deps, tokenP, `${SHEETS}${spreadsheetId}?fields=properties.title,sheets.properties(sheetId,title,gridProperties.rowCount)`, 'this sheet', shareWith);
  return {
    title: (d.properties && d.properties.title) || '',
    tabs: (d.sheets || []).map(s => ({ gid: s.properties.sheetId, title: s.properties.title, rows: (s.properties.gridProperties || {}).rowCount || 0 }))
  };
}

async function batchGet(deps, tokenP, spreadsheetId, ranges, shareWith) {
  if (!ranges.length) return [];
  const q = ranges.map(r => 'ranges=' + encodeURIComponent(r)).join('&');
  const d = await google(deps, tokenP, `${SHEETS}${spreadsheetId}/values:batchGet?${q}&majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`, 'this sheet', shareWith);
  return (d.valueRanges || []).map(v => v.values || []);
}

const loadConfig = async (db, T) => { const s = await db.collection(COLLECTION).doc(T).get(); return s.exists ? (s.data() || {}) : {}; };
const loadManager = async (db, T, email) => {
  const s = await db.collection('taskConfigs').doc(T).get();
  return TM.isManager(s.exists ? s.data() : null, email);
};

// The setup as sent by the page, tidied: only what this module knows, bounded.
export function cleanSources(list, prev, by, now) {
  const before = new Map((Array.isArray(prev) ? prev : []).map(s => [s.id, s]));
  const out = [];
  for (const s of (Array.isArray(list) ? list : []).slice(0, MAX_SOURCES)) {
    const link = parseSheetLink(s && (s.spreadsheetId || s.link));
    if (!link || out.some(o => o.id === link.spreadsheetId)) continue;
    const old = before.get(link.spreadsheetId) || {};
    const tabs = (Array.isArray(s.tabs) ? s.tabs : []).slice(0, MAX_TABS)
      .filter(t => t && Number.isInteger(Number(t.gid)))
      .map(t => {
        const overrides = {};
        for (const [k, v] of Object.entries((t.overrides && typeof t.overrides === 'object') ? t.overrides : {})) {
          if (/^\d{1,3}$/.test(k) && ROLES[v] && v !== 'meta') overrides[k] = v;
        }
        // Each tab has its own property (two tabs of one sheet can be for different properties);
        // a tab without one falls back to the sheet's.
        const code = String(t.propertyCode || '').trim().toUpperCase().slice(0, 40);
        const tag = String(t.tag || '').trim().slice(0, 40), remark = String(t.remark || '').trim().slice(0, 500);
        return { gid: Number(t.gid), title: String(t.title || '').slice(0, 120), on: t.on !== false, overrides,
          ...(code ? { propertyCode: code } : {}), ...(tag ? { tag } : {}), ...(remark ? { remark } : {}),
          // A tab added to the sheet after it was connected: listed off, marked new, until someone turns it on.
          ...(t.fresh && t.on === false ? { fresh: true } : {}) };
      });
    out.push({
      id: link.spreadsheetId, spreadsheetId: link.spreadsheetId,
      title: String(s.title || '').slice(0, 200),
      propertyCode: String(s.propertyCode || '').trim().toUpperCase().slice(0, 40),
      propertyName: String(s.propertyName || '').slice(0, 200),
      on: s.on !== false, tabs,
      addedAt: old.addedAt || now, addedBy: old.addedBy || by
    });
  }
  return out;
}

/** One action. → [body, status]. */
// An agent's view of the setup: only the tabs for their own properties (deps.agentCodes, a Set of
// property codes; absent for everyone else). A source with none of their tabs is left out entirely.
export function scopeSources(cfg, codes) {
  if (!codes) return cfg;
  const sources = (cfg.sources || []).map(s => ({ ...s, tabs: (s.tabs || []).filter(t => codes.has(String(t.propertyCode || s.propertyCode || '').toUpperCase())) }))
    .filter(s => s.tabs.length);
  return { ...cfg, sources, lastRead: null };
}

// An agent's copy of the setup: every connected sheet (a lead assigned to them can be in any of them),
// without the last-read line or the default-person rules. Which ROWS they get is decided on read.
function agentSetup(cfg) {
  return { ...cfg, lastRead: null, autoAssign: null };
}
// Whether an agent sees every row of a tab (their own property, or "Ads: all") — else only theirs.
const agentOwnsTab = (deps, code) => !deps.agentCodes || deps.agentCodes.has(String(code || '').toUpperCase());

export async function metaLeadsAction(user, body, deps) {
  const T = user.tenantId, db = deps.db, me = String(user.email || '').toLowerCase();
  const sa = deps.serviceAccount;
  const shareWith = (sa && sa.client_email) || 'the app’s service account';
  const action = String((body && body.action) || '');
  relabel('meta-leads:' + action);
  const tokenOnce = () => { let p; return () => (p = p || deps.token(sa)); };

  // The AI brief of one person, and every stored brief (api/_meta-leads-brief.js).
  if (action === 'briefs') return briefsAction(user, deps);
  if (action === 'brief') return briefAction(user, { ...body }, { ...deps, classify: deps.classify || defaultClassify });

  if (action === 'config') {
    const [cfg0, manager, people] = await Promise.all([loadConfig(db, T), loadManager(db, T, me), MA.teamPeople(T, deps)]);
    const isAgent = user.role === 'agent';
    const cfg = isAgent ? agentSetup(cfg0, deps) : cfg0;
    return [{ ok: true, mode: 'test', sources: cfg.sources || [], lastRead: cfg.lastRead || null, updatedAt: cfg.updatedAt || null, updatedBy: cfg.updatedBy || null, manager, shareWith,
      // What the page may offer: only admins assign to agents; agents never assign.
      isAdmin: MA.isAdminUser(user), isAgent, agents: people.filter(p => p.role === 'agent').map(p => p.email),
      autoAssign: isAgent ? null : (cfg0.autoAssign || { sheets: {}, props: {} }) }, 200];
  }

  // The default person for the new leads of a sheet or a property (admins). email null = none.
  if (action === 'set-auto-assign') {
    if (!MA.isAdminUser(user)) return [{ ok: false, error: 'Only an admin can set who gets new leads' }, 403];
    const scope = body.scope === 'sheet' ? 'sheets' : body.scope === 'property' ? 'props' : null;
    const key = scope === 'props' ? String(body.key || '').trim().toUpperCase().slice(0, 40) : String(body.key || '').trim().slice(0, 120);
    if (!scope || !key) return [{ ok: false, error: 'Say which sheet or property' }, 400];
    const email = body.email ? String(body.email).trim().toLowerCase() : null;
    if (email) {
      const people = await MA.teamPeople(T, deps);
      if (!people.some(p => p.email === email)) return [{ ok: false, error: 'That person is not on the team' }, 400];
    }
    const cfg = await loadConfig(db, T);
    if (scope === 'sheets' && !(cfg.sources || []).some(x => x.id === key)) return [{ ok: false, error: 'That sheet is not connected' }, 404];
    const cur = cfg.autoAssign || { sheets: {}, props: {} };
    const next = { sheets: { ...(cur.sheets || {}) }, props: { ...(cur.props || {}) } };
    if (email) next[scope][key] = { email, since: deps.now(), by: me, at: deps.now() };
    else delete next[scope][key];
    await db.collection(COLLECTION).doc(T).set({ autoAssign: next, updatedAt: deps.now(), updatedBy: me }, { merge: true });
    return [{ ok: true, autoAssign: next }, 200];
  }

  if (action === 'inspect' || action === 'save' || action === 'available') {
    if (!(await loadManager(db, T, me))) return [{ ok: false, error: 'Only a manager can change the Meta leads setup' }, 403];
  }
  if (!sa && action !== 'save') return [{ ok: false, error: 'The server is missing its Google service account' }, 500];

  // Every Google Sheet shared with the app's account, newest first — and which of them are Meta ad
  // lead exports (their first tab's header row has Meta's id / created_time / campaign columns).
  if (action === 'available') {
    const cfg = await loadConfig(db, T);
    const mapped = new Set((cfg.sources || []).map(x => x.id));
    try {
      const driveTok = deps.token(sa, 'https://www.googleapis.com/auth/drive.metadata.readonly');
      const q = encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
      const d = await google(deps, driveTok, `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=60&fields=files(id,name,modifiedTime,owners(displayName,emailAddress))&supportsAllDrives=true&includeItemsFromAllDrives=true`, 'the shared sheets', shareWith);
      const files = (d.files || []).slice(0, 60);
      const tok = tokenOnce();
      // The first row of each sheet's first tab, a few at a time.
      const heads = [];
      for (let i = 0; i < files.length; i += 8) {
        heads.push(...await Promise.all(files.slice(i, i + 8).map(f =>
          google(deps, tok(), `${SHEETS}${f.id}/values/A1:AZ1`, 'a sheet', shareWith).then(v => (v.values || [])[0] || []).catch(() => null))));
      }
      return [{ ok: true, shareWith, files: files.map((f, i) => {
        const h = (heads[i] || []).map(x => String(x || '').trim().toLowerCase());
        const isMeta = h.includes('id') && h.includes('created_time') && (h.includes('campaign_name') || h.includes('form_name'));
        return { id: f.id, title: f.name, modifiedTime: f.modifiedTime ? Date.parse(f.modifiedTime) : null,
          owner: ((f.owners || [])[0] || {}).emailAddress || '', isMeta, readable: heads[i] !== null, mapped: mapped.has(f.id) };
      }) }, 200];
    } catch (e) {
      return [{ ok: false, error: e.message, code: e.code || 'error' }, 502];
    }
  }

  // The team's columns, written from the admin: assigned to, rating, remarks, follow-ups, notes —
  // and, for a manager, a new column. Only a connected tab; each edit finds its row again by the
  // Meta lead id and is refused if the cell changed since it was read. Logged in metaLeadEdits.
  if (action === 'write') {
    const sid = String(body.spreadsheetId || ''), gid = Number(body.gid);
    const edits = Array.isArray(body.edits) ? body.edits.slice(0, 1000) : [];
    if (!edits.length) return [{ ok: false, error: 'Nothing to write' }, 400];
    const [cfg, manager, people] = await Promise.all([loadConfig(db, T), loadManager(db, T, me), MA.teamPeople(T, deps)]);
    const src = (cfg.sources || []).find(x => x.id === sid);
    const tab = src && (src.tabs || []).find(t => t.gid === gid);
    if (!src || !tab) return [{ ok: false, error: 'That tab is not connected in Setup' }, 404];
    if (src.on === false || tab.on === false) return [{ ok: false, error: 'That sheet or tab is switched off in Setup' }, 409];
    if (edits.some(e => e && e.field === 'header') && !manager) return [{ ok: false, error: 'Only a manager can add a column' }, 403];
    const code = tab.propertyCode || src.propertyCode || '';
    const isAgent = user.role === 'agent';
    if (isAgent && edits.some(e => e && e.field === 'header')) return [{ ok: false, error: 'Not part of your access' }, 403];
    const wtok = deps.token(sa, WRITE_SCOPE);
    try {
      const meta = await sheetMeta(deps, wtok, sid, shareWith);
      const now = meta.tabs.find(t => t.gid === gid);
      if (!now) return [{ ok: false, error: 'That tab is no longer in the sheet' }, 404];
      const [values] = await batchGet(deps, wtok, sid, [`${quoteTab(now.title)}!${READ_RANGE}`], shareWith);
      const tabObj = { sourceId: src.id, spreadsheetId: sid, sheetTitle: meta.title || src.title, title: now.title, gid, propertyCode: code, overrides: tab.overrides || {}, values: values || [] };
      const { by: before, cols: tabCols } = MA.enquiriesById(tabObj);
      // "Assigned to" changed by name (field) or by its column (Edit this row): both are an assignment.
      const assignedCols = new Set(tabCols.filter(c => c.role === 'assigned').map(c => c.index));
      const asAssign = edits.map(e => (e && e.field !== 'assigned' && e.col != null && e.col !== '' && assignedCols.has(Number(e.col)) ? { ...e, field: 'assigned' } : e));
      const allowed = MA.checkAssignEdits(user, asAssign, people);
      if (!allowed.ok) return [{ ok: false, error: allowed.error }, allowed.status];
      // An agent writes only the rows they can see: every row of their own property's tab, else only
      // the leads assigned to them.
      if (isAgent && !agentOwnsTab(deps, code)) {
        const notMine = edits.filter(e => e && e.metaId && !MA.isExactlyFor((before.get(String(e.metaId)) || { team: {} }).team.assigned, me, people));
        if (notMine.length) return [{ ok: false, error: 'You can only update the leads assigned to you' }, 403];
      }
      const plan = planSheetWrite({ values: values || [], overrides: tab.overrides || {}, edits });
      if (plan.updates.length) {
        await google(deps, wtok, `${SHEETS}${sid}/values:batchUpdate`, 'this sheet', shareWith, {
          valueInputOption: 'RAW',
          data: plan.updates.map(u => ({ range: `${quoteTab(now.title)}!${u.range}`, values: [[u.value]] }))
        });
        try {
          await db.collection(EDITS).add({ tenantId: T, by: me, at: deps.now(), spreadsheetId: sid, gid, tab: now.title,
            applied: plan.applied.slice(0, 300), added: plan.added });
        } catch (e) { console.error('meta-leads: edit log not kept', e && e.message); }
      }
      // Who was just given a lead: their property granted (agents), an e-mail (everyone).
      const newly = plan.applied.filter(a => assignedCols.has(a.col) && a.value).map(a => ({ email: MA.exactlyWho(a.value, people), propertyCode: code, enquiry: before.get(a.metaId) }))
        .filter(a => a.email);
      const after = newly.length ? await MA.afterAssigned(db, T, me, dedupeBy(newly), people, deps) : null;
      return [{ ok: true, applied: plan.applied, added: plan.added, conflicts: plan.conflicts, errors: plan.errors, granted: after ? after.granted : [] }, 200];
    } catch (e) {
      return [{ ok: false, error: e.code === 'share' ? `The app cannot edit this sheet — share it with ${shareWith} as Editor (not Viewer)` : e.message, code: e.code || 'error' }, e.code === 'share' ? 403 : 502];
    }
  }

  if (action === 'inspect') {
    const link = parseSheetLink(body.link);
    if (!link) return [{ ok: false, error: 'That is not a Google Sheets link' }, 400];
    const tok = tokenOnce();
    try {
      const meta = await sheetMeta(deps, tok(), link.spreadsheetId, shareWith);
      const tabs = meta.tabs.slice(0, MAX_TABS);
      const heads = await batchGet(deps, tok(), link.spreadsheetId, tabs.map(t => `${quoteTab(t.title)}!A1:AZ8`), shareWith);
      const ids = await batchGet(deps, tok(), link.spreadsheetId, tabs.map(t => `${quoteTab(t.title)}!A2:B${MAX_ROWS}`), shareWith);
      return [{
        ok: true, spreadsheetId: link.spreadsheetId, title: meta.title, gid: link.gid,
        tabs: tabs.map((t, i) => {
          const v = heads[i] || [];
          const cols = classifyColumns(v[0] || [], v.slice(1));
          return { gid: t.gid, title: t.title, headers: v[0] || [], sample: v.slice(1, 4), cols, issues: columnIssues(cols),
            count: (ids[i] || []).filter(r => r && r.some(x => String(x || '').trim())).length,
            looksMeta: cols.some(c => c.role === 'meta' && c.field === 'id') && cols.some(c => c.role === 'meta' && c.field === 'createdTime') };
        })
      }, 200];
    } catch (e) {
      return [{ ok: false, error: e.message, code: e.code || 'error', shareWith }, e.code === 'share' ? 403 : e.code === 'missing' ? 404 : 502];
    }
  }

  if (action === 'save') {
    const cfg = await loadConfig(db, T);
    const sources = cleanSources(body.sources, cfg.sources, me, deps.now());
    await db.collection(COLLECTION).doc(T).set({ tenantId: T, sources, updatedAt: deps.now(), updatedBy: me }, { merge: true });
    return [{ ok: true, sources }, 200];
  }

  if (action === 'read') {
    const isAgent = user.role === 'agent';
    const [cfg, people] = await Promise.all([loadConfig(db, T), MA.teamPeople(T, deps)]);
    const sources = (cfg.sources || []).filter(s => s.on !== false);
    const autoAssigned = [];
    const only = body.sourceId ? String(body.sourceId) : null;
    const tok = tokenOnce();
    let driveP = null;
    const driveTok = () => (driveP = driveP || deps.token(sa, 'https://www.googleapis.com/auth/drive.metadata.readonly'));
    const since = body.since && typeof body.since === 'object' ? body.since : {};
    const tabs = [], errors = [], sheets = [], unchanged = [], mods = {}, discovered = [];
    const prevLine = id => ((cfg.lastRead && cfg.lastRead.sheets) || []).find(x => x.id === id);
    for (const s of sources) {
      if (only && s.id !== only) continue;
      const want = (s.tabs || []).filter(t => t.on !== false);
      if (!want.length) continue;
      // When the sheet last changed (one small Drive call). Not changed since the page's last read:
      // not read again — the page keeps the rows it has. Drive not answering: read as before.
      try {
        const d = await google(deps, driveTok(), `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(s.spreadsheetId)}?fields=modifiedTime&supportsAllDrives=true`, 'this sheet', shareWith);
        if (d && d.modifiedTime) mods[s.id] = d.modifiedTime;
      } catch (e) { /* read it */ }
      if (mods[s.id] && since[s.id] && since[s.id] === mods[s.id]) {
        unchanged.push(s.id);
        sheets.push({ ...(prevLine(s.id) || { id: s.id, title: s.title, ok: true }), unchanged: true });
        continue;
      }
      try {
        // Tabs are kept by their id (gid): a renamed tab is still found under its new name.
        const meta = await sheetMeta(deps, tok(), s.spreadsheetId, shareWith);
        // Tabs added to the sheet since it was connected: listed in Setup (off) so they can be turned on.
        const known = new Set((s.tabs || []).map(t => Number(t.gid)));
        const fresh = meta.tabs.filter(x => !known.has(x.gid)).slice(0, Math.max(0, MAX_TABS - (s.tabs || []).length));
        if (fresh.length) discovered.push({ id: s.id, title: meta.title || s.title, fresh });
        const found = want.map(t => ({ t, now: meta.tabs.find(x => x.gid === t.gid) }));
        for (const f of found.filter(f => !f.now)) errors.push({ sourceId: s.id, title: `${s.title} › ${f.t.title}`, error: 'This tab is no longer in the sheet' });
        const live = found.filter(f => f.now);
        const values = await batchGet(deps, tok(), s.spreadsheetId, live.map(f => `${quoteTab(f.now.title)}!${READ_RANGE}`), shareWith);
        live.forEach((f, i) => { if ((values[i] || []).length >= MAX_ROWS) errors.push({ sourceId: s.id, title: `${meta.title || s.title} › ${f.now.title}`, error: `Only the first ${MAX_ROWS - 1} rows are read — split this tab` }); });
        for (let i = 0; i < live.length; i++) {
          const f = live[i];
          let tab = {
            sourceId: s.id, spreadsheetId: s.spreadsheetId, sheetTitle: meta.title || s.title, title: f.now.title, gid: f.t.gid,
            propertyCode: f.t.propertyCode || s.propertyCode, tag: f.t.tag || '', remark: f.t.remark || '', overrides: f.t.overrides || {}, values: values[i] || []
          };
          // The default person for this sheet or property: new leads nobody has yet are given to them now.
          const rule = MA.ruleFor(cfg.autoAssign, s.id, tab.propertyCode);
          const want = rule ? MA.autoAssignEdits(tab, rule, deps.now()) : [];
          if (want.length) {
            try {
              const plan = planSheetWrite({ values: tab.values, overrides: tab.overrides, edits: want });
              if (plan.updates.length) {
                await google(deps, deps.token(sa, WRITE_SCOPE), `${SHEETS}${s.spreadsheetId}/values:batchUpdate`, 'this sheet', shareWith, {
                  valueInputOption: 'RAW', data: plan.updates.map(u => ({ range: `${quoteTab(f.now.title)}!${u.range}`, values: [[u.value]] }))
                });
                const byId = MA.enquiriesById(tab).by;
                // The rows as they are now, so the page shows the new names without another read.
                const vals = tab.values.map(r => (Array.isArray(r) ? r.slice() : []));
                for (const u of plan.updates) {
                  const m = /^([A-Z]+)(\d+)$/.exec(u.range); if (!m) continue;
                  const col = m[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, row = Number(m[2]) - 1;
                  while (vals.length <= row) vals.push([]);
                  vals[row][col] = u.value;
                }
                tab = { ...tab, values: vals };
                plan.applied.forEach(a => autoAssigned.push({ email: rule.email, propertyCode: tab.propertyCode, enquiry: byId.get(a.metaId), auto: true }));
                try { await db.collection(EDITS).add({ tenantId: T, by: 'auto:' + rule.scope, at: deps.now(), spreadsheetId: s.spreadsheetId, gid: f.t.gid, tab: f.now.title, applied: plan.applied.slice(0, 300), added: plan.added }); } catch (e) { /* the log is a convenience */ }
              }
            } catch (e) { errors.push({ sourceId: s.id, title: `${meta.title || s.title} › ${f.now.title}`, error: 'Could not give the new leads to ' + MA.assignLabel(rule.email) + ': ' + e.message }); }
          }
          if (isAgent && !agentOwnsTab(deps, tab.propertyCode)) {
            tab = MA.rowsForAgent(tab, me, people, null);
            if (!tab) continue;
          }
          tabs.push(tab);
        }
        sheets.push({ id: s.id, title: meta.title || s.title, ok: true, rows: live.map((f, i) => ({ gid: f.t.gid, title: f.now.title, rows: Math.max((values[i] || []).length - 1, 0) })) });
      } catch (e) {
        errors.push({ sourceId: s.id, title: s.title, error: e.message, code: e.code || 'error' });
        sheets.push({ id: s.id, title: s.title, ok: false, error: e.message });
      }
    }
    if (autoAssigned.length) await MA.afterAssigned(db, T, 'auto', dedupeBy(autoAssigned), people, deps);
    if (isAgent) {
      // An agent's read changes nothing in the setup: no new tabs listed, no "last read" line.
      return [{ ok: true, mode: 'test', at: deps.now(), tabs, errors: errors.map(e => ({ ...e, error: 'This sheet could not be read just now' })), shareWith: null, mods, unchanged, newTabs: [] }, 200];
    }
    if (discovered.length) {
      // Added to the setup as read just now (not the copy loaded before the read): nothing else is touched.
      const ref = db.collection(COLLECTION).doc(T);
      await db.runTransaction(async t => {
        const curCfg = (await t.get(ref)).data() || {};
        const next = (curCfg.sources || []).map(x => {
          const d = discovered.find(y => y.id === x.id);
          if (!d) return x;
          const have = new Set((x.tabs || []).map(tb => Number(tb.gid)));
          return { ...x, tabs: [...(x.tabs || []), ...d.fresh.filter(tb => !have.has(tb.gid)).map(tb => ({ gid: tb.gid, title: String(tb.title || '').slice(0, 120), on: false, overrides: {}, fresh: true }))] };
        });
        t.set(ref, { sources: next }, { merge: true });
      });
    }
    const newTabs = discovered.flatMap(d => d.fresh.map(t => ({ sourceId: d.id, sheetTitle: d.title, title: t.title, gid: t.gid })));
    const at = deps.now();
    // The "last read" line: only when a sheet was really read (a refresh of unchanged sheets writes
    // nothing — the free plan's writes are few), and in a transaction, because the page reads three
    // sheets at once and each would otherwise drop the others' lines.
    const order = (cfg.sources || []).map(x => x.id);
    if (sheets.some(x => !x.unchanged)) {
      const ref = db.collection(COLLECTION).doc(T);
      await db.runTransaction(async t => {
        const cur = ((await t.get(ref)).data() || {}).lastRead || {};
        const fresh = new Set(sheets.map(x => x.id));
        const merged = [...(Array.isArray(cur.sheets) ? cur.sheets.filter(x => !fresh.has(x.id)) : []), ...sheets].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        t.set(ref, { lastRead: { at, by: me, sheets: merged } }, { merge: true });
      });
    }
    return [{ ok: true, mode: 'test', at, tabs, errors, shareWith, mods, unchanged, newTabs }, 200];
  }

  return [{ ok: false, error: 'Unknown action' }, 400];
}

// What an agent may do here (the agent layer): read the leads of the ads for their own properties
// (or every ad, when the admin set "Ads: all"), mark them up in the sheet, and ask for one person's
// AI brief. Never the setup, never everyone's stored briefs.
// (No AI brief for agents: it is built from the CRM lead's notes and conversation, whoever's it is.)
const AGENT_ACTIONS = new Set(['config', 'read', 'write', 'briefs']);
// Agents who have been given at least one ad lead (api/_meta-assign.js keeps the list): the menu shows
// them Meta Ads Leads even when the admin did not give them the Ads tab. Used by api/_agent.js 'me'.
export async function hasAssignedAdLeads(db, tenantId, email) {
  try {
    const d = await db.collection(MA.ASSIGN_DOC).doc(tenantId).get();
    const agents = (d.exists && d.data().agents) || {};
    return !!agents[String(email || '').toLowerCase().replace(/[^a-z0-9]/g, '_')];
  } catch (e) { return false; }
}
// The page reads three sheets at once, each a call: an agent's scope (4 reads) is kept 2 minutes.
const scopeCache = new Map();
async function agentAdsCodes(db, user) {
  const k = user.tenantId + '|' + String(user.email || '').toLowerCase();
  const hit = scopeCache.get(k);
  if (hit && Date.now() - hit.at < 120000) return hit.v;
  const v = await agentAdsCodesFresh(db, user);
  scopeCache.set(k, { at: Date.now(), v });
  return v;
}
async function agentAdsCodesFresh(db, user) {
  const snap = await db.collection('agentConfigs').doc(user.tenantId).get();
  const cfg = effectiveConfig(snap.exists ? snap.data() : null, user.email);
  // Without the Ads tab an agent still sees the ad leads an admin assigned to them — and only those.
  if (!cfg.tabs.includes('ads')) return { codes: new Set() };
  if (cfg.adsScope === 'all') return { codes: null };
  const me = String(user.email || '').toLowerCase();
  const [a, b, c] = await Promise.all([
    db.collection('properties').where('tenantId', '==', user.tenantId).where('assignedAgent', '==', me).get(),
    db.collection('properties').where('tenantId', '==', user.tenantId).where('secondaryAgents', 'array-contains', me).get(),
    db.collection('properties').where('tenantId', '==', user.tenantId).where('secondaryAgent', '==', me).get(),
  ]);
  const codes = new Set();
  [...a.docs, ...b.docs, ...c.docs].forEach(d => { codes.add(String(d.data().propertyCode || d.id).toUpperCase()); codes.add(String(d.id).toUpperCase()); });
  return { codes };
}

export async function metaLeadsPost(request) {
  const user = await verifyCrmUser(request, { allowAgent: true });
  if (!user || !user.tenantId) return json({ ok: false, error: 'Unauthorized' }, 401);
  // The lead sheets are 3 PIN Realty's: another tenant's valid token must not read them.
  if (user.tenantId !== TENANT_ID) return json({ ok: false, error: 'Not available for your account' }, 403);
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  let agentCodes;
  if (user.role === 'agent') {
    const action = String((body && body.action) || '');
    if (!AGENT_ACTIONS.has(action)) return json({ ok: false, error: action === 'brief' ? 'AI briefs are for the team' : 'Not part of your access' }, 403);
    if (action === 'briefs') return json({ ok: true, briefs: {} });
    const scope = await agentAdsCodes(getDb(), user);
    if (scope.refused) return json({ ok: false, error: 'Meta Ads Leads is not part of your access' }, 403);
    agentCodes = scope.codes || undefined;
  }
  let sa = null;
  try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || 'null'); } catch { sa = null; }
  try {
    const [out, status] = await metaLeadsAction(user, body, { ...makeDeps({ serviceAccount: sa }), agentCodes });
    return json(out, status);
  } catch (e) {
    console.error('meta-leads error:', e);
    const quota = /RESOURCE_EXHAUSTED|quota/i.test(String(e && e.message));
    return json({ ok: false, error: quota ? 'The database is out of its daily quota — try again after it resets' : 'Something went wrong reading the lead sheets' }, quota ? 429 : 500);
  }
}

// ── The every-few-minutes tick (an outside timer: Vercel's Hobby crons run once a day) ──
//   GET /api/meta-leads?tick=1   Authorization: Bearer <META_TICK_KEY or CRON_SECRET>
// Reads every connected sheet as the system (unchanged sheets are skipped — one small Drive call
// each, no database cost), which gives new leads to their sheet's or property's default person and
// e-mails them (api/_meta-assign.js) — so a 9 pm lead reaches its person within minutes, not at 9 am.
// Database cost per tick: the setup (1 read), plus the last-read line only when a sheet changed.
export async function metaLeadsTick(request, deps0 = {}) {
  const auth = request.headers.get('authorization') || '';
  const keys = [process.env.META_TICK_KEY, process.env.CRON_SECRET].filter(Boolean);
  if (!keys.length || !keys.some(k => auth === `Bearer ${k}`)) return json({ ok: false, error: 'Unauthorized' }, 401);
  let sa = null;
  try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || 'null'); } catch { sa = null; }
  const deps = { ...makeDeps({ serviceAccount: sa, db: deps0.db }), ...deps0 };
  // The page keeps each sheet's last modifiedTime; the tick keeps its own, so an unchanged sheet is skipped.
  const T = deps0.tenantId || TENANT_ID;
  const stateRef = deps.db.collection(COLLECTION).doc(T + '__tick');
  const prev = (await stateRef.get().catch(() => null));
  const since = (prev && prev.exists && prev.data().mods) || {};
  try {
    const [out, status] = await metaLeadsAction({ tenantId: T, email: 'auto@tick', role: 'system' }, { action: 'read', since }, deps);
    if (status === 200 && out.mods && JSON.stringify(out.mods) !== JSON.stringify(since)) await stateRef.set({ mods: out.mods, at: deps.now() });
    const read = status === 200 ? out.tabs.length : 0;
    console.log('meta tick:', JSON.stringify({ read, unchanged: (out.unchanged || []).length, errors: (out.errors || []).length }));
    return json({ ok: status === 200, read, unchanged: (out.unchanged || []).length, errors: (out.errors || []).length }, status === 200 ? 200 : status);
  } catch (e) {
    console.error('meta tick error:', e);
    return json({ ok: false, error: 'tick failed' }, 500);
  }
}
