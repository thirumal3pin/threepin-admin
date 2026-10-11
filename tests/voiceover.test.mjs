// Voice-overs still to make (track-assets/voiceover.js) — the one reading the board, the Editor view
// and the CRM's Daily task share.
import { voLeft, voDue, voTasks, voAsk, isVoicePerson } from '../track-assets/voiceover.js';

let failed = 0;
const check = (label, cond, detail) => { if (!cond) { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : '')); } };
console.log('3 PIN Realty — voice-overs\n');

const ST = [{ id: 's3', key: 'shoot_scheduled', name: 'Shoot scheduled' }, { id: 's4', key: 'shoot_done', name: 'Shoot done' }, { id: 's6', key: 'live', name: 'Live — marketing' },
  { id: 's7', key: 'closed', name: 'Sold / Rented' }, { id: 's8', key: 'on_hold', name: 'On hold' }, { id: 's9', key: 'dropped', name: 'Dropped' }];
const base = { forPlan: { igReel: true, yt: true, igStory: true }, forVoice: { igReel: 'vo', yt: 'vo', igStory: 'live' }, forVo: { yt: true } };

const keys = l => JSON.stringify(l.map(o => [o.k, o.label]));
check('Per outlet: V/O needed, planned, not made — the Reel only, not asked yet', keys(voLeft(base)) === JSON.stringify([['igReel', 'Insta Reel']]) && voLeft(base)[0].ask === null, JSON.stringify(voLeft(base)));
check('…an outlet not planned does not count', voLeft({ forPlan: {}, forVoice: { yt: 'vo' } }).length === 0);
check('…an old "Instagram" plan counts for the Reel', voLeft({ forPlan: { insta: true }, forVoice: { igReel: 'vo' } }).length === 1);
check('Old whole-shoot V/O, not made: one, for the video', keys(voLeft({ voice: 'vo' })) === JSON.stringify([['all', 'Video']]));
check('…made: none', voLeft({ voice: 'vo', voDone: true }).length === 0);
check('…replaced by per-outlet choices: the old one is not read', voLeft({ voice: 'vo', forVoice: { yt: 'live' }, forPlan: { yt: true } }).length === 0);

check('Due once shot: Shoot done stage', voDue({ stageId: 's4' }, ST));
check('…or a shoot-done time', voDue({ stageId: 's3', shootDoneAt: 1 }, ST));
check('…not before the shoot', !voDue({ stageId: 's3' }, ST));
check('…not when sold, on hold or dropped', !voDue({ stageId: 's7', shootDoneAt: 1 }, ST) && !voDue({ stageId: 's8', shootDoneAt: 1 }, ST) && !voDue({ stageId: 's9', shootDoneAt: 1 }, ST));
check('…a series while open', voDue({ kind: 'series', stageId: 's3' }, ST));

const tasks = voTasks([
  { id: 'b', stageId: 's6', shootDoneAt: 20, ...base },
  { id: 'a', stageId: 's4', shootDoneAt: 10, ...base },
  { id: 'c', stageId: 's7', shootDoneAt: 5, ...base },
  { id: 'd', stageId: 's4', shootDoneAt: 1, forPlan: { yt: true }, forVoice: { yt: 'vo' }, forVo: { yt: true } }
], ST);
check('Tasks: open shot cards with one to make, oldest shoot first', JSON.stringify(tasks.map(t => t.x.id)) === '["a","b"]', JSON.stringify(tasks.map(t => t.x.id)));
// Asked for by the editor once the rough cut is ready: only then the voice-over person's.
const asked = { ...base, forVoAsk: { igReel: { at: 500, by: 'Rajesh', note: '30 sec, Tamil' } } };
check('Asked: who and when, with the note', JSON.stringify(voAsk(asked, 'igReel')) === JSON.stringify({ at: 500, by: 'Rajesh', note: '30 sec, Tamil' }) && voLeft(asked)[0].ask.by === 'Rajesh');
check('…a request taken back (null) is not asked', voAsk({ forVoAsk: { igReel: null } }, 'igReel') === null);
const at = voTasks([
  { id: 'n', stageId: 's4', shootDoneAt: 1, ...base },
  { id: 'q', stageId: 's4', shootDoneAt: 2, ...asked },
  { id: 'r', stageId: 's4', shootDoneAt: 3, ...base, forVoAsk: { igReel: { at: 100, by: 'Anu' } } }
], ST, { asked: true });
check('Tasks, asked only: not the unasked one, oldest ask first', JSON.stringify(at.map(t => t.x.id)) === '["r","q"]' && at[0].at === 100, JSON.stringify(at.map(t => [t.x.id, t.at])));

check('The voice-over person by name, case-blind', isVoicePerson('Swami', 'swami') && isVoicePerson('Swami', 'Swami K'));
check('…by email', isVoicePerson('Swami', 'swami@threepin.in') && isVoicePerson('Swami K', 'swami.k@threepin.in'));
check('…not someone else, nor nobody set', !isVoicePerson('Swami', 'rajesh@threepin.in') && !isVoicePerson('', 'swami@threepin.in'));

console.log(failed ? `\n${failed} failed.` : '\nAll good.');
process.exit(failed ? 1 : 0);
