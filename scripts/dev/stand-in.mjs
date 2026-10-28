// Local dev only: a stand-in for Claude when there is no ANTHROPIC_API_KEY (scripts/easy-dev.mjs).
// Keyword rules pick the same tools Claude would, so every Eåsy card and flow can be clicked
// through locally; the words of the answers are plain. Every reply says it is the stand-in.

const CODE = /\b([a-z]{3}\s?\d{3})\b/i;
const tag = '(stand-in — add ANTHROPIC_API_KEY to .env.local for real answers)';
let n = 0;
const use = (...calls) => ({ stop_reason: 'tool_use', content: calls.map(([name, input]) => ({ type: 'tool_use', id: 'si' + (++n), name, input })) });
const say = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: text + '\n\n' + tag }] });

function lastQuestion(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}
// The tool results of this question so far, in order: [{ name, input, v }]
function done(messages) {
  const out = [];
  let i = messages.length - 1;
  while (i >= 0 && !(messages[i].role === 'user' && typeof messages[i].content === 'string')) i--;
  for (let j = i + 1; j < messages.length - 1; j += 2) {
    const calls = (messages[j].content || []).filter(b => b.type === 'tool_use');
    const res = messages[j + 1] ? messages[j + 1].content : [];
    calls.forEach((c, k) => { let v; try { v = JSON.parse(res[k].content); } catch (e) { v = { error: res[k] && res[k].content }; } out.push({ name: c.name, input: c.input, v }); });
  }
  return out;
}

function money(s) {
  const m = String(s).match(/(\d+(?:\.\d+)?)\s*(l|lakh|lakhs|lac|cr|crore|crores)\b/i);
  return m ? `${m[1]} ${/^c/i.test(m[2]) ? 'Cr' : 'L'}` : null;
}

function first(q) {
  const s = q.toLowerCase();
  let m;
  if ((m = q.match(/call notes for .*?\[lead:([^\]\s]+)\]:\s*([\s\S]*?)(\n\(Prepare|$)/i))) return use(['propose_note', { lead_id: m[1], text: m[2].trim(), call: true }]);
  if (/^add\b/i.test(q)) {
    const fields = {};
    if ((m = q.match(/(\d)\s?bhk/i))) fields.config = m[1] + 'BHK';
    if ((m = q.match(/\bin ([a-z][a-z ]+?)(,|\.| for| at| price|\d|$)/i))) fields.location = m[1].trim().replace(/\b\w/g, c => c.toUpperCase());
    if (money(q)) fields.startingPrice = money(q);
    if ((m = q.match(/owner\s+([a-z]+)/i))) fields.contactName = m[1].replace(/^\w/, c => c.toUpperCase());
    if ((m = q.match(/(\+?\d[\d\s-]{8,}\d)/))) fields.contactNumber = m[1].trim();
    if (/villa/i.test(q)) fields.type = 'Villa'; else if (/plot/i.test(q)) fields.type = 'Plot'; else if (fields.config) fields.type = 'Apartment';
    return use(['propose_property_add', { fields }]);
  }
  if ((m = q.match(CODE)) && /(price|is now|on hold|sold|available|facing)/i.test(q)) {
    const changes = {};
    if (/on hold/i.test(q)) changes.availability = 'On hold';
    else if (/sold/i.test(q)) changes.availability = 'Sold';
    if (/price/i.test(q) && money(q)) changes.startingPrice = '₹' + money(q);
    return use(['propose_property_update', { code: m[1], changes }]);
  }
  if (/team|overview|everyone/.test(s)) return use(['team_overview', {}]);
  if (/seller summar|owner update|weekly/.test(s)) return use(['seller_summaries', (m = q.match(CODE)) ? { code: m[1] } : {}]);
  if (/brochure/.test(s) && (m = q.match(CODE))) return use(['brochure', { code: m[1] }]);
  if (/match|buyers for|who fits/.test(s) && (m = q.match(CODE))) return use(['match_buyers', { code: m[1] }]);
  if (/missing/.test(s) && (m = q.match(CODE))) return use(['property_summary', { code: m[1] }]);
  if (/missing/.test(s)) return use(['search_properties', { query: '' }]);
  if (/cold/.test(s)) return use(['search_leads', { cold_days: 7 }]);
  if (/day|plan|what should i do|follow up today|follow-up today/.test(s)) return use(['my_day', {}]);
  if ((m = q.match(CODE))) return use(['property_summary', { code: m[1] }]);
  if ((m = q.match(/(?:summary of|about|draft .*? to|message to|follow.?up (?:to|with))\s+([a-z][a-z ]*)/i))) return use(['search_leads', { query: m[1].trim().split(' ')[0] }]);
  return null;
}

function next(q, history) {
  const last = history[history.length - 1];
  const s = q.toLowerCase();
  if (last.name === 'search_leads' && !last.v.error) {
    const ls = last.v.leads || [];
    if (/cold/.test(s)) {
      const pick = ls.slice(0, 3);
      if (!pick.length) return say('Nobody has gone cold — every open lead was touched in the last 7 days.');
      if (history.length === 1) return use(...pick.map(l => ['draft_message', { to: 'lead', lead_id: l.id, text: `Hi ${String(l.name || '').split(' ')[0]}, this is 3 PIN Realty — just checking in on your search${l.propertyInterest ? ' for a ' + l.propertyInterest : ''}. Shall I share a few new options this week?` }]));
    }
    if (ls.length > 1 && !/draft|message|follow/.test(s)) return say('Which one?\n' + ls.slice(0, 5).map(l => `• ${l.name} — ${l.propertyInterest || ''} [lead:${l.id}]`).join('\n'));
    if (ls.length && /draft|message|follow/.test(s)) return use(['draft_message', { to: 'lead', lead_id: ls[0].id, text: `Hi ${String(ls[0].name || '').split(' ')[0]}, this is 3 PIN Realty following up on your enquiry${ls[0].propertyInterest ? ' for a ' + ls[0].propertyInterest : ''}. When is a good time to talk?` }]);
    if (ls.length) return use(['lead_summary', { id: ls[0].id }]);
    return say('No lead matches that.');
  }
  if (last.name === 'search_properties' && /missing/.test(s) && history.length === 1) {
    return use(...(last.v.properties || []).slice(0, 4).map(p => ['property_summary', { code: p.code }]));
  }
  if (last.name === 'property_summary' && /ask|request|chase/.test(s) && !last.v.error && last.v.missing && last.v.missing.length && history.length === 1) {
    return use(['ask_owner_for_missing', { code: last.v.code, fields: last.v.missing, text: `Hello ${last.v.ownerName || ''}, this is 3 PIN Realty about your property ${last.v.name || last.v.code}. Could you please share: ${last.v.missing.join(', ')}? Thank you!` }]);
  }
  if (last.name === 'brochure' && /send|share/.test(s) && last.v.brochure && history.length === 1) return null;
  return 'answer';
}

function answer(history) {
  const lines = [];
  for (const { name, v } of history) {
    if (v && v.error) { lines.push('⚠ ' + v.error); continue; }
    switch (name) {
      case 'my_day': lines.push(`Your day — ${v.plan.length} things:`, ...v.plan.slice(0, 12).map(p => `• ${p.time} — ${p.title}${p.leadId ? ` [lead:${p.leadId}]` : ''}`)); break;
      case 'lead_summary': lines.push(`**${v.name}** — ${v.propertyInterest || ''}${v.budget ? ', budget ' + v.budget : ''} [lead:${v.id}]`, `Stage: ${v.stage || '—'} · last contact ${v.lastContact || '—'}${v.heat ? ' · ' + v.heat : ''}`,
        v.siteVisit ? 'Visit: ' + v.siteVisit : null, v.notes && v.notes[0] ? 'Last note: ' + v.notes[0].text : null,
        v.matchedProperties && v.matchedProperties.length ? 'Matches: ' + v.matchedProperties.map(m => `${m.code} (${m.match})`).join(', ') : null); break;
      case 'property_summary': lines.push(`**${v.code}** ${v.name || ''} — ${v.config || ''} ${v.location || ''}, ${v.price || '—'} · ${v.completeness} complete${v.missing.length ? ' · missing: ' + v.missing.join(', ') : ''}${v.siteVisits.length ? ` · ${v.siteVisits.length} visit(s)` : ''}`); break;
      case 'match_buyers': lines.push(`Buyers for ${v.property.code}:`, ...(v.matches.length ? v.matches.map(m => `• ${m.name} ${m.match} — ${m.why[0] || ''} [lead:${m.id}]`) : ['• no strong matches']),
        ...(v.nearMatches.length ? ['Near matches:', ...v.nearMatches.map(m => `• ${m.name} ${m.match} [lead:${m.id}]`)] : [])); break;
      case 'search_properties': lines.push(`${v.total} properties.`); break;
      case 'draft_message': case 'ask_owner_for_missing': lines.push(`Drafted a message to ${v.to} — check it and tap Send.`); break;
      case 'propose_property_add': case 'propose_property_update': case 'propose_note': lines.push('Prepared — check the card and tap Yes to save.'); break;
      case 'brochure': lines.push(v.brochure ? `Brochure for ${v.code} below.` : `${v.code} has no brochure yet.`); break;
      case 'seller_summaries': lines.push(v.none || `Drafted ${v.properties.filter(p => p.drafted).length} owner update(s): ${v.properties.map(p => `${p.code} (${p.visits} visit${p.visits === 1 ? '' : 's'})`).join(', ')}.`); break;
      case 'team_overview': lines.push('Team today:', ...v.agents.map(a => `• ${a.agent}: ${a.visitsToday} visits, ${a.followUpsToday} follow-ups, ${a.messagesThisWeek.sent}/${a.messagesThisWeek.drafted} messages sent this week`)); break;
      case 'search_leads': lines.push(`${v.total} leads.`); break;
      default: lines.push('Done.');
    }
  }
  return say(lines.filter(Boolean).join('\n'));
}

export const standIn = {
  messages: { create: async req => {
    const q = lastQuestion(req.messages);
    const history = done(req.messages);
    if (!history.length) return first(q) || say('I can do (in this stand-in): "What is my day?", "Who went cold?", "Summary of Shiva", "Who matches MED001?", "What is missing on MED001?", "Ask the owner of MED001 for the missing details", "Brochure for MED001", "Add a 2BHK in Velachery, 72 lakhs, owner Rajan 98400 12345", "MED001 price is now 1.3 Cr", "Seller summaries", "Team overview", and Log call.');
    const r = next(q, history);
    return r === 'answer' || r == null ? answer(history) : r;
  } }
};
