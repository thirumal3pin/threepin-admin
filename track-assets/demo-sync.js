// ═══════ DEMO MODE — sample data, no Firebase, no login ═══════
//
// Loaded INSTEAD of firebase-sync.js when the page is opened as
//   http://localhost:5173/propertytrack.html?demo=1
// and only on localhost (see the switch in propertytrack.html). It exposes the same
// window.trackFirebase / trackAuth surface, keeps everything in memory, and never
// contacts Firestore: a reload resets the sample data, and nothing here can reach
// the live project.

import { defaultStages } from './track-pipeline.js';
import { parsePlan, planRows, mondayOf, copyPaths } from './posting.js';

const H = 3600000, D = 24 * H, NOW = Date.now(), T = 'demo';
const mk = o => ({ tenantId: T, brochure: { done: false }, acres99: { status: 'pending' }, website: { status: 'pending' }, createdAt: NOW - 3 * D, updatedAt: NOW - H, ...o });

let postings = [
  mk({ id: 'TNAG0002', propertyCode: 'TNAG0002', tags: ['Resale'], title: '2BHK Apartment, T Nagar', location: 'T Nagar', propertyId: 'TNAG0002',
    photosLink: 'https://drive.google.com/drive/folders/demo1', details: '2BHK · 1100 sqft · 3rd floor · east facing · ₹2.25 Cr', note: 'CEO: Reel Friday 6pm, Story same day',
    channels: { igStory: { status: 'live', at: NOW - 5 * H, liveAt: NOW - 5 * H, url: '' }, igReel: { status: 'scheduled', at: NOW - 2 * H }, fbReel: { status: 'scheduled', at: NOW + 26 * H }, yt: { status: 'na' } } }),
  mk({ id: 'VLCA002', propertyCode: 'VLCA002', tags: ['Resale', 'Collab'], title: 'Velachery 3BHK', location: 'Velachery', propertyId: 'VLCA002',
    photosLink: 'https://drive.google.com/drive/folders/demo2', details: '3BHK · 1450 sqft · gated community',
    brochure: { done: true, at: NOW - D, by: 'admin@3pin.in' },
    channels: { igStory: { status: 'live', at: NOW - D, liveAt: NOW - D, url: 'https://instagram.com/stories/demo/1' }, igReel: { status: 'live', at: NOW - 60 * D, liveAt: NOW - 60 * D, url: 'https://instagram.com/reel/demo2' }, fbReel: { status: 'scheduled', at: NOW + 3 * H }, yt: { status: 'yet' } },
    acres99: { status: 'posted', url: 'https://99acres.com/demo-velachery', at: NOW - D } }),
  mk({ id: 'NOL001', propertyCode: 'NOL001', tags: ['New Dev.'], title: '4BHK Individual house', location: 'Nolambur', photosLink: '', details: '',
    note: 'Owner wants it posted only after the weekend' }),
  mk({ id: 'ADB014', propertyCode: 'ADB014', tags: ['Resale'], title: 'Adambakkam 2BHK', location: 'Adambakkam', propertyId: 'ADB014',
    photosLink: 'https://drive.google.com/drive/folders/demo4', details: '2BHK · 950 sqft · ready to move',
    brochure: { done: true, at: NOW - 2 * D, by: 'admin@3pin.in' },
    channels: { igStory: { status: 'live', at: NOW - 2 * D, liveAt: NOW - 2 * D, url: 'https://instagram.com/stories/demo/4' }, igReel: { status: 'live', at: NOW - 2 * D, liveAt: NOW - 2 * D, url: 'https://instagram.com/reel/demo4' }, fbReel: { status: 'live', at: NOW - 2 * D, liveAt: NOW - 2 * D, url: 'https://facebook.com/reel/demo4' }, yt: { status: 'live', at: NOW - 2 * D, liveAt: NOW - 2 * D, url: 'https://youtube.com/watch?v=demo4' } },
    acres99: { status: 'posted', url: 'https://99acres.com/demo-adambakkam', at: NOW - 2 * D }, website: { status: 'posted', url: 'https://3pinrealty.com/p/ADB014', at: NOW - 2 * D } }),
  mk({ id: 'KOT007', propertyCode: 'KOT007', tags: ['Plot'], title: 'Plot, Kottivakkam', location: 'Kottivakkam',
    photosLink: 'https://drive.google.com/drive/folders/demo5', details: '2400 sqft plot · DTCP approved',
    channels: { igStory: { status: 'scheduled', at: NOW + 2 * D }, igReel: { status: 'scheduled', at: NOW + 2 * D + 2 * H }, fbReel: { status: 'yet' }, yt: { status: 'na' } },
    acres99: { status: 'na' } })
];

// This week's plan, exactly as the CEO sends it — the rows start as references only.
const MONDAY = mondayOf(NOW);
const PLAN = `THIS WEEK
Monday -S - Lux49 - 4Bhk
Tuesday - Velachery 2Bhk
Wednesday -S- Eden villas rent
Thursday - Kodambakkam commercial rent
Friday -S- Brigade stellaris velachery
Saturday - T nagar pushkar 3Bhk
Sunday - Nandanam 3Bhk brand new
Youtube - T nagar series`;
{
  const items = parsePlan(PLAN, MONDAY).items;
  const vel = items.find(i => /Velachery 2Bhk/.test(i.reference));
  if (vel) vel.tag = { repostOf: 'VLCA002' };          // Velachery went out last week — this is a repost
  postings = postings.concat(planRows(items, MONDAY, postings, NOW - 2 * H, 'admin@3pin.in').map(r => ({ ...r, tenantId: T })));
  // The repost goes out as a Reel on Friday evening — its cell shows last time's Reel above it.
  const rp = postings.find(p => p.repostOf === 'VLCA002');
  if (rp) rp.channels = { ...rp.channels, igReel: { status: 'scheduled', at: MONDAY + 4 * D + 18 * H } };
}

// Three listings to try the brochure panel on: one to link to an existing property, one brand
// new, one whose owner typed the code with an extra zero.
const stageId = k => (defaultStages().find(s => s.key === k) || {}).id;
let listings = [
  { id: 'demo_l1', tenantId: T, title: '2BHK in T Nagar', location: 'T Nagar', config: '2 BHK', stageId: stageId('shoot_done'), media: {}, tags: ['Resale'], ownerInformed: true, createdAt: NOW - 6 * D, updatedAt: NOW - D, stageChangedAt: NOW - D },
  { id: 'demo_l2', tenantId: T, title: 'Villa near ECR', location: 'Kottivakkam', config: '4 BHK', stageId: stageId('shoot_done'), media: {}, tags: ['New Dev.', 'Collab'], createdAt: NOW - 4 * D, updatedAt: NOW - D, stageChangedAt: NOW - D },
  { id: 'demo_l4', tenantId: T, title: '3BHK sea view, Besant Nagar', location: 'Besant Nagar', config: '3 BHK', stageId: stageId('media_ready'), tags: ['Resale', 'Sea view'], media: { photos: true, floorPlan: true, video: true }, need: { photos: true, floorPlan: true, video: true }, photosLink: 'https://drive.google.com/drive/folders/demo4', forPlan: { igStory: true, igReel: true, yt: true }, forDone: { igStory: true, igReel: true }, forVoice: { igStory: 'vo', igReel: 'vo', yt: 'live' }, forVo: { igReel: true }, brochure: { code: 'TBES0004', doneAt: NOW - D }, brochureLink: 'https://drive.google.com/file/d/demo4', ownerInformed: true, createdAt: NOW - 9 * D, updatedAt: NOW - D, stageChangedAt: NOW - D },
  { id: 'demo_l3', tenantId: T, title: 'LUX 49 apartment', location: 'Thiruvanmiyur', stageId: stageId('details'), media: {}, brochure: { code: 'THVA0001' }, createdAt: NOW - 2 * D, updatedAt: NOW - D, stageChangedAt: NOW - 2 * D }
];

const INVENTORY = [
  { id: 'TNAG0002', propertyCode: 'TNAG0002', name: '2BHK Apartment T Nagar', location: 'T Nagar', photosLink: 'https://drive.google.com/drive/folders/demo1', brochureLink: 'https://drive.google.com/file/d/demo-tnag-brochure', detailsText: '2BHK · 1100 sqft · 3rd floor · east facing · close to Pondy Bazaar.' },
  { id: 'THVA001', propertyCode: 'THVA001', name: 'LUX 49 - Manvi Homes', location: 'Thiruvanmiyur', config: '4BHK', startingPrice: '₹5.50 Cr', photosLink: 'https://drive.google.com/drive/folders/demo-lux', brochureLink: 'https://drive.google.com/file/d/demo-lux49', detailsText: 'Ultra-luxury boutique living on Kalakshetra Road.' },
  { id: 'VLCA002', propertyCode: 'VLCA002', name: 'Velachery 3BHK', location: 'Velachery' },
  { id: 'NOL001', propertyCode: 'NOL001', name: '4BHK Individual house', location: 'Nolambur', photosLink: 'https://drive.google.com/drive/folders/demo3', detailsText: '4BHK · 3200 sqft · independent' },
  { id: 'ADB014', propertyCode: 'ADB014', name: 'Adambakkam 2BHK', location: 'Adambakkam' },
  { id: 'MDV021', propertyCode: 'MDV021', name: 'Madipakkam 3BHK', location: 'Madipakkam', photosLink: 'https://drive.google.com/drive/folders/demo6', detailsText: '3BHK · 1300 sqft' },
  { id: 'PRG030', propertyCode: 'PRG030', name: 'Perungudi 2BHK', location: 'Perungudi' }
];

const clone = x => JSON.parse(JSON.stringify(x));
const push = () => { if (window.applyPostingSnapshot) window.applyPostingSnapshot(clone(postings)); };
let history = [];

window.trackFirebase = {
  // Same shape as firebase-sync: an existing row with `paths` takes only those fields.
  async savePosting(t, paths) {
    const i = postings.findIndex(x => x.id === t.id);
    if (i >= 0 && paths) postings[i] = copyPaths({ ...postings[i], updatedAt: t.updatedAt, updatedBy: t.updatedBy }, clone(t), paths);
    else if (i >= 0) postings[i] = { ...postings[i], ...clone(t) }; else postings.push({ ...clone(t), tenantId: T });
    push();
  },
  async savePostings(writes) { for (const w of writes || []) await window.trackFirebase.savePosting(w.t, w.paths); },
  async deletePosting(id) { postings = postings.filter(x => x.id !== id); push(); },
  async saveListing(l) { const i = listings.findIndex(x => x.id === l.id); const c = { ...clone(l), tenantId: T }; if (i >= 0) listings[i] = c; else listings.push(c); },
  async deleteListing(id) { listings = listings.filter(x => x.id !== id); window.applyListingsSnapshot(clone(listings)); },
  async savePipeline() {}, async patchLead() {},
  async getPropertyInternalNotes(id) { return id === 'TNAG0002' ? 'Owner: Mr Raman, call after 6pm. Keys with the watchman.' : ''; },
  async getInventory() { return clone(INVENTORY); },
  async getListingHistory() { return history.slice(); },
  async saveHistory(id, e) { history.push({ ...e, listingId: id }); },
  async deleteHistory(id, eid) { history = history.filter(h => !(h.listingId === id && h.id === eid)); }
};
window.trackAuth = { login: async () => {}, logout: async () => { location.href = 'propertytrack.html'; }, getTenantId: () => T, getIdToken: async () => null };

// Demo mode never posts to the real brochure form — see brochure-panel.js.
window.__demoMode = true;

// A visible reminder, so nobody mistakes this for the live data.
const bar = document.createElement('div');
bar.textContent = 'Demo data';
bar.title = 'Sample data on this computer only. Changes reset when you reload. Nothing is saved to Firebase.';
bar.style.cssText = 'position:fixed;right:16px;bottom:14px;z-index:9999;background:rgba(20,18,15,.82);color:#FFD9A8;font:600 11.5px system-ui,sans-serif;padding:5px 11px;border-radius:99px;letter-spacing:.02em;box-shadow:0 4px 14px rgba(0,0,0,.18);backdrop-filter:blur(6px);cursor:help';
document.body.appendChild(bar);

setTimeout(() => {
  if (!window.__trackInitialView) window.__trackInitialView = 'posting';   // the demo is for looking at the Posting tab
  window.onTrackAuthChange({ email: 'demo@3pin.in' }, T);
  window.applyTrackPipelineSnapshot(defaultStages());
  window.applyListingsSnapshot(clone(listings));
  window.applyTrackLeadsSnapshot([]);
  if (window.applyTrackTeamSnapshot) window.applyTrackTeamSnapshot({ a: { email: 'swami@3pin.in' }, b: { email: 'pradeep.kumar@3pin.in' }, c: { email: 'anu@3pin.in' } });
  push();
}, 0);
