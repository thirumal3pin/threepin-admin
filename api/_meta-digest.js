// ═══════ META ADS LEADS — the 9 am round ═══════
//
// Run by the daily cron (api/followup-digest.js, 9:00 India time). Built from the live numbers of
// 22 Nov 2026: half the ad leads arrive between 8 pm and 9 am, the median first touch was ~10 hours,
// 48 leads were never touched, and 63 warm leads (rated 3–4) had no follow-up after a week.
//
//  1. Reads every connected sheet once — which also gives the night's new leads to the default person
//     of their sheet or property (api/_meta-assign.js) and e-mails them.
//  2. E-mails each person their own list: follow-ups due today or overdue (the row's "Next follow-up"
//     date, set in the app — added 23 Nov 2026), new since yesterday morning and not called yet,
//     assigned but untouched for over a day, and warm leads (rated 3+) with no follow-up for a week.
//  3. E-mails the managers (Tasks managers — Thirumal and Swami until changed) the leads nobody has,
//     and who is sitting on untouched leads.
// Nothing is sent to someone with nothing waiting. metaLeadConfigs/{tenant}.digest === false switches
// the e-mails off (the reading and default-person step still run).
import { getDb } from './_bot-shared.js';
import { TENANT_ID } from './_inventory-shared.js';
import * as TM from '../shared-assets/task-model.js';
import { readTab, parseFollowUp, formatFollowUp, istParts2, istMoment } from '../crm-assets/metaLeadsModel.js';
import { metaLeadsAction, makeDeps } from './_meta-leads.js';
import { teamPeople, exactlyWho, whoIs, assignLabel } from './_meta-assign.js';

const H = 3600000, DAY = 24 * H;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const touched = t => !!(t && (t.rating || (t.remarks || []).length || (t.followups || []).length || (t.notes || []).length));
const ago = (t, now) => { const h = Math.round((now - t) / H); return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`; };

// The buckets, from the tabs of a read. → { byPerson: Map(email → {due, fresh, stale, warm}), unassigned: [], unknown: [] }
export function buckets(tabs, people, now) {
  const byPerson = new Map(), unassigned = [], seen = new Set();
  const slot = e => { if (!byPerson.has(e)) byPerson.set(e, { due: [], fresh: [], stale: [], warm: [] }); return byPerson.get(e); };
  const t = istParts2(now), endOfToday = istMoment(t.y, t.m, t.d, 24 * 60) - 1;
  // Newest first, so a person who enquired again is judged by the new row (not called yet), not by
  // the old one someone already worked.
  const all = [];
  for (const tab of tabs) for (const e of readTab(tab).enquiries) if (e.metaId && e.at) all.push({ e, tab });
  all.sort((a, b) => b.e.at - a.e.at);
  // The next follow-up of a person for a property: the newest of their rows that has one.
  const nextFu = new Map();
  for (const { e, tab } of all) { const k = (e.phoneKey || e.metaId) + '|' + (tab.propertyCode || ''); if (!nextFu.has(k) && e.team.nextFu) nextFu.set(k, parseFollowUp(e.team.nextFu, now)); }
  for (const { e, tab } of all) {
    {
      const key = (e.phoneKey || e.metaId) + '|' + (tab.propertyCode || '');
      if (seen.has(key)) continue;   // the same person twice for one property: the newest row only
      seen.add(key);
      const item = { name: e.name, phone: e.phone, code: tab.propertyCode || '', at: e.at, rating: e.team.rating, sheet: `${String(tab.sheetTitle || '').trim()} › ${tab.title}` };
      const raw = String(e.team.assigned || '').trim();
      const who = raw ? (exactlyWho(raw, people) || whoIs(raw, people)) : null;
      const age = now - e.at;
      if (!raw) { if (age < 30 * DAY) unassigned.push(item); continue; }
      if (!who) continue;
      const fu = nextFu.get(key);
      if (fu && fu.at && fu.at <= endOfToday && now - fu.at < 60 * DAY) {
        const late = fu.at < istMoment(t.y, t.m, t.d, 0);
        const when = late ? 'overdue · was due ' + formatFollowUp(fu.at, false).replace(/ \d{4}$/, '') : 'due today' + (fu.timed ? ' ' + formatFollowUp(fu.at, true).split(', ')[1] : '');
        slot(who).due.push({ ...item, dueAt: fu.at, when });
        continue;
      }
      if (fu && (fu.none || (fu.at && fu.at > endOfToday))) continue;   // a date ahead, or "No follow-up": nothing to chase today
      if (!touched(e.team)) { if (age <= DAY) slot(who).fresh.push(item); else if (age < 45 * DAY) slot(who).stale.push(item); }
      else if ((e.team.rating || 0) >= 3 && !(e.team.followups || []).length && age > 7 * DAY && age < 60 * DAY) slot(who).warm.push(item);
    }
  }
  const newest = (a, b) => b.at - a.at;
  for (const v of byPerson.values()) { v.due.sort((a, b) => a.dueAt - b.dueAt); v.fresh.sort(newest); v.stale.sort(newest); v.warm.sort(newest); }
  unassigned.sort(newest);
  return { byPerson, unassigned };
}

function listHtml(title, colour, items, now, max = 12) {
  if (!items.length) return '';
  const rows = items.slice(0, max).map(x => {
    const tel = String(x.phone || '').replace(/[^\d+]/g, '');
    return `<tr><td style="padding:7px 0;border-top:1px solid #EEE"><b>${esc(x.name || 'No name')}</b> <span style="color:#666;font-size:12px">${esc(x.code)} · ${esc(x.when || ago(x.at, now))}${x.rating ? ' · rated ' + esc(x.rating) : ''}</span></td>
      <td align="right" style="padding:7px 0;border-top:1px solid #EEE;white-space:nowrap">${tel ? `<a href="tel:${esc(tel)}" style="color:#1E8E3E;font-weight:bold;text-decoration:none">${esc(x.phone)}</a>` : '<span style="color:#C5221F">no number</span>'}</td></tr>`;
  }).join('');
  return `<div style="margin:16px 0 4px;font-size:13px;font-weight:bold;color:${colour};text-transform:uppercase;letter-spacing:.05em">${esc(title)} · ${items.length}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${rows}</table>${items.length > max ? `<div style="color:#666;font-size:12px;margin-top:4px">and ${items.length - max} more in the app</div>` : ''}`;
}
function wrap(heading, body, appUrl) {
  return `<!doctype html><html><body style="margin:0;padding:20px 12px;background:#F4F4F4;font-family:Arial,Helvetica,sans-serif;color:#212121">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E0E0E0;border-radius:12px;overflow:hidden"><div style="background:#FF8A00;height:6px"></div>
  <div style="padding:20px"><div style="font-size:12px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;color:#A35A00">Meta ad leads · this morning</div>
  <h1 style="font-size:19px;margin:8px 0 6px">${esc(heading)}</h1>${body}
  <a href="${esc(appUrl)}/ads" style="display:inline-block;margin-top:18px;background:#212121;color:#fff;text-decoration:none;font-weight:bold;font-size:14px;padding:10px 16px;border-radius:8px">Open Meta Ads Leads</a></div>
  <div style="padding:10px 20px;background:#FAFAFA;border-top:1px solid #EEE;font-size:12px;color:#888">3 PIN Realty · sent at 9 am when something is waiting. Write a note or a rating in the app and a lead leaves this list; set its next follow-up date and it comes back that morning.</div></div></body></html>`;
}

export function personEmail(b, now, appUrl) {
  const due = b.due || [];
  const n = due.length + b.fresh.length + b.stale.length + b.warm.length;
  const heading = b.fresh.length ? `${b.fresh.length} new lead${b.fresh.length > 1 ? 's' : ''} to call first thing` + (due.length ? ` and ${due.length} follow-up${due.length > 1 ? 's' : ''} due` : '')
    : due.length ? `${due.length} follow-up${due.length > 1 ? 's' : ''} due today` : `${n} lead${n > 1 ? 's' : ''} waiting for you`;
  const body = listHtml('Follow-ups due today', '#3D4F9F', due, now, 25) + listHtml('New — not called yet', '#1E8E3E', b.fresh, now) + listHtml('Assigned, untouched for over a day', '#C5221F', b.stale, now) + listHtml('Warm (rated 3+), no follow-up for a week', '#A35A00', b.warm, now);
  const text = [['Follow-ups due today', due], ['New — not called yet', b.fresh], ['Untouched for over a day', b.stale], ['Warm, no follow-up for a week', b.warm]]
    .filter(([, l]) => l.length).map(([t, l]) => `${t}:\n` + l.slice(0, 12).map(x => `  ${x.name || 'No name'} — ${x.phone || 'no number'} — ${x.code} — ${x.when || ago(x.at, now)}`).join('\n')).join('\n\n') + `\n\n${appUrl}/ads`;
  return { subject: heading, text, html: wrap(heading, body, appUrl) };
}

export function managerEmail(res, people, now, appUrl) {
  const sitting = [...res.byPerson.entries()].map(([email, b]) => ({ email, stale: b.stale.length, fresh: b.fresh.length })).filter(x => x.stale || x.fresh).sort((a, b) => b.stale - a.stale);
  const heading = res.unassigned.length ? `${res.unassigned.length} ad lead${res.unassigned.length > 1 ? 's' : ''} with nobody assigned` : 'Ad leads this morning';
  const table = sitting.length ? `<div style="margin:16px 0 4px;font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;color:#444">Waiting with the team</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${sitting.map(x => `<tr><td style="padding:6px 0;border-top:1px solid #EEE">${esc(assignLabel(x.email))}</td><td align="right" style="padding:6px 0;border-top:1px solid #EEE">${x.fresh} new · <b style="color:${x.stale ? '#C5221F' : '#212121'}">${x.stale} untouched over a day</b></td></tr>`).join('')}</table>` : '';
  const body = listHtml('Nobody assigned', '#C5221F', res.unassigned, now) + table;
  const text = `Nobody assigned: ${res.unassigned.length}\n` + sitting.map(x => `${assignLabel(x.email)}: ${x.fresh} new, ${x.stale} untouched over a day`).join('\n') + `\n\n${appUrl}/ads`;
  return { subject: heading, text, html: wrap(heading, body, appUrl) };
}

export async function metaMorning(db0, tenantId, deps0 = {}) {
  if (tenantId !== TENANT_ID && !deps0.anyTenant) return { skipped: 'not this tenant' };
  const db = db0 || getDb();
  const cfgSnap = await db.collection('metaLeadConfigs').doc(tenantId).get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  if (!(cfg.sources || []).some(s => s.on !== false)) return { skipped: 'no sheets' };
  let sa = null;
  try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || 'null'); } catch { sa = null; }
  const deps = { ...makeDeps({ serviceAccount: sa, db }), ...deps0, db };
  const now = deps.now();
  const [read, status] = await metaLeadsAction({ tenantId, email: 'auto@morning', role: 'system' }, { action: 'read' }, deps);
  if (status !== 200) return { error: read.error || 'read failed' };
  if (cfg.digest === false) return { read: read.tabs.length, mailed: 0, off: true };
  const people = await teamPeople(tenantId, deps);
  const res = buckets(read.tabs, people, now);
  const sent = [];
  for (const [email, b] of res.byPerson) {
    if (!(b.due.length + b.fresh.length + b.stale.length + b.warm.length)) continue;
    const m = personEmail(b, now, deps.appUrl);
    const r = await deps.mail(email, m).catch(e => ({ ok: false, error: e.message }));
    sent.push({ to: email, ok: !!(r && r.ok), due: b.due.length, fresh: b.fresh.length, stale: b.stale.length, warm: b.warm.length });
  }
  const tc = await db.collection('taskConfigs').doc(tenantId).get();
  const managers = TM.managersOf(tc.exists ? tc.data() : null);
  if (res.unassigned.length || [...res.byPerson.values()].some(b => b.stale.length)) {
    const m = managerEmail(res, people, now, deps.appUrl);
    for (const email of managers) {
      const r = await deps.mail(email, m).catch(e => ({ ok: false, error: e.message }));
      sent.push({ to: email, ok: !!(r && r.ok), manager: true, unassigned: res.unassigned.length });
    }
  }
  console.log('meta morning:', JSON.stringify({ tabs: read.tabs.length, errors: (read.errors || []).length, sent: sent.map(s => s.to + (s.ok ? '' : ' FAILED')) }));
  return { read: read.tabs.length, errors: (read.errors || []).length, sent };
}
