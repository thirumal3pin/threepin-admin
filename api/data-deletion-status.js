import { getDb } from './_bot-shared.js';

// The human-facing page Meta redirects users to after a data deletion
// request — the URL returned by api/data-deletion-callback.js.
export async function GET(request) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return new Response('Missing id', { status: 400 });

  const db = getDb();
  const snap = await db.collection('dataDeletionRequests').doc(id).get();
  const status = snap.exists ? snap.data().status : 'not_found';
  const label = status === 'completed' ? 'Completed' : status === 'not_found' ? 'Not found' : status;

  const html = `<!doctype html><html><head><meta charset="UTF-8"><title>Data Deletion Status</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#1c1917;">
<h2>Data Deletion Request</h2>
<p>Confirmation code: <code>${id}</code></p>
<p>Status: <strong>${label}</strong></p>
</body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
}
