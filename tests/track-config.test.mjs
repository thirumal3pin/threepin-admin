// Shoot & Media configuration.   node tests/track-config.test.mjs
import { normalizeConfig, isEditor, defaultDelivery, DEFAULTS, DEFAULT_DOCS, docKey, docStatus, docProgress, listingTypeOf } from '../track-assets/track-config.js';
import { stageAge, setTargetDays, defaultStages } from '../track-assets/track-pipeline.js';
import { parsePlan, planRows, mondayOf, isSeries } from '../track-assets/posting.js';

let failed = 0;
const check = (label, cond, detail) => { if (!cond) { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : '')); } };
const NOW = 1789000000000, DAY = 86400000;
console.log('3 PIN Realty — Shoot & Media configuration');

const d = normalizeConfig(undefined);
check('Nothing saved: the defaults', JSON.stringify(d) === JSON.stringify({ ...DEFAULTS, editors: [], targetDays: {}, tags: [], docItems: [...DEFAULT_DOCS] }));

// The documents checklist: the starting list until one is saved; a saved list (even empty) is kept.
check('Documents: the starting list when none is saved', d.docItems.length === DEFAULT_DOCS.length && d.docItems[0] === 'Sale deed / title');
check('…a saved list as it is, cleaned', JSON.stringify(normalizeConfig({ docItems: [' Patta ', 'patta', '', 'NOC'] }).docItems) === '["Patta","NOC"]');
check('…an emptied list stays empty', normalizeConfig({ docItems: [] }).docItems.length === 0);
check('Document key: plain', docKey('Encumbrance certificate (EC)') === 'encumbrance_certificate_ec' && docKey('Owner ID & PAN') === 'owner_id_pan');
const docCard = { docs: { patta: 'have', approved_plan: 'missing', encumbrance_certificate_ec: 'applied', owner_id_pan: 'na', sale_deed_title: 'bogus' } };
check('Document status: only real ones', docStatus(docCard, 'Patta') === 'have' && docStatus(docCard, 'Sale deed / title') === '' && docStatus({}, 'Patta') === '');
const prog = docProgress(docCard, {});
check('Progress: in hand or not needed, out of all', prog.total === 7 && prog.done === 2 && prog.missing === 1 && prog.applied === 1, JSON.stringify(prog));
check('Listing type: only known ones', listingTypeOf({ listingType: 'collab' }) === 'collab' && listingTypeOf({ listingType: 'x' }) === '' && listingTypeOf(null) === '');
const c = normalizeConfig({ editors: [' Rajesh ', 'rajesh', '', 'Anu'], deliverDefault: 'zzz', dueSoonDays: 99, seriesAutoDetect: false, targetDays: { shoot_done: '4', live: 0, bogus: 3 }, tags: ['Premium', 'premium'] });
check('Editors cleaned and de-duplicated', JSON.stringify(c.editors) === '["Rajesh","Anu"]');
check('A bad value falls back to its default', c.deliverDefault === 'before' && c.dueSoonDays === 2);
check('Switches kept', c.seriesAutoDetect === false && c.seriesBoardCard === true);
check('Only real stages, only sensible days', JSON.stringify(c.targetDays) === '{"shoot_done":4}');
check('Tags de-duplicated', JSON.stringify(c.tags) === '["Premium"]');
check('Is an editor, whatever the case', isEditor(c, 'rajesh') && !isEditor(c, 'Ravi') && !isEditor(c, ''));

const post = new Date(2026, 9, 16, 18, 0).getTime();
check('Deliver by: the day before the post', defaultDelivery({}, post) === new Date(2026, 9, 15).getTime());
check('…or the same day', defaultDelivery({ deliverDefault: 'same' }, post) === new Date(2026, 9, 16).getTime());
check('…or none', defaultDelivery({ deliverDefault: 'none' }, post) === 0 && defaultDelivery({}, 0) === 0);

// Stage targets drive "late" on the board.
const ST = defaultStages(), sd = ST.find(s => s.key === 'shoot_done');
const card = { stageId: sd.id, stageChangedAt: NOW - 3 * DAY };
check('Shoot done is late after 2 days by default', stageAge(card, ST, NOW).over && stageAge(card, ST, NOW).target === 2);
setTargetDays({ shoot_done: 4 });
check('…after 4 when set', !stageAge(card, ST, NOW).over && stageAge(card, ST, NOW).target === 4);
setTargetDays({});
check('…and back', stageAge(card, ST, NOW).target === 2);

// Series from the plan can be switched off.
const MON = mondayOf(NOW), p = parsePlan('Youtube - T nagar series', MON);
check('Plan lines that say series: a series by default', isSeries(planRows(p.items, MON, [], NOW, '')[0]));
check('…a plain line when switched off', !isSeries(planRows(p.items, MON, [], NOW, '', { autoSeries: false })[0]));

console.log(failed ? `\n${failed} failure(s)` : '\nAll good.');
process.exit(failed ? 1 : 0);
