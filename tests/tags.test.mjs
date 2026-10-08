// Tags (track-assets/tags.js): the rules every page shares.
import { DEFAULT_TAGS, normTag, tagKey, cleanTags, catalog, hasTag, addTag, removeTag, suggestTags, MAX_TAG, tagColor, tagClass, TAG_COLORS } from '../track-assets/tags.js';

let fails = 0;
const check = (label, ok, detail) => { if (!ok) fails++; console.log((ok ? '  ok  ' : '  FAIL ') + label + (ok || detail === undefined ? '' : ' — ' + detail)); };
const J = JSON.stringify;

check('Starts with Collab, New Dev., Resale, Plot', J(DEFAULT_TAGS) === J(['Collab', 'New Dev.', 'Resale', 'Plot']));
check('A tag is trimmed, inner spaces collapsed, capped', normTag('  Sea   view ') === 'Sea view' && normTag('x'.repeat(50)).length === MAX_TAG);
check('Compared without case', tagKey('RESALE') === tagKey('resale'));
check('A saved list is made safe: no blanks, no repeats, first spelling kept', J(cleanTags(['Resale', ' resale ', '', null, 'Plot', 42])) === J(['Resale', 'Plot', '42']));
check('Not a list → empty', J(cleanTags('Resale')) === '[]' && J(cleanTags(undefined)) === '[]');

const cat = catalog(['Sea view', 'resale'], ['Gated', 'Collab'], undefined);
check('The pick list: the starting four in order, then every other tag in use A–Z', J(cat) === J(['Collab', 'New Dev.', 'Resale', 'Plot', 'Gated', 'Sea view']), J(cat));
check('…an existing tag typed in another case is not a second tag', cat.filter(t => tagKey(t) === 'resale').length === 1);

check('Adding takes the spelling already in use', J(addTag([], 'resale', cat)) === J(['Resale']));
check('Adding a new word keeps it as typed (tidied)', J(addTag(['Plot'], '  Corner  plot ', cat)) === J(['Plot', 'Corner plot']));
check('Adding one already there changes nothing', J(addTag(['Resale'], 'RESALE', cat)) === J(['Resale']));
check('Adding nothing changes nothing', J(addTag(['Plot'], '   ', cat)) === J(['Plot']));
check('Removing ignores case', J(removeTag(['Resale', 'Plot'], 'resale')) === J(['Plot']));
check('hasTag ignores case and spacing', hasTag(['New Dev.'], ' new  dev. ') && !hasTag(['New Dev.'], 'new dev'));

check('Suggestions leave out tags already on it', !suggestTags('', cat, ['Resale']).includes('Resale'));
check('Nothing typed → everything else, in pick-list order', J(suggestTags('', cat, ['Resale'])) === J(['Collab', 'New Dev.', 'Plot', 'Gated', 'Sea view']));
check('Starts-with first, then contains', J(suggestTags('e', catalog(['Sea view', 'Elevated'], []), [])) === J(['Elevated', 'New Dev.', 'Resale', 'Sea view']), J(suggestTags('e', catalog(['Sea view', 'Elevated'], []), [])));
check('Typing "new" offers New Dev.', suggestTags('new', cat, [])[0] === 'New Dev.');
check('No match → nothing (the picker then offers to create it)', suggestTags('zzz', cat, []).length === 0);

check('Each starting tag has its own fixed colour', J(DEFAULT_TAGS.map(tagColor)) === '[0,1,2,3]');
check('A tag keeps its colour whatever the case or spacing', tagColor(' resale ') === 2 && tagColor('Sea view') === tagColor('  SEA   view'));
check('Other tags take the remaining colours, never a starting tag\'s', ['Sea view', 'Gated', 'Corner plot', 'Lake', 'Villa', 'x', '★'].every(t => tagColor(t) >= 4 && tagColor(t) < TAG_COLORS));
check('The class is tc + the colour', tagClass('Plot') === 'tc3');

if (fails) { console.log(`\n${fails} failed`); process.exit(1); }
console.log('All good.');
