import { verifyCrmUser } from './_bot-shared.js';
import { summarizeDeadReasons } from './_dashboard-ai-shared.js';

// Called on-demand ONLY when someone expands the Dashboard tab's "Moved to
// Dead Today" drill-down (see dashboardView.js) — never on tab open, never
// automatically. The lead data itself is already in the browser (loaded by
// the normal Firestore listener); this endpoint exists purely because the
// Anthropic API key can't live client-side. No Firestore read happens here.
export async function POST(request) {
  const user = await verifyCrmUser(request);
  if (!user || !user.tenantId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const items = Array.isArray(body && body.items)
    ? body.items.map(i => ({ id: i && i.id, note: i && i.note }))
    : [];

  const map = await summarizeDeadReasons(items);
  return new Response(JSON.stringify({ reasons: Object.fromEntries(map) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
