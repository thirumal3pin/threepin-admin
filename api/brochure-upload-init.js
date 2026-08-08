import { getDb } from './_bot-shared.js';
import { json, fail, checkAuth, checkRateLimit, getDriveAccessToken } from './_brochure-shared.js';

// Step 1 of 2 for brochure delivery. Opens a Google Drive resumable-upload
// session and hands back the one-time URL — the caller (the brochure
// pipeline's shell) then PUTs the PDF bytes straight to Google, never
// through this function, so Vercel's 4.5MB function body cap never comes
// into play. See api/_brochure-shared.js for why.
//
// POST body (JSON): { property_id, drive_folder_id, filename }
// Response: { success: true, upload_url } — PUT the raw PDF bytes to
// upload_url with Content-Type: application/pdf. Google's response to that
// PUT is the created file's { id, webViewLink } — pass id as drive_file_id
// to POST /api/brochure-ready next.

export async function POST(request) {
  if (!checkAuth(request)) return fail('auth', 'Unauthorized', 401);

  const db = getDb();
  const withinLimit = await checkRateLimit(db, 'brochure-upload-init').catch(() => true);
  if (!withinLimit) return fail('validation', 'Rate limit exceeded, try again shortly', 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('validation', 'Invalid JSON body', 400);
  }

  const { property_id, drive_folder_id, filename } = body || {};
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
    console.error('brochure-upload-init: failed:', e);
    return fail('drive_init', String(e.message || e), 502);
  }
}
