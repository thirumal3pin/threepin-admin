import Anthropic from '@anthropic-ai/sdk';
import { getDb, verifyCrmUser, buildSystemPrompt, UPDATE_LEAD_INFO_TOOL, getKnowledgeSources } from './_bot-shared.js';
import { easyPost, EASY_MODEL } from './_easy.js';

// Two jobs in one function (Hobby plan: 12 functions):
//   POST /api/bot-test-message  — the CRM's AI Bot "Live Test Chat": the draft bot workflow and the
//                                 Knowledge Base, answered by Claude, nothing written anywhere.
//   POST /api/easy              — Eåsy's ask box (rewritten here with ?op=easy, see vercel.json).
export const maxDuration = 60;

const MAX_TURNS = 3;          // a reply, plus at most two update_lead_info rounds before it
const MAX_HISTORY = 30;
const MAX_TEXT = 2000;

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

// The page sends { role, content } turns; keep only well-formed text, starting with the lead.
function cleanHistory(history) {
  const out = (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_TEXT) }));
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function testChatPost(request) {
  const user = await verifyCrmUser(request);
  if (!user || !user.tenantId) return json({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const config = body && body.config;
  const messages = cleanHistory(body && body.history);
  if (!config || typeof config !== 'object') return json({ error: 'Missing config' }, 400);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return json({ error: 'Send a message first' }, 400);

  try {
    const knowledge = await getKnowledgeSources(getDb(), user.tenantId);
    const system = buildSystemPrompt(config, knowledge);
    let extractedInfo = {};
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await getAnthropic().messages.create({
        model: EASY_MODEL,
        max_tokens: 4000,
        output_config: { effort: 'low' },
        system,
        tools: [UPDATE_LEAD_INFO_TOOL],
        messages
      });
      if (response.stop_reason === 'refusal') return json({ reply: '(The bot declined to answer that message.)', extractedInfo });
      const uses = response.content.filter(b => b.type === 'tool_use');
      for (const b of uses) if (b.name === 'update_lead_info') extractedInfo = { ...extractedInfo, ...(b.input || {}) };
      const reply = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      // Done once there is a reply and nothing left to record — the bot may record first and reply after.
      if (response.stop_reason !== 'tool_use') return json({ reply: reply || '(no reply)', extractedInfo });
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: uses.map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'Recorded.' })) });
    }
    return json({ reply: '(no reply)', extractedInfo });
  } catch (e) {
    console.error('bot-test-message error:', e);
    const status = e instanceof Anthropic.RateLimitError ? 429 : 502;
    return json({ error: status === 429 ? 'The bot is busy — try again in a minute' : 'The bot could not answer just now' }, status);
  }
}

export async function POST(request) {
  if (new URL(request.url).searchParams.get('op') === 'easy') return easyPost(request);
  return testChatPost(request);
}
