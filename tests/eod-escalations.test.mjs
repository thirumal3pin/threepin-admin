// The EOD report's escalation section: who escalated in the last 3 days, answered or not,
// and the older backlog. Pure — runs on hand-built leads.
//
//   node tests/eod-escalations.test.mjs

import { escalationMetrics } from '../api/dashboard-summary.js';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => { if (cond) pass++; else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); } };

const H = 3600000;
// 2 Oct 2026, 21:30 IST — when the report goes out.
const NOW = Date.parse('2026-10-02T16:00:00Z');
const lead = (name, tt) => ({ name, phone: '9000000000', tt: { category: 'sales', ...tt } });

const leads = [
  lead('Waiting today', { escalated: true, escalatedAt: NOW - 2 * H, escalationAsk: { at: NOW - 2 * H, text: 'Call me' }, latestAsk: { at: NOW - 1 * H, text: 'Hello?' } }),
  lead('Answered today', { escalated: true, escalatedAt: NOW - 5 * H, escalationReplyAt: NOW - 4 * H, lastHumanAt: NOW - 4 * H, lastHumanBy: 'agent.a@example.com' }),
  lead('Cleared today', { escalated: false, escalationClearedAt: NOW - 3 * H, lastEscalation: { at: NOW - 6 * H, replyAt: NOW - 3 * H }, lastHumanBy: 'agent.b@example.com' }),
  lead('Two days ago', { escalated: true, escalatedAt: NOW - 40 * H }),
  lead('A week ago', { escalated: true, escalatedAt: NOW - 8 * 24 * H }),
  lead('Before tracking, never answered', { escalated: true, escalatedAt: null }),
  lead('Before tracking, answered then', { escalated: true, escalatedAt: null, lastHumanAt: Date.parse('2026-09-15T10:00:00Z') }),
  lead('Cleared last week', { escalated: false, escalationClearedAt: NOW - 7 * 24 * H }),
  { name: 'Vendor', tt: { category: 'others', escalated: true, escalatedAt: NOW - H } },
  { name: 'Manual lead, no TailorTalk' }
];
const e = escalationMetrics(leads, NOW);
const names = rows => rows.map(r => r.lead.name);

ok('The last 3 days hold every escalation that started in them', JSON.stringify(names(e.today).sort()) === JSON.stringify(['Answered today', 'Cleared today', 'Two days ago', 'Waiting today'].sort()), JSON.stringify(names(e.today)));
ok('...not answered first, newest first', JSON.stringify(names(e.today).slice(0, 2)) === JSON.stringify(['Waiting today', 'Two days ago']), JSON.stringify(names(e.today)));
ok('Answered and not answered are counted', e.todayAnswered === 2 && e.todayWaiting === 2, `${e.todayAnswered}/${e.todayWaiting}`);
ok('A customer who wrote again after escalating is marked', e.today.find(r => r.lead.name === 'Waiting today').stillWriting === true);
ok('Who answered is named', e.today.find(r => r.lead.name === 'Answered today').by === 'agent.a@example.com');
ok('Median reply time is from escalation to the reply', e.medianReplyMsToday === 1 * H, String(e.medianReplyMsToday));
ok('Older unanswered escalations are the backlog', JSON.stringify(names(e.olderWaiting).sort()) === JSON.stringify(['A week ago', 'Before tracking, never answered']), JSON.stringify(names(e.olderWaiting)));
ok('Answered before clear-on-reply existed is "probably stale", not backlog', JSON.stringify(names(e.stale)) === JSON.stringify(['Before tracking, answered then']));
ok('A clear from last week is not in the report', !e.today.concat(e.olderAnswered).some(r => r.lead.name === 'Cleared last week'));
ok('Vendors are left out and counted', e.vendorsOpen === 1 && !e.today.some(r => r.lead.name === 'Vendor'));

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
