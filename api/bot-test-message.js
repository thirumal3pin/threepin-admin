import Anthropic from '@anthropic-ai/sdk';
import { getDb, verifyCrmUser, buildSystemPrompt, UPDATE_LEAD_INFO_TOOL, getKnowledgeSources } from './_bot-shared.js';

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

export async function POST(request) {
  const user = await verifyCrmUser(request);
  if (!user) {
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

  try {
    const knowledge = await getKnowledgeSources(getDb());
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      system: buildSystemPrompt(config, knowledge),
      tools: [UPDATE_LEAD_INFO_TOOL],
      messages: history.map(m => ({ role: m.role, content: m.content }))
    });

    let reply = '';
    let extractedInfo = {};
    for (const block of response.content) {
      if (block.type === 'text') reply += block.text;
      if (block.type === 'tool_use' && block.name === 'update_lead_info') {
        extractedInfo = { ...extractedInfo, ...block.input };
      }
    }

    return new Response(JSON.stringify({ reply, extractedInfo }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('bot-test-message error:', e);
    return new Response(JSON.stringify({ error: 'Claude API error', message: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
