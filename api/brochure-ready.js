import { getDb, sendEmail } from './_bot-shared.js';
import { json, fail, checkAuth, checkRateLimit, getDriveAccessToken, makeDriveFilePublic, logBrochureCall } from './_brochure-shared.js';

// Step 2 of 2 for brochure delivery — called after the pipeline has PUT the
// PDF straight to the resumable upload_url from POST /api/brochure-upload-init
// (see that file for why the upload itself doesn't come through here).
//
// POST body (JSON): { property_id, property_title, drive_file_id, to,
// subject, body_text }. drive_file_id is the `id` Google returned from the
// PUT to upload_url.
//
// Response: { success: true, drive_file_id, drive_file_url, email_sent,
// whatsapp_sent } — or { success: false, error, step } where step is one
// of drive_fetch|email|whatsapp.

export async function POST(request) {
  if (!checkAuth(request)) return fail('auth', 'Unauthorized', 401);

  const db = getDb();
  const withinLimit = await checkRateLimit(db, 'brochure-ready').catch(() => true);
  if (!withinLimit) return fail('validation', 'Rate limit exceeded, try again shortly', 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('validation', 'Invalid JSON body', 400);
  }

  const { property_id, property_title, drive_file_id, to, subject, body_text } = body || {};
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
    console.error('brochure-ready: drive fetch failed:', e);
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
