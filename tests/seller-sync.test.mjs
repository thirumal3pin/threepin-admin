// ═══════ SELLER LEAD ⇄ LISTING SYNC ═══════
//
// The rules under test are the ones that keep a two-way sync from corrupting
// either side: the CRM owns the person, the board owns the work, a field
// edited by hand is never reverted, and nothing deliberately removed comes
// back on its own.
//
//   node tests/seller-sync.test.mjs

import {
  isSellerLead, isBusinessLead, wantsListing, newListingFor, listingPatchFor, leadPatchFor, planSync
} from '../track-assets/seller-sync.js';
import { defaultStages } from '../track-assets/track-pipeline.js';

let passed = 0, failed = 0;
const check = (label, cond, detail) => {
  if (cond) { passed++; return; }
  failed++;
  console.log(`  FAIL  ${label}${detail !== undefined ? ' — ' + detail : ''}`);
};
const eq = (label, a, b) => check(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const section = n => console.log(`\n── ${n}`);

const NOW = 1789000000000;
const STAGES = defaultStages();
const FIRST = STAGES[0];
const lead = (o = {}) => ({ id: 'L1', name: 'Meenakshi', phone: '9840011111', enquiryType: 'Seller Listing', ...o });

console.log('3 PIN Realty — seller ⇄ listing sync');

section('Who counts as a seller');
check('Enquiry type Seller Listing', isSellerLead(lead()));
check('AI read them as selling', isSellerLead(lead({ enquiryType: 'Property Enquiry', ai: { intent: 'sell' } })));
check('AI read them as renting out', isSellerLead(lead({ enquiryType: '', ai: { intent: 'rent_out' } })));
check('A buyer is not a seller', !isSellerLead(lead({ enquiryType: 'Property Enquiry', ai: { intent: 'buy' } })));
check('A vendor is excluded even when tagged a seller',
  isBusinessLead(lead({ tt: { id: 'x', category: 'others' } })) && !wantsListing(lead({ tt: { id: 'x', category: 'others' } })));
check('Someone set aside is not re-added', !wantsListing(lead({ listingSkipped: true })));
check('…but is eligible again once that is cleared', wantsListing(lead({ listingSkipped: false })));

section('The card a seller gets');
{
  const x = newListingFor(lead({ propertyInterest: 'Adambakkam 2BHK', budget: '85 L', propertyCodes: ['ADB001'] }), FIRST, NOW, 'sync');
  eq('Owner name and number come across', [x.sellerName, x.sellerPhone], ['Meenakshi', '9840011111']);
  eq('The lead is linked', x.leadId, 'L1');
  eq('Locality seeds the title and location', [x.title, x.location], ['Adambakkam 2BHK', 'Adambakkam 2BHK']);
  eq('Budget seeds the asking price', x.askingPrice, '85 L');
  eq('A property already linked on the lead is carried over', x.propertyCode, 'ADB001');
  eq('It starts in the first column', x.stageId, FIRST.id);
  eq('…and that milestone is stamped', x.reached[FIRST.key], NOW);
  check('The board\'s own fields start empty', JSON.stringify(x.media) === '{}' && x.ownerApproved === false);
}

section('The CRM owns the person');
{
  const l = lead({ name: 'Meenakshi R', phone: '9840099999' });
  const x = newListingFor(lead(), FIRST, NOW, 'sync');
  eq('A corrected name and number follow onto the card',
    listingPatchFor(l, x), { sellerName: 'Meenakshi R', sellerPhone: '9840099999' });
  eq('Nothing to do when they already agree', listingPatchFor(lead(), x), null);
  eq('A blank in the CRM never wipes what the card has',
    listingPatchFor(lead({ name: '', phone: '' }), x), null);
}

section('A hand edit on the board is never reverted');
{
  const x = { ...newListingFor(lead(), FIRST, NOW, 'sync'), sellerName: 'Mrs. Meenakshi Raman', own: { sellerName: true } };
  eq('The claimed field is left alone', listingPatchFor(lead({ name: 'Meenakshi', phone: '9840011111' }), x), null);
  const both = { ...x, sellerPhone: '9840000000' };
  eq('…while an unclaimed one still follows the CRM',
    listingPatchFor(lead({ name: 'Meenakshi', phone: '9840012345' }), both), { sellerPhone: '9840012345' });
}

section('The board owns the property and the work');
{
  const x = { ...newListingFor(lead(), FIRST, NOW, 'sync'), propertyCode: 'TNAG0002' };
  eq('A mapping on the board is never overwritten by the lead',
    listingPatchFor(lead({ propertyCodes: ['OTHER001'] }), x), null);
  const blank = newListingFor(lead(), FIRST, NOW, 'sync');
  eq('…but a blank mapping is filled from the lead',
    listingPatchFor(lead({ propertyCodes: ['OTHER001'] }), blank), { propertyCode: 'OTHER001' });
}

section('What flows back to the lead');
{
  const x = { ...newListingFor(lead(), FIRST, NOW, 'sync'), id: 'lst_9', propertyCode: 'TNAG0002', stageId: 'live', shootAt: NOW, media: { photos: true } };
  const p = leadPatchFor(lead(), x);
  eq('The link and the mapped property, and nothing else',
    Object.keys(p).sort(), ['listingId', 'propertyCodes']);
  eq('…with the code appended', p.propertyCodes, ['TNAG0002']);
  check('The listing\'s stage and shoot never reach the lead',
    !('stageId' in p) && !('shootAt' in p) && !('media' in p));
  eq('A property the team unlinked in the CRM is not re-added',
    leadPatchFor(lead({ listingId: 'lst_9', unlinkedPropertyIds: ['TNAG0002'] }), x), null);
  eq('Nothing to do once it is linked', leadPatchFor(lead({ listingId: 'lst_9', propertyCodes: ['TNAG0002'] }), x), null);
}

section('The whole reconcile');
{
  const leads = [
    lead({ id: 'S1', name: 'Gopal' }),
    lead({ id: 'S2', name: 'Priya', enquiryType: 'Property Enquiry', ai: { intent: 'rent_out' } }),
    lead({ id: 'B1', name: 'Karthik', enquiryType: 'Property Enquiry' }),
    lead({ id: 'S3', name: 'Dropped', listingSkipped: true }),
    lead({ id: 'S4', name: 'Already', phone: '9840044444' })
  ];
  const existing = [{ ...newListingFor(lead({ id: 'S4', name: 'Already', phone: 'old' }), FIRST, NOW, 'sync'), id: 'lst_4', leadId: 'S4' }];
  const plan = planSync(leads, existing, FIRST, NOW, 'sync');
  eq('Cards are created for the untracked sellers only',
    plan.create.map(c => c.lead.id).sort(), ['S1', 'S2']);
  check('A buyer gets none', !plan.create.some(c => c.lead.id === 'B1'));
  check('Someone set aside gets none', !plan.create.some(c => c.lead.id === 'S3'));
  eq('An existing card is patched where the CRM differs',
    plan.updateListings.map(u => [u.id, u.patch]), [['lst_4', { sellerPhone: '9840044444' }]]);
  // Every tracked seller ends up linked — the two new ones, and the existing
  // card whose lead had never been given its listingId.
  eq('Every tracked seller is linked back to its card',
    plan.updateLeads.filter(u => u.patch.listingId).map(u => u.id).sort(), ['S1', 'S2', 'S4']);

  // Running it again against the fully applied result must be a no-op — the
  // property that makes this safe to put on a schedule.
  const after = [...existing.map(x => ({ ...x, sellerPhone: '9840044444' })),
    ...plan.create.map(c => c.listing)];
  const afterLeads = leads.map(l => {
    const patches = plan.updateLeads.filter(u => u.id === l.id).map(u => u.patch);
    return patches.length ? Object.assign({ ...l }, ...patches) : l;
  });
  const second = planSync(afterLeads, after, FIRST, NOW, 'sync');
  eq('A second run changes nothing',
    [second.create.length, second.updateListings.length, second.updateLeads.length], [0, 0, 0]);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
