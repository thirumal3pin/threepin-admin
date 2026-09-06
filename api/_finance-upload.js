// Google Drive attachment storage for the finance module. Reached through api/finance.js
// (?task=upload); see that file for why the two share a route.
//
// Two ways in, chosen by size on the client:
//
//   action=put   — the bytes come THROUGH this function and go to Drive as one multipart
//                  request. Simple and the browser never talks to Google, so no CORS. Capped by
//                  Vercel's 4.5MB request-body limit, which is why the client compresses photos
//                  first: a phone picture that was 6MB arrives here at a few hundred KB.
//
//   action=init  — for anything still too large after that (a long scanned PDF). Opens a Google
//                  resumable-upload session and hands the browser its URL to PUT the bytes to
//                  directly. The session is opened WITH the browser's Origin, because Google binds
//                  a resumable session to the origin named when it is created; without it the
//                  browser's PUT is refused by CORS — which is exactly how the first version of
//                  this failed, silently, after the journal entry had already committed.
//
// Files are filed as {financial year}/{entry id} under the folder configured in Settings.
// That folder IS the finance root, not its parent, so this code can never create or touch
// anything among the property folders beside it.

import { verifyCrmUser, getDb } from './_bot-shared.js';
import { getDriveAccessToken, makeDriveFilePublic, json, fail } from './_brochure-shared.js';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_PROXY_BYTES = 4 * 1024 * 1024;
const FIELDS = 'id,name,mimeType,webViewLink,webContentLink';

// Drive's query language has no parameter binding, so a name containing a quote would break
// out of the q= expression. Escaping backslashes and single quotes is what Google documents.
const q = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const okType = t => /^image\//.test(t || '') || t === 'application/pdf';

// The link the Transactions drawer shows as a preview. Works for anyone-with-link files,
// which makeDriveFilePublic sets — same visibility the brochure PDFs already have.
const thumbOf = id => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w600`;

async function driveFetch(token, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  if (res.status === 204) return {};
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

async function ensurePath(token, rootId, fy, txnId) {
  const year = await ensureFolder(token, String(fy || 'unfiled'), rootId);
  return ensureFolder(token, String(txnId || 'unfiled'), year);
}

// The folder id lives on the finance settings document so it can be changed from the
// Settings screen without a redeploy. The environment variable stays as a fallback.
async function resolveRootFolder(tenantId) {
  try {
    const snap = await getDb().collection('finance').doc(tenantId).get();
    const configured = snap.exists ? snap.data().driveFolderId : null;
    if (configured) return String(configured).trim();
  } catch (e) {
    console.error('finance-upload: could not read settings:', e);
  }
  return process.env.FINANCE_DRIVE_FOLDER_ID || null;
}

// Metadata and bytes in one request. Node's fetch takes a Uint8Array body as-is.
async function multipartUpload(token, { name, mimeType, bytes, folderId }) {
  const boundary = 'fin-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name: String(name), parents: [String(folderId)] });
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([head, Buffer.from(bytes), tail]);
  const res = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=${FIELDS}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Drive upload failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function openSession(token, { fileName, mimeType, folderId, origin }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': mimeType || 'application/octet-stream',
  };
  // Google ties the session to this origin and answers the browser's later PUT with the
  // matching Access-Control-Allow-Origin. Leave it out and the PUT is refused.
  if (origin) headers.Origin = origin;
  const res = await fetch(`${DRIVE_UPLOAD}?uploadType=resumable&fields=${FIELDS}`, {
    method: 'POST', headers,
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

// Only ever echo an origin we would serve the page from. Anything else is dropped rather
// than forwarded, so a forged Origin cannot mint a session bound to a stranger's site.
function trustedOrigin(request) {
  const o = request.headers.get('origin') || '';
  if (/^https:\/\/([a-z0-9-]+\.)*threepin\.in$/i.test(o)) return o;
  if (/^https:\/\/[a-z0-9-]+-3pin-admin\.vercel\.app$/i.test(o)) return o;
  if (/^http:\/\/localhost(:\d+)?$/i.test(o)) return o;
  return null;
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

function describe(meta) {
  return {
    success: true,
    fileId: meta.id,
    name: meta.name,
    type: meta.mimeType,
    url: meta.webViewLink,
    download: meta.webContentLink,
    thumb: thumbOf(meta.id),
  };
}

export async function uploadPost(request) {
  const user = await verifyCrmUser(request);
  if (!user) return fail('auth', 'Not signed in', 401);
  if (!user.tenantId) return fail('auth', 'This account has no tenant assigned', 403);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  const rootId = await resolveRootFolder(user.tenantId);
  if (!rootId) {
    return fail('config',
      'No Drive folder is configured for finance attachments. Set the folder id in Settings → Attachments.',
      400);
  }

  try {
    // ── Bytes through this function ──────────────────────────────────────────────
    if (action === 'put') {
      const name = url.searchParams.get('name') || 'attachment';
      const type = url.searchParams.get('type') || request.headers.get('content-type') || '';
      const txnId = url.searchParams.get('txnId');
      const fy = url.searchParams.get('fy');
      if (!okType(type)) return fail('validation', 'Only photos and PDFs can be attached', 400);

      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.length) return fail('validation', 'The file was empty', 400);
      if (bytes.length > MAX_PROXY_BYTES) {
        return fail('validation', 'File is over 4 MB — please use a smaller photo or a shorter PDF', 413);
      }

      const meta = await withDrive(async token => {
        const folderId = await ensurePath(token, rootId, fy, txnId);
        const m = await multipartUpload(token, { name, mimeType: type, bytes, folderId });
        await makeDriveFilePublic(token, m.id);
        return m;
      });
      return json(describe(meta));
    }

    // Everything below carries a JSON body.
    let body;
    try { body = await request.json(); }
    catch { return fail('validation', 'Body must be JSON', 400); }

    // ── Resumable session, for files too large to proxy ──────────────────────────
    if (body.action === 'init') {
      const { fileName, mimeType, txnId, fy } = body;
      if (!fileName) return fail('validation', 'fileName is required', 400);
      if (!okType(mimeType)) return fail('validation', 'Only photos and PDFs can be attached', 400);
      const origin = trustedOrigin(request);
      const sessionUrl = await withDrive(async token => {
        const folderId = await ensurePath(token, rootId, fy, txnId);
        return openSession(token, { fileName, mimeType, folderId, origin });
      });
      return json({ success: true, sessionUrl });
    }

    if (body.action === 'finish') {
      const { fileId } = body;
      if (!fileId) return fail('validation', 'fileId is required', 400);
      return withDrive(async token => {
        await makeDriveFilePublic(token, fileId);
        const meta = await driveFetch(token, `${DRIVE_FILES}/${encodeURIComponent(fileId)}?fields=${FIELDS}`);
        return json(describe(meta));
      });
    }

    if (body.action === 'delete') {
      const { fileId } = body;
      if (!fileId) return fail('validation', 'fileId is required', 400);
      await withDrive(token => driveFetch(token,
        `${DRIVE_FILES}/${encodeURIComponent(fileId)}`, { method: 'DELETE' })
        .catch(e => { if (e.status !== 404) throw e; }));
      return json({ success: true });
    }

    return fail('validation', 'Unknown action — expected put, init, finish or delete', 400);
  } catch (e) {
    console.error('finance-upload failed:', e);
    return fail('drive', String(e.message || e), 502);
  }
}
