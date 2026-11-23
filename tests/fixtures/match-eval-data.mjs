// ═══════ THE MATCHING EVALUATION SET (Nov 2026) ═══════
//
// A small Chennai market, written by hand, with the right answers decided BEFORE any engine was
// run on it — so the numbers tests/match-eval.mjs prints are a measurement, not a tuning loop.
// Every property opportunity the owner named is here: onboarded inventory (P), Shoot board cards
// at several stages (L), CRM seller leads nobody has processed yet (S), and an agent submission (U).
//
// Grades: 2 = an exact fit an agent would send at once; 1 = a real alternative worth offering;
// `never` = must not be shown as a match (wrong deal, wrong kind, a place they refused, sold,
// a closed lead). Anything else is "not judged".

export const NOW = Date.parse('2026-11-20T10:00:00+05:30');
const D = 86400000;

export const PROPERTIES = [
  { id: 'P01', propertyCode: 'P01', name: '2BHK Apartment, Anna Nagar', type: 'Apartment', location: 'Anna Nagar', config: '2 BHK', startingPrice: '1.9 Cr', sqftRange: '1150', status: 'Ready to Move', availability: 'Available' },
  { id: 'P02', propertyCode: 'P02', name: '3BHK Resale Apartment, Anna Nagar 2nd Avenue', type: 'Apartment', location: 'Anna Nagar', config: '3 BHK', startingPrice: '3.1 Cr', sqftRange: '2050', saleType: 'Resale', status: 'Ready to Move', parkingType: 'Covered', availability: 'Available' },
  { id: 'P03', propertyCode: 'P03', name: '3BHK Apartment, Anna Nagar West', type: 'Apartment', location: 'Anna Nagar West', config: '3 BHK', startingPrice: '2.85 Cr', sqftRange: '1900', status: 'Ready to Move', availability: 'Available' },
  { id: 'P04', propertyCode: 'P04', name: '3BHK Apartment, Kilpauk', type: 'Apartment', location: 'Kilpauk', config: '3 BHK', startingPrice: '3.2 Cr', sqftRange: '2100', status: 'Ready to Move', availability: 'Available' },
  { id: 'P05', propertyCode: 'P05', name: '3BHK Apartment, Mogappair West', type: 'Apartment', location: 'Mogappair', config: '3 BHK', startingPrice: '1.5 Cr', sqftRange: '1600', status: 'Under Construction', availability: 'Available' },
  { id: 'P06', propertyCode: 'P06', name: '2BHK Apartment, Mogappair East', type: 'Apartment', location: 'Mogappair', config: '2 BHK', startingPrice: '85 Lakhs', sqftRange: '1050', status: 'Under Construction', availability: 'Available' },
  { id: 'P07', propertyCode: 'P07', name: '3BHK Apartment, Adyar', type: 'Apartment', location: 'Adyar', config: '3 BHK', startingPrice: '3 Cr', sqftRange: '1850', status: 'Ready to Move', availability: 'Available' },
  { id: 'P08', propertyCode: 'P08', name: '2BHK Apartment, Adyar', type: 'Apartment', location: 'Adyar', config: '2 BHK', startingPrice: '1.6 Cr', sqftRange: '1100', status: 'Ready to Move', availability: 'Available' },
  { id: 'P09', propertyCode: 'P09', name: 'Independent House, Velachery', type: 'Independent House', location: 'Velachery', config: '3 BHK', startingPrice: '2.4 Cr', sqftRange: '2200', totalLandArea: '1.2 grounds', status: 'Ready to Move', availability: 'Available' },
  { id: 'P10', propertyCode: 'P10', name: 'Sea-facing Villa with private pool, Neelankarai ECR', type: 'Villa', location: 'Neelankarai, ECR', config: '4 BHK', startingPrice: '4.5 Cr', sqftRange: '3800', amenities: 'Private swimming pool, garden', status: 'Ready to Move', availability: 'Available' },
  { id: 'P11', propertyCode: 'P11', name: 'Villa, Akkarai ECR', type: 'Villa', location: 'Akkarai, ECR', config: '4 BHK', startingPrice: '6 Cr', sqftRange: '4200', amenities: 'Garden, terrace', status: 'Ready to Move', availability: 'Available' },
  { id: 'P12', propertyCode: 'P12', name: 'Ultra luxury 4BHK, Boat Club Road', type: 'Apartment', location: 'Boat Club', config: '4 BHK', startingPrice: '8.2 Cr', sqftRange: '4500', highlights: 'Ultra luxury, concierge', status: 'Ready to Move', availability: 'Available' },
  { id: 'P13', propertyCode: 'P13', name: 'DTCP Residential Plot in Gated Community, Tambaram', type: 'Plot', location: 'Tambaram', startingPrice: '45 Lakhs', totalLandArea: '1 ground', approval: 'DTCP', amenities: 'Gated community', availability: 'Available' },
  { id: 'P14', propertyCode: 'P14', name: 'Industrial Land, Oragadam', type: 'Industrial Land', location: 'Oragadam', startingPrice: '3.5 Cr', totalLandArea: '2 acres', availability: 'Available' },
  { id: 'P15', propertyCode: 'P15', name: 'Office Space for Rent, Perungudi OMR', type: 'Commercial Office', location: 'Perungudi, OMR', config: 'Office space', startingPrice: 'Rent 3.2 L per month', sqftRange: '4000', availability: 'Available for Rent' },
  { id: 'P16', propertyCode: 'P16', name: 'Retail Showroom for Lease, Nungambakkam', type: 'Commercial', location: 'Nungambakkam', config: 'Retail showroom', startingPrice: 'Rent 3 L per month', sqftRange: '2800', highlights: 'Main road frontage, 6 car parking', availability: 'Available for Rent' },
  { id: 'P17', propertyCode: 'P17', name: 'Commercial Building for Lease, T Nagar', type: 'Commercial Building', location: 'T Nagar', startingPrice: 'Rent 4.5 L per month', sqftRange: '5200', availability: 'Available for Rent' },
  { id: 'P18', propertyCode: 'P18', name: 'Commercial Space for Rent, Valasaravakkam', type: 'Commercial Space', location: 'Valasaravakkam', startingPrice: 'Rent 2.3 L per month', sqftRange: '2500', availability: 'Available for Rent' },
  { id: 'P19', propertyCode: 'P19', name: 'Residential Land for Sale, Choolaimedu', type: 'Land', location: 'Choolaimedu', startingPrice: '7 Cr', totalLandArea: '2 grounds', availability: 'Available' },
  { id: 'P20', propertyCode: 'P20', name: 'Land, Anna Nagar — open for joint venture', type: 'Land', location: 'Anna Nagar', totalLandArea: '4 grounds', highlights: 'Owner open for joint venture with a reputed builder', availability: 'Available' },
  { id: 'P21', propertyCode: 'P21', name: '2BHK Flat for Rent, Perungudi', type: 'Apartment', location: 'Perungudi', config: '2 BHK', startingPrice: 'Rs 32,000 per month', sqftRange: '1100', availability: 'Available for Rent' },
  { id: 'P22', propertyCode: 'P22', name: '2BHK Premium Flat for Rent, Perungudi', type: 'Apartment', location: 'Perungudi', config: '2 BHK', startingPrice: 'Rs 55,000 per month', sqftRange: '1350', availability: 'Available for Rent' },
  { id: 'P23', propertyCode: 'P23', name: 'Resale 3BHK, Mogappair', type: 'Apartment', location: 'Mogappair', config: '3 BHK', startingPrice: '1.3 Cr', sqftRange: '1500', saleType: 'Resale', status: 'Ready to Move', availability: 'Immediate' },
  { id: 'P24', propertyCode: 'P24', name: '2BHK Apartment, Velachery', type: 'Apartment', location: 'Velachery', config: '2 BHK', startingPrice: '95 Lakhs', sqftRange: '1000', status: 'Ready to Move', availability: 'Available' },
  { id: 'P25', propertyCode: 'P25', name: 'Warehouse for Rent, Oragadam', type: 'Commercial', location: 'Oragadam', config: 'Warehouse', startingPrice: 'Rent 3 L per month', sqftRange: '20000', availability: 'Available for Rent' },
  { id: 'P26', propertyCode: 'P26', name: '3BHK Apartment, T Nagar', type: 'Apartment', location: 'T Nagar', config: '3 BHK', startingPrice: '3.4 Cr', sqftRange: '2000', status: 'Ready to Move', availability: 'Available' },
  { id: 'P27', propertyCode: 'P27', name: '3BHK Apartment, Anna Nagar (sold)', type: 'Apartment', location: 'Anna Nagar', config: '3 BHK', startingPrice: '2.9 Cr', sqftRange: '2000', availability: 'Sold' },
  { id: 'P28', propertyCode: 'P28', name: 'Office for Sale, Thoraipakkam OMR', type: 'Commercial Office', location: 'Thoraipakkam, OMR', config: 'Office space', startingPrice: '2.5 Cr', sqftRange: '3500', availability: 'Available' },
  { id: 'P29', propertyCode: 'P29', name: 'Residential Plot, Tambaram', type: 'Plot', location: 'Tambaram', startingPrice: '40 Lakhs', totalLandArea: '1 ground', availability: 'Available' },
  { id: 'P30', propertyCode: 'P30', name: 'Agricultural Land, Kanathur', type: 'Agricultural Land', location: 'Kanathur', startingPrice: '2 Cr', totalLandArea: '1 acre', availability: 'Available' }
];

// The Shoot & Media board. L06 was dropped (never a match); L07 is a fresh seller's flat to let.
export const LISTINGS = [
  { id: 'L01', stageId: 'details', title: '3BHK Apartment, Anna Nagar East', location: 'Anna Nagar East', config: '3 BHK', askingPrice: '2.9 Cr', propType: 'apartment', deal: 'sale', sqft: '2000 sqft', sellerName: 'Ravi', sellerPhone: '9800000001' },
  { id: 'L02', stageId: 'shoot_scheduled', title: 'Land, Choolaimedu', location: 'Choolaimedu', askingPrice: '7.5 Cr', propType: 'land', deal: 'sale', landArea: '2.2 grounds', sellerName: 'Kumar', sellerPhone: '9800000002' },
  { id: 'L03', stageId: 'new_listing', title: 'Commercial space for rent, Valasaravakkam', location: 'Valasaravakkam', askingPrice: 'Rent 2.4 L per month', propType: 'commercial', deal: 'rent', sqft: '2600 sqft', sellerName: 'Mala', sellerPhone: '9800000003' },
  { id: 'L04', stageId: 'shoot_done', title: 'Villa with private pool, Uthandi ECR', location: 'Uthandi, ECR', config: '4 BHK', askingPrice: '5 Cr', propType: 'villa', deal: 'sale', remarks: 'Private swimming pool', sellerName: 'Iyer', sellerPhone: '9800000004' },
  { id: 'L05', stageId: 'details', title: '4 grounds land, Porur — joint venture', location: 'Porur', propType: 'land', deal: 'sale', landArea: '4 grounds', remarks: 'Owner prefers a joint venture (JV) with a builder', sellerName: 'Raman', sellerPhone: '9800000005' },
  { id: 'L06', stageId: 'dropped', title: '3BHK Apartment, Anna Nagar', location: 'Anna Nagar', config: '3 BHK', askingPrice: '3 Cr', propType: 'apartment', deal: 'sale', sellerName: 'X', sellerPhone: '9800000006' },
  { id: 'L07', stageId: 'new_listing', title: '2BHK Flat to let, Perungudi', location: 'Perungudi', config: '2 BHK', askingPrice: '30000 per month', propType: 'apartment', deal: 'rent', sellerName: 'Devi', sellerPhone: '9800000007' }
];

export const TRACK_STAGES = ['new_listing', 'details', 'shoot_scheduled', 'shoot_done', 'media_ready', 'for_approval', 'approved', 'live', 'closed', 'on_hold', 'dropped']
  .map((k, i) => ({ id: k, key: k, name: k, order: i, kind: k === 'closed' || k === 'dropped' ? 'closed' : 'open' }));
export const STAGES = [
  { id: 'new', name: 'New', kind: 'open' }, { id: 'options_shared', name: 'Options sent', kind: 'open' }, { id: 'site_visit', name: 'Visit planned', kind: 'open' },
  { id: 'negotiation', name: 'Negotiating', kind: 'open' }, { id: 'closed_won', name: 'Won', kind: 'won' }, { id: 'closed_lost', name: 'Lost', kind: 'lost' }, { id: 'on_hold', name: 'On hold', kind: 'hold' }
];

const lead = (id, propertyInterest, budget, extra) => Object.assign({ id, name: 'Client ' + id, phone: '98400' + id.replace(/\D/g, '').padStart(5, '0'), stageId: 'new', enquiryType: 'Property Enquiry', propertyInterest, budget, createdAt: NOW - 10 * D, updatedAt: NOW - 2 * D }, extra || {});

// Seller leads (S) are owners; the rest are buyers and tenants (B).
export const LEADS = [
  lead('S01', 'Selling my 3BHK flat in Kilpauk, 2000 sqft', 'Expected 3.1 Cr', { enquiryType: 'Seller Listing', phone: '9800000011' }),
  lead('S02', 'Office space for rent in Thoraipakkam OMR, 3500 sqft', 'Rent 2.8 L per month', { enquiryType: 'Seller Listing', ai: { intent: 'rent_out', confidence: 'high' }, phone: '9800000012' }),
  lead('S03', '2 grounds land in Choolaimedu for sale', 'Expected 6.8 Cr', { enquiryType: 'Seller Listing', phone: '9800000013' }),
  lead('S04', '3BHK in Anna Nagar for sale', '3 Cr', { enquiryType: 'Seller Listing', stageId: 'closed_lost', phone: '9800000014' }),
  // The card L01's own seller lead: the card stands for it (one property, one row).
  lead('S05', '3BHK Anna Nagar East', '2.9 Cr', { enquiryType: 'Seller Listing', listingId: 'L01', phone: '9800000001' }),

  lead('B01', '3BHK in Anna Nagar', '3 Cr'),
  lead('B02', '3 BHK in Anna Nagar or Kilpauk', 'around 3 crores'),
  lead('B03', '3BHK Anna Nagar', 'max 2.5 Cr'),
  lead('B04', '2BHK Anna Nagar', '1.5 Cr'),
  lead('B05', '3BHK in Adyar', '3 Cr'),
  lead('B06', '3BHK flat for rent in Anna Nagar', '60000 per month'),
  lead('B07', 'Plot in Anna Nagar', '3 Cr'),
  lead('B08', '4BHK in Anna Nagar', '3.5 Cr'),
  lead('B09', '3BHK in Anna Nagar', '3 Cr', { stageId: 'closed_lost' }),
  lead('B10', '3BHK in Shenoy Nagar', '3.2 Cr'),
  lead('B11', '3 BHK near Anna Nagar, not interested in Mogappair', '3 Cr'),
  lead('B12', 'Apartment in Anna Nagar, prefers resale', 'Budget 3 crore'),
  lead('B14', '3BHK in Mogappair', '1.5 Cr'),
  lead('B15', 'Commercial office space for rent in Anna Nagar', '1.5 L per month'),
  lead('B16', 'Commercial building for lease in T Nagar, 5000 sqft', '5 L per month'),
  lead('B17', 'Office space for rent in T Nagar', '3 L per month'),
  lead('B18', 'Retail showroom for lease in Nungambakkam', '3.5 L per month'),
  // A client with two live requirements, saved after review: a home AND land for a JV.
  lead('B19', '3BHK Anna Nagar', '3 Cr', { reqs: { src: 'reviewed', at: NOW - D, items: [
    { status: 'active', deal: 'buy', types: ['apartment'], bhk: [3], locations: [{ name: 'Anna Nagar', pref: 'primary' }], budget: { max: 30000000, unit: 'total', flex: 'approximate' } },
    { status: 'active', deal: 'jv', types: ['plot'], anywhere: true, area: { min: 4, unit: 'grounds', kind: 'land' } }
  ] } })
];

export const SUBMISSIONS = [
  { id: 'U01', status: 'pending', fields: { name: '3BHK Apartment, Adyar (agent submission)', type: 'Apartment', config: '3 BHK', location: 'Adyar', startingPrice: '2.9 Cr', contactNumber: '9800000021' } }
];

// ── Forward queries: requirement → properties ──
export const QUERIES = [
  { id: 'T1', test: 'TEST 1', text: '2 BHK apartment in Anna Nagar, budget ₹2 Cr', g2: ['P01'], g1: [], never: ['P27', 'P19', 'P20', 'P13', 'P21'] },
  { id: 'T2', test: 'TEST 2', text: '2 grounds of land for sale in Choolaimedu', g2: ['P19', 'L02', 'S03'], g1: [], never: ['P01', 'P02', 'P18', 'P26', 'P20'] },
  { id: 'T3', test: 'TEST 3', text: 'Commercial space for rent in Valasaravakkam, ₹2.5 Lakhs/month', g2: ['P18', 'L03'], g1: [], never: ['P28', 'P19', 'P01', 'P25'] },
  { id: 'T4', test: 'TEST 4', text: '3 BHK, approximately 2,000 Sq.Ft., Anna Nagar, ₹3 Cr', g2: ['P02', 'P03', 'L01'], g1: ['P04'], never: ['P27', 'L06', 'P20', 'S04'] },
  { id: 'T7', test: 'TEST 7', text: '3 BHK in Anna Nagar or Kilpauk, budget around ₹3 Cr', g2: ['P02', 'P03', 'P04', 'L01', 'S01'], g1: [], never: ['P27', 'L06', 'S04'] },
  { id: 'T8', test: 'TEST 8', text: 'Commercial building for lease, 5,000 Sq.Ft., T. Nagar', g2: ['P17'], g1: ['P16'], never: ['P26', 'P25', 'P28'] },
  { id: 'T9', test: 'TEST 9', text: '4 grounds for joint venture in Chennai', g2: ['P20', 'L05'], g1: [], never: ['P19', 'P13', 'P29', 'P02', 'P17'] },
  { id: 'T10', test: 'TEST 10', text: 'Apartment in Adyar, excluding Mogappair', g2: ['P07', 'P08', 'U01'], g1: [], never: ['P05', 'P06', 'P23'] },
  { id: 'X1', test: 'Retail', text: 'Retail showroom for lease in Nungambakkam with frontage and parking', g2: ['P16'], g1: ['P17'], never: ['P15', 'P25', 'P28'] },
  { id: 'X2', test: 'Industrial land', text: 'Industrial land for sale in Oragadam', g2: ['P14'], g1: [], never: ['P25', 'P13', 'P29'] },
  { id: 'X3', test: 'Villa + pool', text: 'Villa for sale in ECR with a private swimming pool', g2: ['P10', 'L04'], g1: ['P11'], never: ['P12', 'P30'] },
  { id: 'X4', test: 'Rent ≠ sale', text: '2 BHK apartment for rent in Perungudi, budget ₹35,000/month', g2: ['P21', 'L07'], g1: [], never: ['P22', 'P24', 'P15'] },
  { id: 'X5', test: 'Office rent', text: 'Office space for rent in OMR, 3,000–5,000 Sq.Ft.', g2: ['P15', 'S02'], g1: [], never: ['P28', 'P21'] },
  { id: 'X6', test: 'Gated plot', text: 'Residential plot in a gated community in Tambaram', g2: ['P13'], g1: ['P29'], never: ['P14', 'P30'] },
  { id: 'X7', test: 'Resale ready', text: 'Resale apartment in Mogappair, immediate possession', g2: ['P23'], g1: ['P05', 'P06'], never: ['P13'] },
  { id: 'X8', test: 'House not flat', text: 'Independent house for sale in Velachery, budget ₹2.5 Cr', g2: ['P09'], g1: [], never: ['P13'] },
  { id: 'X9', test: 'Tamil-English + typo', text: '3bhk anna nagr la venum, budget 3 cr kulla', g2: ['P02', 'P03', 'L01'], g1: ['P04'], never: ['P27', 'L06'] },
  { id: 'X10', test: 'Luxury', text: 'Luxury apartment in Boat Club Road, budget ₹8 Cr', g2: ['P12'], g1: [], never: ['P13'] },
  { id: 'X11', test: 'Remark with exclusion', text: 'Client not interested in Mogappair. Looking at Kilpauk and Anna Nagar. 3BHK, budget 3 Cr.', g2: ['P02', 'P03', 'P04', 'L01', 'S01'], g1: [], never: ['P05', 'P23'] }
];

// ── Reverse queries: property → clients ──
export const REVERSE = [
  { id: 'T5', test: 'TEST 5', details: { type: 'Apartment', bhk: 3, location: 'Anna Nagar', area: 2000, price: 30000000, deal: 'sale', condition: 'resale' }, g2: ['B01', 'B02', 'B11', 'B12', 'B19'], g1: ['B03', 'B10'], never: ['B04', 'B05', 'B06', 'B07', 'B09', 'B14', 'B15', 'S01', 'S04'] },
  { id: 'T6', test: 'TEST 6', listingId: 'L01', g2: ['B01', 'B02', 'B11', 'B12', 'B19'], g1: ['B03', 'B10'], never: ['B05', 'B06', 'B07', 'B09', 'B14'] },
  // Corrected after the first run (25 Nov 2026), and said so in the report: B17 (₹3 L a month) and
  // B18 (₹3.5 L) had been labelled alternatives for a ₹4.5 L a month building — 50% and 29% over
  // what they said they can pay, which no agent would offer. B07 (a plot buyer in Anna Nagar) had
  // been labelled "never" for land whose owner prefers a JV but has not refused a sale — asking is
  // the right next step, so it is an alternative.
  { id: 'T8r', test: 'TEST 8 reversed', propertyId: 'P17', g2: ['B16'], g1: [], never: ['B01', 'B06', 'B15', 'B17', 'B18'] },
  { id: 'T9r', test: 'TEST 9 reversed', propertyId: 'P20', g2: ['B19'], g1: ['B07'], never: ['B01', 'B02'] }
];

// ── Requirement extraction: text → the fields a person would write down ──
// Each expectation is checked field by field (only the fields listed).
export const EXTRACTION = [
  { text: '2 BHK apartment in Anna Nagar, Chennai, budget ₹2 Cr', deal: ['sale'], types: ['Apartment'], bhk: [2], loc: ['anna nagar'], budgetMax: 2e7, mode: 'sale' },
  { text: '2 grounds residential land for sale in Choolaimedu', deal: ['sale'], types: ['Plot'], sub: 'res_plot', loc: ['choolaimedu'], sizeMin: 4800, sizeUnit: 'land' },
  { text: 'Commercial space for rent in Valasaravakkam, monthly budget ₹2.5 Lakhs', deal: ['rent'], types: ['Commercial'], loc: ['valasaravakkam'], budgetMax: 250000, mode: 'monthly' },
  { text: '3 BHK apartment, 1,800–2,200 Sq.Ft., in Adyar, budget ₹3 Cr', deal: ['sale'], bhk: [3], loc: ['adyar'], sizeMin: 1800, sizeMax: 2200, budgetMax: 3e7 },
  { text: 'Independent house for sale in Velachery, budget ₹2.5 Cr', deal: ['sale'], types: ['House'], loc: ['velachery'], budgetMax: 2.5e7 },
  { text: '5,000 Sq.Ft. commercial building for lease in T. Nagar', deal: ['rent'], types: ['Commercial'], sub: 'building', loc: ['t nagar'], sizeMin: 5000 },
  { text: '4 grounds land for joint venture in Chennai', deal: ['jv'], types: ['Plot'], sizeMin: 9600, sizeUnit: 'land', anywhere: true },
  { text: 'Industrial land for sale in Oragadam', deal: ['sale'], types: ['Plot'], sub: 'industrial_land', loc: ['oragadam'] },
  { text: 'Office space for rent in OMR, 3,000–5,000 Sq.Ft.', deal: ['rent'], types: ['Commercial'], sub: 'office', corridor: 'OMR', sizeMin: 3000, sizeMax: 5000 },
  { text: 'Luxury apartment in Boat Club Road, budget ₹8 Cr', types: ['Apartment'], loc: ['boat club'], budgetMax: 8e7 },
  { text: 'Villa for sale in ECR with a private swimming pool', deal: ['sale'], types: ['Villa'], corridor: 'ECR', specs: ['pool'] },
  { text: '2 BHK apartment for rent in Perungudi, budget ₹35,000/month', deal: ['rent'], bhk: [2], loc: ['perungudi'], budgetMax: 35000, mode: 'monthly' },
  { text: 'Retail showroom for lease in Nungambakkam with frontage and parking', deal: ['rent'], types: ['Commercial'], sub: 'retail', loc: ['nungambakkam'], specs: ['frontage', 'anyParking'] },
  { text: 'Residential plot in a gated community in Tambaram', types: ['Plot'], sub: 'res_plot', loc: ['tambaram'], specs: ['gated'] },
  { text: 'Resale apartment in Mogappair, immediate possession', types: ['Apartment'], loc: ['mogappair'], saleType: 'Resale', possession: 'ready' },
  { text: 'Looking for a 3 BHK apartment around 2000 sqft in Anna Nagar or Kilpauk, budget around 3 crores. Preferably new or resale with car parking. Immediate purchase.', bhk: [3], loc: ['anna nagar', 'kilpauk'], budgetMax: 3e7, flexible: true, sizeMin: 2000, saleType: null, specs: ['parking'] },
  { text: 'Client not interested in Mogappair. Looking at MRC Nagar, RA Puram and Poes Garden. Budget 3 Cr.', loc: ['mrc nagar', 'r a puram', 'poes garden'], exclude: ['mogappair'], budgetMax: 3e7 },
  { text: 'Apartment in Adyar, excluding Mogappair', types: ['Apartment'], loc: ['adyar'], exclude: ['mogappair'] },
  { text: '3bhk anna nagr la venum, budget 3 cr kulla', bhk: [3], loc: ['anna nagar'], budgetMax: 3e7 },
  { text: 'velacheri la 2bhk flat for rent 25k', deal: ['rent'], bhk: [2], loc: ['velachery'], budgetMax: 25000, mode: 'monthly' },
  { text: 'Commercial space for rent, 30 lakhs per annum, Guindy', deal: ['rent'], types: ['Commercial'], loc: ['guindy'], budgetMax: 250000, mode: 'monthly' },
  { text: 'Plot in Tambaram, 2400 sqft, upto 60 lakhs, DTCP approved', types: ['Plot'], loc: ['tambaram'], budgetMax: 6e6 },
  { text: '3 BHK villa in ECR, budget 4 to 5 crores', types: ['Villa'], bhk: [3], corridor: 'ECR', budgetMax: 5e7 },
  { text: 'Warehouse for lease near Sriperumbudur 20000 sqft', deal: ['rent'], types: ['Commercial'], sub: 'warehouse', loc: ['sriperumbudur'], sizeMin: 20000 },
  { text: '2bhk in porur not more than 80 lakhs', bhk: [2], loc: ['porur'], budgetMax: 8e6, exclude: [] },
  { text: 'Anything within 5 km of Adyar, 3 BHK, 2.5 Cr', bhk: [3], loc: ['adyar'], radiusKm: 5, budgetMax: 2.5e7 },
  { text: 'Agricultural land 2 acres in Chengalpattu', types: ['Plot'], sub: 'agri_land', loc: ['chengalpattu'], sizeMin: 87120 },
  { text: '3 BHK Besent nagar for rent 80000', deal: ['rent'], bhk: [3], loc: ['besant nagar'], budgetMax: 80000, mode: 'monthly' },
  { text: 'Shop for rent in T Nagar Ranganathan street, ground floor', deal: ['rent'], types: ['Commercial'], sub: 'retail', loc: ['t nagar'] },
  { text: 'Need office for sale in Guindy, 2000 sqft, above 2 Cr', deal: ['sale'], types: ['Commercial'], sub: 'office', loc: ['guindy'], budgetMin: 2e7 }
];
