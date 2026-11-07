// ═══════════════════════════════════════════════════════════════════════
// META ADS LEADS — the server half (POST /api/meta-leads, routed through api/sync-inventory.js
// because the plan allows 12 functions and all 12 are taken; see vercel.json).
//
// Reads the Google Sheets Meta writes its ad leads into, as the app's service account. TEST MODE:
// nothing here writes a lead, a note or a cell — it reads, and it keeps the setup. What the rows
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
//   read     every connected tab's rows, for the page to plan from                     [the team]
//
// Firestore cost per call: config 2 reads; inspect 1; save 2 + 1 write; read 1 + 1 write.
// ═══════════════════════════════════════════════════════════════════════

import { getDb, verifyCrmUser } from './_bot-shared.js';
import { getSheetsToken, TENANT_ID } from './_inventory-shared.js';
import * as TM from '../shared-assets/task-model.js';
import { parseSheetLink, classifyColumns, columnIssues, ROLES } from '../crm-assets/metaLeadsModel.js';

const COLLECTION = 'metaLeadConfigs';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';
const MAX_SOURCES = 60, MAX_TABS = 40, MAX_ROWS = 5000;
const READ_RANGE = `A1:AZ${MAX_ROWS}`;

const quoteTab = t => `'${String(t).replace(/'/g, "''")}'`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export function makeDeps(overrides = {}) {
  return {
    db: overrides.db || getDb(),
    fetch: overrides.fetch || ((...a) => fetch(...a)),
    serviceAccount: overrides.serviceAccount,
    token: overrides.token || (sa => getSheetsToken(sa)),
    now: overrides.now || (() => Date.now())
  };
}

// A Google answer → data, or an Error that says what to do about it.
async function google(deps, tokenP, url, what, shareWith) {
  const token = await tokenP;
  let res;
  try { res = await deps.fetch(url, { headers: { Authorization: `Bearer ${token}` } }); }
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
        return { gid: Number(t.gid), title: String(t.title || '').slice(0, 120), on: t.on !== false, overrides };
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
export async function metaLeadsAction(user, body, deps) {
  const T = user.tenantId, db = deps.db, me = String(user.email || '').toLowerCase();
  const sa = deps.serviceAccount;
  const shareWith = (sa && sa.client_email) || 'the app’s service account';
  const action = String((body && body.action) || '');
  const tokenOnce = () => { let p; return () => (p = p || deps.token(sa)); };

  if (action === 'config') {
    const [cfg, manager] = await Promise.all([loadConfig(db, T), loadManager(db, T, me)]);
    return [{ ok: true, mode: 'test', sources: cfg.sources || [], lastRead: cfg.lastRead || null, updatedAt: cfg.updatedAt || null, updatedBy: cfg.updatedBy || null, manager, shareWith }, 200];
  }

  if (action === 'inspect' || action === 'save') {
    if (!(await loadManager(db, T, me))) return [{ ok: false, error: 'Only a manager can change the Meta leads setup' }, 403];
  }
  if (!sa && action !== 'save') return [{ ok: false, error: 'The server is missing its Google service account' }, 500];

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
    const cfg = await loadConfig(db, T);
    const sources = (cfg.sources || []).filter(s => s.on !== false);
    const only = body.sourceId ? String(body.sourceId) : null;
    const tok = tokenOnce();
    const tabs = [], errors = [], sheets = [];
    for (const s of sources) {
      if (only && s.id !== only) continue;
      const want = (s.tabs || []).filter(t => t.on !== false);
      if (!want.length) continue;
      try {
        // Tabs are kept by their id (gid): a renamed tab is still found under its new name.
        const meta = await sheetMeta(deps, tok(), s.spreadsheetId, shareWith);
        const found = want.map(t => ({ t, now: meta.tabs.find(x => x.gid === t.gid) }));
        for (const f of found.filter(f => !f.now)) errors.push({ sourceId: s.id, title: `${s.title} › ${f.t.title}`, error: 'This tab is no longer in the sheet' });
        const live = found.filter(f => f.now);
        const values = await batchGet(deps, tok(), s.spreadsheetId, live.map(f => `${quoteTab(f.now.title)}!${READ_RANGE}`), shareWith);
        live.forEach((f, i) => tabs.push({
          sourceId: s.id, spreadsheetId: s.spreadsheetId, sheetTitle: meta.title || s.title, title: f.now.title, gid: f.t.gid,
          propertyCode: s.propertyCode, overrides: f.t.overrides || {}, values: values[i] || []
        }));
        sheets.push({ id: s.id, title: meta.title || s.title, ok: true, rows: live.map((f, i) => ({ gid: f.t.gid, title: f.now.title, rows: Math.max((values[i] || []).length - 1, 0) })) });
      } catch (e) {
        errors.push({ sourceId: s.id, title: s.title, error: e.message, code: e.code || 'error' });
        sheets.push({ id: s.id, title: s.title, ok: false, error: e.message });
      }
    }
    const at = deps.now();
    if (!only) await db.collection(COLLECTION).doc(T).set({ lastRead: { at, by: me, sheets } }, { merge: true });
    return [{ ok: true, mode: 'test', at, tabs, errors, shareWith }, 200];
  }

  return [{ ok: false, error: 'Unknown action' }, 400];
}

export async function metaLeadsPost(request) {
  const user = await verifyCrmUser(request);
  if (!user || !user.tenantId) return json({ ok: false, error: 'Unauthorized' }, 401);
  // The lead sheets are 3 PIN Realty's: another tenant's valid token must not read them.
  if (user.tenantId !== TENANT_ID) return json({ ok: false, error: 'Not available for your account' }, 403);
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  let sa = null;
  try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || 'null'); } catch { sa = null; }
  try {
    const [out, status] = await metaLeadsAction(user, body, makeDeps({ serviceAccount: sa }));
    return json(out, status);
  } catch (e) {
    console.error('meta-leads error:', e);
    const quota = /RESOURCE_EXHAUSTED|quota/i.test(String(e && e.message));
    return json({ ok: false, error: quota ? 'The database is out of its daily quota — try again after it resets' : 'Something went wrong reading the lead sheets' }, quota ? 429 : 500);
  }
}
