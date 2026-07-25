import { verifyCrmUser } from './_bot-shared.js';

// AI Bot test chat is intentionally disabled — ANTHROPIC_API_KEY stays set
// in Vercel but is reserved for a different upcoming feature on this site,
// not spent on bot replies. Re-wire this to call Claude again to restore it.
export async function POST(request) {
  const user = await verifyCrmUser(request);
  if (!user || !user.tenantId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), { status: 400 });
  }

  const { config, history } = body;
  if (!config || !Array.isArray(history)) {
    return new Response(JSON.stringify({ error: 'Missing config or history' }), { status: 400 });
  }

  return new Response(JSON.stringify({
    reply: "AI Bot replies are turned off right now — this token's being freed up for something else we're building. Turn it back on in api/bot-test-message.js when that's ready.",
    extractedInfo: {}
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
