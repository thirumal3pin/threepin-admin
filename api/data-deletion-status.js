import { getDb } from './_bot-shared.js';

// The human-facing page Meta redirects users to after a data deletion
// request — the URL returned by api/data-deletion-callback.js.
//
// The id comes from the link, so it is untrusted: only a real confirmation code (24 hex characters,
// crypto.randomBytes(12) in the callback) is looked up, and nothing from the request or the store
// is ever written into the page unescaped — this page is served from the admin's own origin, where
// a script would run with the team's sign-in.
const CODE = /^[a-f0-9]{24}$/;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (code, label, status = 200) => new Response(`<!doctype html><html><head><meta charset="UTF-8"><title>Data Deletion Status</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#1c1917;">
<h2>Data Deletion Request</h2>
${code ? `<p>Confirmation code: <code>${esc(code)}</code></p>` : ''}
<p>Status: <strong>${esc(label)}</strong></p>
</body></html>`, { status, headers: {
  'Content-Type': 'text/html; charset=utf-8',
  // No script of any kind on this page.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff'
} });

export async function GET(request) {
  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').trim().toLowerCase();
  if (!id) return page('', 'Missing confirmation code', 400);
  if (!CODE.test(id)) return page('', 'Not a valid confirmation code', 400);

  const db = getDb();
  const snap = await db.collection('dataDeletionRequests').doc(id).get();
  const status = snap.exists ? snap.data().status : 'not_found';
  const label = status === 'completed' ? 'Completed' : status === 'not_found' ? 'Not found' : String(status || 'Pending');
  return page(id, label);
}
