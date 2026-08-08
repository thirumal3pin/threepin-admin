import { getDb, sendEmail } from './_bot-shared.js';
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

async function handleInit(db, body) {
  const { property_id, drive_folder_id, filename } = body;
  if (!property_id || !drive_folder_id || !filename) {
    return fail('validation', 'Missing required field (property_id, drive_folder_id, filename)', 400);
  }
  if (!/\.pdf$/i.test(String(filename))) {
    return fail('validation', 'filename must end in .pdf', 400);
  }

  try {
    const accessToken = await getDriveAccessToken();
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
      throw new Error(data.error ? data.error.message : `Drive session init failed (${res.status})`);
    }
    const uploadUrl = res.headers.get('location');
    if (!uploadUrl) throw new Error('Drive did not return a resumable upload URL');
    return json({ success: true, upload_url: uploadUrl });
  } catch (e) {
    console.error('brochure init: failed:', e);
    return fail('drive_init', String(e.message || e), 502);
  }
}

async function handleFinish(db, body) {
  const { property_id, property_title, drive_file_id, to, subject, body_text } = body;
  if (!property_id || !property_title || !drive_file_id || !to || !subject || !body_text) {
    return fail('validation', 'Missing required field (property_id, property_title, drive_file_id, to, subject, body_text)', 400);
  }

  let accessToken;
  let fileBuffer;
  try {
    accessToken = await getDriveAccessToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(drive_file_id)}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ? data.error.message : `Fetching uploaded file from Drive failed (${res.status})`);
    }
    fileBuffer = Buffer.from(await res.arrayBuffer());
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

export async function POST(request) {
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

  return body.drive_file_id ? handleFinish(db, body) : handleInit(db, body);
}
