// Google Drive attachment storage for the finance module — the fallback for when Firebase
// Storage is not enabled on the project. Settings → Attachments switches between the two;
// this endpoint is only reached when it is set to 'drive'.
//
// Same two-phase shape as api/brochure.js, and for the same reason: Vercel hard-caps every
// Function's request body at 4.5MB, so a photographed bill can't be POSTed through here.
// 'init' hands back a one-time Google resumable-upload URL, the browser PUTs the bytes
// straight to Google (never touching Vercel), then 'finish' makes the file readable and
// returns its links.
//
// Unlike the brochure flow, the folder is not pre-existing: finance files are filed under
// "3PIN Finance / {FY} / {txnId}", so this creates each level on demand. That folder helper
// does not exist anywhere else in the repo — brochures always upload into a folder whose id
// came from an already-shared Drive URL.

import { verifyCrmUser } from './_bot-shared.js';
import { getDriveAccessToken, makeDriveFilePublic, json, fail } from './_brochure-shared.js';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Drive's query language has no parameter binding, so a name containing a quote would break
// out of the q= expression. Escaping backslashes and single quotes is what Google documents.
const q = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function driveFetch(token, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Drive request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function findFolder(token, name, parentId) {
  const query = `name='${q(name)}' and mimeType='${FOLDER_MIME}' and '${q(parentId)}' in parents and trashed=false`;
  const data = await driveFetch(token,
    `${DRIVE_FILES}?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1`);
  return data.files?.[0]?.id || null;
}

async function ensureFolder(token, name, parentId) {
  const existing = await findFolder(token, name, parentId);
  if (existing) return existing;
  const created = await driveFetch(token, `${DRIVE_FILES}?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: String(name), mimeType: FOLDER_MIME, parents: [String(parentId)] }),
  });
  return created.id;
}

// "3PIN Finance / {FY} / {txnId}" under the operator-configured root.
async function ensurePath(token, rootId, fy, txnId) {
  const base = await ensureFolder(token, '3PIN Finance', rootId);
  const year = await ensureFolder(token, String(fy || 'unfiled'), base);
  return ensureFolder(token, String(txnId || 'unfiled'), year);
}

async function openSession(token, fileName, mimeType, folderId) {
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink,webContentLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType || 'application/octet-stream',
      },
      body: JSON.stringify({ name: String(fileName), parents: [String(folderId)] }),
    });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error?.message || `Drive session init failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const url = res.headers.get('location');
  if (!url) throw new Error('Drive did not return a resumable upload URL');
  return url;
}

// Impersonated first (a bare service account has no upload quota of its own), falling back to
// the service account's own identity for folders shared directly with its address — the same
// two-identity dance api/brochure.js does.
async function withDrive(run) {
  try {
    return await run(await getDriveAccessToken(true));
  } catch (e) {
    if (e.status !== 404 && e.status !== 403) throw e;
    return run(await getDriveAccessToken(false));
  }
}

export async function uploadPost(request) {
  const user = await verifyCrmUser(request);
  if (!user) return fail('auth', 'Not signed in', 401);
  if (!user.tenantId) return fail('auth', 'This account has no tenant assigned', 403);

  let body;
  try { body = await request.json(); }
  catch { return fail('validation', 'Body must be JSON', 400); }

  const rootId = process.env.FINANCE_DRIVE_FOLDER_ID;
  if (!rootId) {
    return fail('config',
      'FINANCE_DRIVE_FOLDER_ID is not set. Create a Drive folder for finance attachments, share it with the service account, and set its id as that environment variable — or switch Settings → Attachments back to Firebase Storage.',
      400);
  }

  try {
    if (body.action === 'init') {
      const { fileName, mimeType, txnId, fy } = body;
      if (!fileName) return fail('validation', 'fileName is required', 400);
      const ok = /^image\//.test(mimeType || '') || mimeType === 'application/pdf';
      if (!ok) return fail('validation', 'Only photos and PDFs can be attached', 400);

      const sessionUrl = await withDrive(async token => {
        const folderId = await ensurePath(token, rootId, fy, txnId);
        return openSession(token, fileName, mimeType, folderId);
      });
      return json({ success: true, sessionUrl });
    }

    if (body.action === 'finish') {
      const { fileId } = body;
      if (!fileId) return fail('validation', 'fileId is required', 400);
      return withDrive(async token => {
        await makeDriveFilePublic(token, fileId);
        const meta = await driveFetch(token,
          `${DRIVE_FILES}/${encodeURIComponent(fileId)}?fields=id,webViewLink,webContentLink,name`);
        return json({
          success: true,
          fileId: meta.id,
          webViewLink: meta.webViewLink,
          webContentLink: meta.webContentLink,
          name: meta.name,
        });
      });
    }

    if (body.action === 'delete') {
      const { fileId } = body;
      if (!fileId) return fail('validation', 'fileId is required', 400);
      await withDrive(token => driveFetch(token,
        `${DRIVE_FILES}/${encodeURIComponent(fileId)}`, { method: 'DELETE' })
        // A 204 has no JSON body, which driveFetch's json() parse turns into {} — fine.
        .catch(e => { if (e.status !== 404) throw e; }));
      return json({ success: true });
    }

    return fail('validation', 'Unknown action — expected init, finish or delete', 400);
  } catch (e) {
    console.error('finance-upload failed:', e);
    return fail('drive', String(e.message || e), 502);
  }
}
