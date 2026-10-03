import { getDb, sendEmail, verifyCrmUser } from './_bot-shared.js';
import { getSheetsToken, QUEUE_SHEET_ID } from './_inventory-shared.js';
import { json, fail, checkAuth, checkRateLimit, getDriveAccessToken, makeDriveFilePublic, logBrochureCall } from './_brochure-shared.js';

// Brochure delivery, in one file/one function (Vercel's Hobby plan caps a
// deployment at 12 Serverless Functions — keeping this to a single route
// instead of two matters). Two phases, told apart by whether drive_file_id
// is present in the JSON body:
//
// Phase 1 (init) — { property_id, drive_folder_id, filename } — opens a
// Drive resumable-upload session and returns { upload_url }. The caller
// then PUTs the PDF bytes straight to that URL (Google's, not ours) —
// Vercel hard-caps every Function's request/response body at 4.5MB
// regardless of runtime, so a real brochure PDF can never pass through
// this function itself.
//
// Phase 2 (finish) — { property_id, property_title, drive_file_id, to,
// subject, body_text } — drive_file_id is the `id` Google returned from
// that PUT. Fetches the finished upload back from Drive server-side (an
// outbound fetch, not subject to the inbound cap) and emails it as an
// attachment.
//
// Response: { success: true, ... } or { success: false, error, step }
// where step is one of drive_init|drive_fetch|email|whatsapp.

async function openDriveSession(accessToken, filename, drive_folder_id) {
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/pdf'
    },
    body: JSON.stringify({ name: String(filename), parents: [String(drive_folder_id)] })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error ? data.error.message : `Drive session init failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const uploadUrl = res.headers.get('location');
  if (!uploadUrl) throw new Error('Drive did not return a resumable upload URL');
  return uploadUrl;
}

async function handleInit(db, body) {
  const { property_id, drive_folder_id, filename } = body;
  if (!property_id || !drive_folder_id || !filename) {
    return fail('validation', 'Missing required field (property_id, drive_folder_id, filename)', 400);
  }
  if (!/\.pdf$/i.test(String(filename))) {
    return fail('validation', 'filename must end in .pdf', 400);
  }

  try {
    let uploadUrl;
    try {
      uploadUrl = await openDriveSession(await getDriveAccessToken(true), filename, drive_folder_id);
    } catch (e) {
      // Not visible to the impersonated Workspace user — retry as the bare
      // service account, which can access anything explicitly shared with
      // its own address regardless of which Google account owns it.
      if (e.status !== 404 && e.status !== 403) throw e;
      uploadUrl = await openDriveSession(await getDriveAccessToken(false), filename, drive_folder_id);
    }
    return json({ success: true, upload_url: uploadUrl });
  } catch (e) {
    console.error('brochure init: failed:', e);
    return fail('drive_init', String(e.message || e), 502);
  }
}

async function fetchDriveFile(accessToken, drive_file_id) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(drive_file_id)}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error ? data.error.message : `Fetching uploaded file from Drive failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

async function handleFinish(db, body) {
  const { property_id, property_title, drive_file_id, to, subject, body_text } = body;
  if (!property_id || !property_title || !drive_file_id || !to || !subject || !body_text) {
    return fail('validation', 'Missing required field (property_id, property_title, drive_file_id, to, subject, body_text)', 400);
  }

  let accessToken;
  let fileBuffer;
  try {
    // If init fell back to the bare service account (folder not visible to
    // the impersonated user), the uploaded file lives under that same
    // identity — the impersonated fetch below would 403/404 on it too, so
    // this mirrors init's fallback rather than assuming impersonation works.
    try {
      accessToken = await getDriveAccessToken(true);
      fileBuffer = await fetchDriveFile(accessToken, drive_file_id);
    } catch (e) {
      if (e.status !== 404 && e.status !== 403) throw e;
      accessToken = await getDriveAccessToken(false);
      fileBuffer = await fetchDriveFile(accessToken, drive_file_id);
    }
    if (fileBuffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('Uploaded file is not a valid PDF');
    }
  } catch (e) {
    console.error('brochure finish: drive fetch failed:', e);
    await logBrochureCall(db, { property_id, step: 'drive_fetch', success: false, error: String(e.message || e) });
    return fail('drive_fetch', String(e.message || e), 502);
  }

  await makeDriveFilePublic(accessToken, drive_file_id);
  const drive_file_url = `https://drive.google.com/file/d/${drive_file_id}/view`;

  let email_sent = false;
  let emailError = null;
  try {
    const fullBody = `${body_text}\n\nBrochure: ${drive_file_url}`;
    const r = await sendEmail(String(to), String(subject), fullBody, null, [
      { filename: `${property_id}_brochure.pdf`, content: fileBuffer, contentType: 'application/pdf' }
    ]);
    email_sent = !!r.ok;
    if (!r.ok) emailError = r.error;
  } catch (e) {
    emailError = String(e.message || e);
  }

  await logBrochureCall(db, {
    property_id, property_title, drive_file_id, drive_file_url,
    email_sent, email_error: emailError, whatsapp_sent: false
  });

  if (!email_sent) {
    return fail('email', emailError || 'Email send failed', 502, { drive_file_id, drive_file_url });
  }

  return json({ success: true, drive_file_id, drive_file_url, email_sent: true, whatsapp_sent: false });
}

// Phase 3 (alert) — { alert: true, scheduler, reason, impact, property_id?,
// to } — a plain no-attachment email used by the Mac scheduler to report a
// run that failed or a brochure it could not deliver. It lives here rather
// than in its own route only because Vercel's Hobby plan caps a deployment
// at 12 Serverless Functions and this deployment is already at 11.
async function handleAlert(db, body) {
  const { scheduler, reason, impact, property_id, to } = body;
  if (!scheduler || !reason || !to) {
    return fail('validation', 'Missing required field (scheduler, reason, to)', 400);
  }

  const subjectTarget = property_id ? ` — ${property_id}` : '';
  const subject = `[FAILED] ${scheduler}${subjectTarget}`;
  const bodyText = [
    `Scheduler: ${scheduler}`,
    property_id ? `Property:  ${property_id}` : null,
    `Time:      ${new Date().toISOString()}`,
    '',
    'Reason',
    '------',
    String(reason),
    '',
    'Impact',
    '------',
    String(impact || 'Not specified.'),
    '',
    'This is an automated alert from the 3PIN brochure pipeline. It is sent',
    'once per distinct failure, not once per run, so a recurring problem will',
    'not flood this inbox — but it also will not repeat itself as a reminder.'
  ].filter(l => l !== null).join('\n');

  let sent = false;
  let emailError = null;
  try {
    const r = await sendEmail(String(to), subject, bodyText, null, null);
    sent = !!r.ok;
    if (!r.ok) emailError = r.error;
  } catch (e) {
    emailError = String(e.message || e);
  }

  await logBrochureCall(db, {
    property_id: property_id || '(run-level)',
    step: 'alert',
    success: sent,
    error: emailError,
    detail: `${scheduler}: ${reason}`
  }).catch(() => {});

  if (!sent) return fail('email', emailError || 'Alert email send failed', 502);
  return json({ success: true, alert_sent: true });
}

// ── The team's brochure log ─────────────────────────────────────────────
// Every Create brochure submission from the dashboard, as a short entry: the title, who sent it
// and when — never the details or internal notes. Shared by the whole team, read on the Create
// brochure page. Signed-in CRM users only (Firebase ID token), unlike the scheduler routes below
// which use the shared secret.
const LOG = 'brochureLog';
async function logPost(request) {
  const user = await verifyCrmUser(request);
  if (!user || !user.tenantId) return json({ ok: false, error: 'Unauthorized' }, 401);
  let body = {};
  try { body = await request.json(); } catch { /* checked below */ }
  const title = String((body && body.title) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!title) return json({ ok: false, error: 'title required' }, 400);
  const entry = { tenantId: user.tenantId, title, by: String(user.email || '').toLowerCase() || null, at: Date.now(), source: 'dashboard' };
  const ref = await getDb().collection(LOG).add(entry);
  return json({ ok: true, entry: { id: ref.id, ...entry } });
}
// Where each request stands, from the intake Queue sheet the brochure scheduler works through:
// Status blank = queued, "Done" = generated, "Brochure Emailed: Yes - <time> - <link>" =
// delivered, "Error - …" = needs a person. Read-only; matched to a log entry by the sheet's own
// timestamp, else by Property ID (the first word of the title) on or after the entry's time.
const QUEUE_RANGE = "'Form Responses 1'!A1:I2000";
const istStamp = s => {
  const m = String(s || '').match(/^(\d+)\/(\d+)\/(\d{4}) (\d+):(\d+):(\d+)$/);
  return m ? Date.parse(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}:${m[6]}+05:30`) : null;
};
const pidOf = t => String(t || '').trim().split(/\s+/)[0].toUpperCase();
function statusOf(statusCell, emailedCell) {
  const st = String(statusCell || '').trim(), em = String(emailedCell || '').trim();
  if (/^error/i.test(st)) return { state: 'error', label: 'Needs attention', detail: st.replace(/^error\s*[-:–]\s*/i, '').slice(0, 220) };
  if (/^yes/i.test(em)) {
    const at = (em.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/) || [])[0];
    const link = (em.match(/https?:\/\/\S+/) || [])[0] || null;
    return { state: 'delivered', label: 'Delivered', deliveredAt: at ? Date.parse(at) : null, link };
  }
  if (/^done/i.test(st)) return { state: 'generated', label: 'Generated — being sent' };
  return { state: 'queued', label: 'In queue' };
}
async function queueStatus() {
  try {
    const token = await getSheetsToken(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${QUEUE_SHEET_ID}/values/${encodeURIComponent(QUEUE_RANGE)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const rows = (await res.json()).values || [];
    const norm = (rows[0] || []).map(h => String(h || '').trim().toLowerCase().replace(/\s+/g, ' '));
    const col = (pfx, exact) => norm.findIndex(h => exact ? h === pfx : h.startsWith(pfx));
    const c = { at: col('timestamp', true), title: col('property id'), status: col('status', true), emailed: col('brochure emailed') };
    if (c.title < 0 || c.status < 0) return null;
    return rows.slice(1).map(r => ({ at: istStamp(r[c.at]), pid: pidOf(r[c.title]), ...statusOf(r[c.status], c.emailed >= 0 ? r[c.emailed] : '') }));
  } catch (e) {
    console.error('brochure log: Queue sheet unreadable', e);
    return null;
  }
}

async function logList(request) {
  const user = await verifyCrmUser(request);
  if (!user || !user.tenantId) return json({ ok: false, error: 'Unauthorized' }, 401);
  // Newest first by the single-field index on `at`; the tenant is checked on the way out.
  const [snap, queue] = await Promise.all([getDb().collection(LOG).orderBy('at', 'desc').limit(120).get(), queueStatus()]);
  const entries = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(e => e.tenantId === user.tenantId).slice(0, 60)
    .map(({ tenantId, ...e }) => {
      if (!queue) return e;
      // The sheet row this entry became: same second (loaded from the sheet), else the first row
      // for the same Property ID submitted from a minute before the entry onwards.
      const row = queue.find(q => q.at && Math.abs(q.at - e.at) < 1000)
        || queue.filter(q => q.pid && q.pid === pidOf(e.title) && q.at >= e.at - 60000).sort((a, b) => a.at - b.at)[0];
      // A submission the Form has not written to the sheet yet is simply queued.
      return { ...e, status: row ? { state: row.state, label: row.label, at: row.deliveredAt || null, detail: row.detail || null, link: row.link || null } : { state: 'queued', label: 'In queue' } };
    });
  return json({ ok: true, entries, sheet: !!queue });
}

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get('op') === 'log') return logList(request);
  return json({ ok: false, error: 'Unknown op' }, 404);
}

export async function POST(request) {
  if (new URL(request.url).searchParams.get('op') === 'log') return logPost(request);
  if (!checkAuth(request)) return fail('auth', 'Unauthorized', 401);

  const db = getDb();
  const withinLimit = await checkRateLimit(db, 'brochure').catch(() => true);
  if (!withinLimit) return fail('validation', 'Rate limit exceeded, try again shortly', 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('validation', 'Invalid JSON body', 400);
  }
  if (!body || typeof body !== 'object') return fail('validation', 'Invalid JSON body', 400);

  if (body.alert) return handleAlert(db, body);
  return body.drive_file_id ? handleFinish(db, body) : handleInit(db, body);
}
