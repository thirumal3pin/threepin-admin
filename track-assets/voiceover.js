// ═══════════════════════════════════════════════════════════════════════
// VOICE-OVERS STILL TO MAKE — one reading for every screen that shows them.
//
// Pure, dependency-free apart from the stage list. A card's "Shoot for" says, per outlet, whether its
// video needs a voice-over made separately (forVoice[k] === 'vo') and whether that voice-over is made
// (forVo[k]). The editor asks for it once the rough cut is ready (forVoAsk[k] = { at, by, note }): only
// then is it the voice-over person's work (Settings → Configurations → Voice-over by) — on the boards
// with their name, and in their Daily task in the CRM. Until asked it shows as needed, for the editor.
// ═══════════════════════════════════════════════════════════════════════

import { stageKeyOf, stageKindOf } from './track-pipeline.js';

export const VO_OUTLETS = [['igStory', 'Insta Story'], ['igReel', 'Insta Reel'], ['fbReel', 'FB Reel'], ['yt', 'YouTube'], ['collab', 'Collab']];
const planned = (x, k) => !!(x.forPlan && (x.forPlan[k] || (k === 'igReel' && x.forPlan.insta)));
const hasOutletVoice = x => !!(x.forVoice && Object.values(x.forVoice).some(v => v === 'vo' || v === 'live'));

// Asked for by the editor: { at, by, note }, or null.
export function voAsk(x, k) {
  const a = x && x.forVoAsk && x.forVoAsk[k];
  return a && Number(a.at) ? { at: Number(a.at), by: String(a.by || ''), note: String(a.note || '') } : null;
}
// The outlets of a card whose voice-over is still to make: [{ k, label, ask }] (ask: asked for, or null).
// A card from before voice-overs were per outlet (voice: 'vo' for the whole shoot, voDone) reads as one:
// { k: 'all', label: 'Video' }.
export function voLeft(x) {
  if (!x) return [];
  const out = VO_OUTLETS.filter(([k]) => planned(x, k) && x.forVoice && x.forVoice[k] === 'vo' && !(x.forVo && x.forVo[k]))
    .map(([k, label]) => ({ k, label, ask: voAsk(x, k) }));
  if (!out.length && x.voice === 'vo' && !x.voDone && !hasOutletVoice(x)) out.push({ k: 'all', label: 'Video', ask: voAsk(x, 'all') });
  return out;
}

// Is a voice-over on this card work for now: an open card (not sold, on hold or dropped) that is shot —
// there is footage to voice. A series counts while it is open (its properties are shot one by one).
export function voDue(x, stages) {
  const st = (stages || []).find(s => s && s.id === (x && x.stageId)) || null;
  const kind = st ? stageKindOf(st) : 'open';
  if (kind && kind !== 'open') return false;
  if (x && x.kind === 'series') return true;
  const key = st ? stageKeyOf(st) : '';
  return !!(x && x.shootDoneAt) || ['shoot_done', 'media_ready', 'live'].includes(key);
}

// Every voice-over still to make across the board: [{ x, left, at }]. asked: only those the editor has
// asked for (the voice-over person's work), oldest ask first; otherwise all, oldest shoot first.
export function voTasks(listings, stages, opts) {
  const asked = !!(opts && opts.asked);
  return (listings || []).filter(x => x && voDue(x, stages))
    .map(x => { const left = voLeft(x).filter(o => !asked || o.ask); return { x, left, at: asked ? Math.min(...left.map(o => o.ask ? o.ask.at : Infinity)) : (x.shootDoneAt || x.updatedAt || 0) }; })
    .filter(t => t.left.length)
    .sort((a, b) => a.at - b.at);
}

const norm = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
const first = v => norm(v).split(' ')[0];
// Is this person the voice-over person (Settings → Voice-over by)? Case-blind, by the name as typed or its
// first name; an email by the name part before the @ ("swami.k@…" is Swami).
export function isVoicePerson(voiceBy, who) {
  const v = norm(voiceBy), w = norm(who);
  if (!v || !w) return false;
  if (w.includes('@')) { const local = w.split('@')[0].split(/[._\-+]+/).filter(Boolean); return v === local.join(' ') || first(v) === local[0]; }
  return v === w || first(v) === first(w);
}
