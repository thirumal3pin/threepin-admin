// Sample data for Eåsy — the automated test (tests/easy.test.mjs) and the local dev server
// (scripts/easy-dev.mjs) both start from this. Everything is placed relative to `now`, so a fresh
// start always has a visit in about 1½ hours (the 2-hour reminder), one in about 10 minutes (the
// gist), a follow-up due, a lead going cold, an escalation and a visit earlier this week (the
// seller summary). Properties are the real inventory snapshot with codes like MED001 added.

import { readFileSync } from 'node:fs';
import { STAGE_DEFS } from '../../crm-assets/pipeline.js';

export const T = 't_3pinrealty';
export const AGENT = 'thirumal@threepin.in';          // a manager (task-model DEFAULT_MANAGERS)
export const AGENT2 = 'pradeep@threepin.in';
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export function easySeed(now = Date.now()) {
  const docs = {};
  const put = (path, data) => { docs[path] = data; };

  put('pipelines/' + T, { stages: STAGE_DEFS.map(d => ({ id: d.key, key: d.key, name: d.name, color: d.color })) });
  put('taskConfigs/' + T, { managers: [AGENT, 'swami@threepin.in'], viewers: {} });
  put('settings/' + T, {});
  // An account that is already set up: the CRM and dashboard add their own demo records otherwise.
  put('leadsSeededFlags/' + T, { done: true, at: now });
  put('easyConfig/' + T, { on: true, off: false, by: AGENT, at: now });      // Eåsy is off until an admin turns it on
  put('propertiesSeededFlags/' + T, { done: true, at: now });

  // ── Properties: the snapshot, with codes by area (MED001, POO002, …) ──
  const snap = JSON.parse(readFileSync(new URL('./properties-snapshot.json', import.meta.url), 'utf8'));
  const counts = {};
  const props = snap.map((p, i) => {
    const prefix = (String(p.location || 'XXX').split(',')[0].replace(/[^a-z]/gi, '').toUpperCase() + 'XXX').slice(0, 3);
    counts[prefix] = (counts[prefix] || 0) + 1;
    const code = prefix + String(counts[prefix]).padStart(3, '0');
    return { ...p, id: p.id, tenantId: T, propertyCode: code,
      photosLink: i % 3 ? 'https://drive.google.com/drive/folders/sample' + i : '',
      brochureLink: i % 4 === 0 ? 'https://drive.google.com/file/d/brochure' + i : '',
      mapLink: i % 2 ? 'https://maps.app.goo.gl/sample' + i : '' };
  });
  for (const p of props) put('properties/' + p.id, p);
  const byArea = area => props.find(p => String(p.location || '').toLowerCase().startsWith(area));
  const med = byArea('medavakkam'), mam = byArea('mambakkam'), poo = byArea('poonamallee'), thi = byArea('thiruvanmiyur');
  // One property the seller summary can talk about, with an owner on record.
  med.contactName = med.contactName || 'Rajan'; med.contactNumber = med.contactNumber || '98400 12345';

  // ── Leads ──
  const lead = (id, data, extra = {}) => {
    put('leads/' + id, { id, tenantId: T, source: 'whatsapp', createdAt: now - 10 * DAY, updatedAt: now - DAY, ...data });
    for (const [i, n] of (extra.notes || []).entries()) put(`leads/${id}/notes/n${i}`, { id: 'n' + i, by: AGENT, ...n });
    if (extra.chat) put(`leads/${id}/tailortalk/state`, { chat: extra.chat });
  };
  lead('L_shiva', { name: 'Shiva Kumar', phone: '98400 11111', propertyInterest: '3BHK in Poonamallee', budget: '1.5 Cr', stageId: 'options',
    followUpAt: now - 2 * HOUR, tt: { id: 'tt1', status: 'hot', lastMessageAt: now - 3 * HOUR } },
    { notes: [{ text: 'Liked the Poonamallee options, wants east facing.', createdAt: now - 2 * DAY }],
      chat: [{ role: 'user', content: 'Is the 3BHK in Poonamallee still available?' }, { role: 'assistant', content: 'Yes, shall I share details?' }, { role: 'user', content: 'Please send the brochure' }] });
  lead('L_priya', { name: 'Priya Ramesh', phone: '98765 43212', propertyInterest: '2BHK in Medavakkam', budget: '1.2 Cr', stageId: 'visit_pending',
    siteVisitAt: now + 95 * MIN, siteVisitStatus: 'scheduled', siteVisitProperty: med.propertyCode, siteVisitAgents: [AGENT] },
    { notes: [{ text: 'Wants a covered car park.', createdAt: now - DAY }] });
  lead('L_arun', { name: 'Arun Prakash', phone: '98765 43215', propertyInterest: 'Plot in Mambakkam', budget: '30 L', stageId: 'visit_pending',
    siteVisitAt: now + 9 * MIN, siteVisitStatus: 'scheduled', siteVisitProperty: mam.propertyCode, siteVisitAgents: [AGENT] },
    { notes: [{ text: 'Coming with his father. Asked about DTCP approval.', createdAt: now - DAY }] });
  lead('L_lakshmi', { name: 'Lakshmi Narayanan', phone: '98765 43214', propertyInterest: '4BHK in Thiruvanmiyur', budget: '5 Cr', stageId: 'options', updatedAt: now - 9 * DAY });
  lead('L_karthik', { name: 'Karthik Subramaniam', phone: '98765 43211', propertyInterest: '2BHK in Medavakkam', budget: '1.3 Cr', stageId: 'visit_done',
    siteVisitAt: now - 2 * HOUR - 0, siteVisitStatus: 'done', siteVisitProperty: med.propertyCode, siteVisitAgents: [AGENT] },
    { notes: [{ text: `Visited ${med.propertyCode} — liked the layout, felt the kitchen is small.`, createdAt: now - HOUR }] });
  lead('L_meena', { name: 'Meena Sundar', phone: '98765 43216', propertyInterest: `3BHK ${poo ? 'Poonamallee' : ''}`, budget: '1.4 Cr', stageId: 'negotiation',
    ai: { next: { owner: 'team', action: 'Send the revised price', dueAt: now - 5 * HOUR, setAt: now - DAY } }, updatedAt: now - 2 * DAY });
  lead('L_ravi', { name: 'Ravi Shankar', phone: '98765 43217', propertyInterest: '4BHK in Thiruvanmiyur', budget: '5.5 Cr', stageId: 'won', updatedAt: now - 20 * DAY });
  lead('L_shiva2', { name: 'Shiva R', phone: '90000 22222', propertyInterest: 'Plot in Mambakkam', budget: '35 L', stageId: 'new', updatedAt: now - 3 * DAY });

  // ── A task for the agent today ──
  const today = new Date(now + 5.5 * HOUR).toISOString().slice(0, 10);
  put('tasks/task1', { tenantId: T, title: 'Collect EC copy for the Thiruvanmiyur villa', primary: AGENT, due: today, status: 'todo', createdAt: now - DAY,
    link: thi ? { label: thi.propertyCode + ' ' + (thi.name || '') } : null });

  return { docs, props: { med, mam, poo, thi } };
}
