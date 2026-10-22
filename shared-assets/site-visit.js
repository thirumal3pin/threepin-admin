// ═══════ SITE VISIT CONFIRMATION — the WhatsApp message, and the dialog that writes it ═══════
// One message for every property, written from what the property record says: a rental leads with
// its rent, a sale with its price; a commercial building with its floors and facilities, a home with
// its configuration, area, floor and car parks, land with its extent. A line the record has nothing
// for is left out. Asked of the person each time: only the client's name and the time — the property,
// its map pin, who meets the client there and the client's number come from where they already are
// (the property page, or the CRM lead's site visit booking).
//
// Pure functions (siteVisitFacts, siteVisitMessage, whenWords) are tested in tests/site-visit.test.mjs;
// openSiteVisitDialog is the browser dialog both the Property dashboard and the CRM open.

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAY = 86400000;

const str = v => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
// The inventory sheet writes "----", "-", "N/A" or "0" for "nothing here".
const val = v => { const s = str(v); return /^(-+|—|n\/?a|nil|none|na|0|tba|tbd|null|undefined)$/i.test(s) ? '' : s; };
const pad = n => String(n).padStart(2, '0');
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th','st','nd','rd'][n % 10] || 'th');
const startOfDay = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Always the date — "today, 22nd October" · "tomorrow, 23rd October" · "Saturday, 24th October" — with
// the year when it is not this year.
export function dayWords(at, now) {
  const diff = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  const d = new Date(at);
  const name = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : DAYS[d.getDay()];
  return `${name}, ${ord(d.getDate())} ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date(now).getFullYear() ? ' ' + d.getFullYear() : ''}`;
}
export function timeWords(at) {
  const d = new Date(at), h = d.getHours();
  return `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}
// "today, 22nd October, at 2:00 PM" · "tomorrow, 23rd October, at 11:00 AM" · "Saturday, 24th October, at 12:15 PM"
export function whenWords(at, now) {
  return at ? `${dayWords(at, now)}, at ${timeWords(at)}` : '';
}

// ── What kind of property, and on what terms ──
// Nothing on the record says "rent" — it is in the price ("₹1,30,000/month"), the title ("… for Rent")
// or the WhatsApp details. Commercial can sit under type "Land" ("Commercial Land, H-Block").
const RENT_RE = /\/\s*(month|mo|pm)\b|per\s*month|p\.?\s*m\.?\b|\bmonthly\b|\bfor\s+(rent|lease)\b|\brent(al)?\s*:|\blease\b/i;
const SALE_RE = /\bfor\s+sale\b|\bresale\b|\bcrores?\b|\bcr\b|\blakhs?\b|\bonwards\b/i;
export function dealOf(p) {
  const price = str(p && p.startingPrice), name = str(p && p.name), deal = str(p && (p.dealType || p.listingFor));
  if (/rent|lease/i.test(deal)) return 'rent';
  if (/sale|sell/i.test(deal)) return 'sale';
  if (RENT_RE.test(price)) return 'rent';
  if (/\bfor\s+(rent|lease)\b/i.test(name)) return 'rent';
  if (SALE_RE.test(price) || /\bfor\s+sale\b/i.test(name)) return 'sale';
  const dt = str(p && p.detailsText);
  if (/\bfor\s+(rent|lease)\b|\brent\s*:/i.test(dt) && !/\bfor\s+sale\b|\bprice\s*:/i.test(dt)) return 'rent';
  return 'sale';
}
export function kindOf(p) {
  const t = str(p && p.type).toLowerCase(), name = str(p && p.name).toLowerCase();
  if (/\b(commercial|offices?|office space|retail|shops?|showroom|warehouse|godown|industrial|it space|co-?working)\b/.test(t + ' ' + name)) return 'commercial';
  if (/land|plot/.test(t) && !/building|house|villa|apartment/.test(t)) return 'land';
  return 'residential';
}

// A number of square feet, written the way the messages write it: "2,514 Sq.Ft."
function sqft(v) {
  const s = val(v);
  if (!s) return '';
  if (/sq\.?\s*f|sft|sq\.?\s*m|acre|cent|ground/i.test(s)) return s.replace(/\s*sq\.?\s*ft\.?/i, ' Sq.Ft.').replace(/\s*\(approx\.?\)/i, '').trim();
  return /^[\d,.\s+–—&-]+(to\s+[\d,.]+)?\+?$/i.test(s) ? s.replace(/\s+to\s+/i, '–') + ' Sq.Ft.' : s;
}
const floorWords = v => { const s = val(v); return !s ? '' : /^\d+$/.test(s) ? `${ord(+s)} Floor` : /floor/i.test(s) ? s : s; };
function parkingWords(p) {
  const n = val(p && p.parking), kind = val(p && p.parkingType);
  if (!n) return '';
  if (/^\d+$/.test(n)) return /\d/.test(kind) ? `${kind} Car Parks` : `${n} ${kind && !/reserved/i.test(kind) ? kind + ' ' : ''}Car Park${n === '1' ? '' : 's'}`;
  return /park/i.test(n) ? n : `${n} Car Parking`;
}
// The money line from the details text when the price field is only a range or empty: "Rent: ₹1,30,000/month".
function fromDetails(p, label) {
  const m = String((p && p.detailsText) || '').match(new RegExp(`${label}\\s*[:\\-–]\\s*(₹?[^\\n|•]+)`, 'i'));
  return m ? str(m[1]).replace(/[*_]+/g, '').replace(/\s*\(?approx\.?\)?$/i, '').trim() : '';
}
const ON_REQUEST = /on\s+request|contact\s+for|call\s+for|\bdm\s+us\b|\benquire\b|\bask\b|^tba$|^-+$/i;
// A price worth writing: has an amount, is not a code typed into the wrong column, and is short enough
// to read in a message (a long list of every variant's price is for the brochure, not the visit).
const priceOk = v => !!v && !ON_REQUEST.test(v) && /\d/.test(v) && !/^[A-Z]{2,}\d{3,}$/.test(v) && v.length <= 110;

// The property-details lines for this property: [{ label, value }], in the order they are written.
export function siteVisitFacts(p) {
  if (!p) return [];
  const kind = kindOf(p), deal = dealOf(p), out = [];
  const add = (label, value) => { const v = str(value); if (v) out.push({ label, value: v }); };
  const join = (...xs) => xs.map(val).filter(Boolean).join(' | ');

  // What it is. The title, without the "for Rent –" the listing wrote for portals.
  const name = str(p.name).replace(/\s+for\s+(rent|sale|lease)\s*[-–—:]\s*/i, ' – ').replace(/\s+for\s+(rent|sale|lease)$/i, '');
  const project = deal === 'sale' && /^new$/i.test(str(p.saleType)) && val(p.builder) && !/individual|owner/i.test(p.builder);
  add(project ? 'Project' : 'Property', name);

  // Where: the locality, and a landmark when it is short enough to read as one.
  const lm = val(p.nearbyLandmark), loc = val(p.location);
  const lmOk = lm && lm.length <= 40 && !/[,;]/.test(lm) && !loc.toLowerCase().includes(lm.toLowerCase()) && !/\(|\bnear\b/i.test(loc);
  add('Location', [loc, lmOk ? (/^(near|next|opp|behind|close|beside|adjacent|off|on|\d)/i.test(lm) ? `(${lm})` : `(Near ${lm})`) : ''].filter(Boolean).join(' '));

  const built = sqft(p.builtupArea) || sqft(p.sqftRange) || sqft(p.superBuiltupArea) || sqft(p.carpetArea);
  const land = sqft(p.plotSize) || sqft(p.totalLandArea);
  if (kind === 'commercial') {
    const bld = sqft(p.builtupArea) || (/land|plot/i.test(str(p.type)) ? '' : built);
    add('Building', join(bld, p.totalFloors && /\d|floor|stilt|ground|g\s*\+/i.test(p.totalFloors) ? str(p.totalFloors) : '', /^new$/i.test(str(p.saleType)) ? 'Brand New' : ''));
    if (land && land !== bld) add('Land Area', land);
    const fac = [parkingWords(p), ...str(p.amenities).split(/[,;]/).map(val).filter(Boolean)].filter(Boolean).slice(0, 4);
    add('Facilities', fac.join(', '));
  } else if (kind === 'land') {
    add('Land Area', land || built);
    add('Facing', val(p.facing));
    add('Approval', val(p.approval));
  } else {
    const cfg = val(p.config);
    add('Configuration', cfg && !/^multiple$/i.test(cfg) ? cfg : '');
    if (built) add('Area', join(built, floorWords(p.floorNo), parkingWords(p)));
    else { add('Floor', floorWords(p.floorNo)); add('Parking', parkingWords(p)); }
    if (deal === 'sale') add('UDS', sqft(p.uds));
    if (deal === 'rent') add('Furnishing', val(p.furnishing));
  }
  // Availability only when it says something ("3 Units") — "Available" is what a visit already implies.
  const av = val(p.availability);
  if (av && !/^(available|yes|sold|sold out|immediate)$/i.test(av)) add('Availability', av);

  // The money: the rent with its maintenance, or the price — never "Price on Request".
  const price = val(p.startingPrice);
  if (deal === 'rent') {
    const rent = priceOk(price) ? price : fromDetails(p, 'rent');
    // Maintenance when there is one rent to add it to (two options each have their own).
    const maint = /\|/.test(rent) ? '' : val(p.maintenance) || fromDetails(p, 'maintenance');
    if (rent) add(/sq/i.test(rent) ? 'Rent' : 'Monthly Rent', rent + (maint && !/maint/i.test(rent) ? ` + ${maint} Maintenance` : ''));
  } else if (priceOk(price)) {
    add('Price', price);
  }
  return out;
}

// ── The message ──
// o = { name, title: 'Mr.'|'Ms.'|'Dr.'|'Sir'|"Ma'am"|'', at, now, map, location, facts (override),
//       host: { kind: 'team'|'caretaker'|'owner'|'', name, phone } }
export function siteVisitMessage(p, o = {}) {
  const now = o.now || Date.now();
  const facts = [...(o.facts || siteVisitFacts(p))];
  if (o.location != null) {
    const i = facts.findIndex(f => f.label === 'Location');
    if (str(o.location)) { if (i >= 0) facts[i] = { label: 'Location', value: str(o.location) }; else facts.splice(1, 0, { label: 'Location', value: str(o.location) }); }
  }
  const name = str(o.name), title = str(o.title);
  const greet = !name ? 'Dear Sir/Ma\'am,'
    : /^(sir|ma'?am|madam)$/i.test(title) ? `Dear ${name} ${title},`
    : title ? `Dear ${title} ${name},` : `Dear ${name},`;
  const when = whenWords(o.at, now);
  const lines = [
    `${p && kindOf(p) === 'commercial' ? '🏢' : '🏡'} *SITE VISIT CONFIRMATION | 3 PIN REALTY*`, '',
    greet, '',
    when ? `Your site visit has been confirmed for *${when}.*` : 'Your site visit has been confirmed.', ''
  ];
  if (facts.length) lines.push('📍 *Property Details*', '', ...facts.map(f => `• *${f.label}:* ${f.value}`), '');
  const map = str(o.map != null ? o.map : p && p.mapLink);
  if (/^https?:\/\//i.test(map)) lines.push('📌 *Google Maps Location:*', map, '');
  const h = o.host || {}, hn = str(h.name), ph = str(h.phone);
  if (h.kind === 'team' && hn) {
    lines.push(`${hn} from 3 PIN Realty will meet you at the location and assist you with the site visit.`, '');
    if (ph) lines.push(`📞 *Contact:* ${ph}`, '');
  } else if (h.kind === 'caretaker' || h.kind === 'owner') {
    lines.push(`The ${h.kind} will assist you during the site visit.`, '');
    if (ph) lines.push(`📞 *Contact:* ${ph}`, '');
  }
  lines.push('Please let us know if you need any assistance before the visit or if there are any changes to your schedule.', '',
    'Thank you!', '', '*Team 3 PIN Realty*');
  return lines.join('\n');
}

// A phone number for wa.me: digits only, India's 91 in front of a bare ten-digit mobile.
export function waNumber(v) {
  let d = String(v || '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10) d = '91' + d;
  return d.length >= 11 && d.length <= 15 ? d : '';
}
export const prettyPhone = v => { const d = String(v || '').replace(/\D/g, '').replace(/^(91)(?=\d{10}$)/, ''); return d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : str(v); };

// ═══════ THE DIALOG ═══════
// opts = {
//   property        the property (Property dashboard) — or
//   properties      the inventory to pick from (CRM), with propertyKey: the one booked on the visit
//   name, phone     the client (CRM: the lead)
//   at              the visit time (CRM: the booking); else the next half hour
//   team            [{ name, email }] for "who meets them"; host: the name booked (CRM: the agent sent)
//   toast(msg)      the page's toast
//   onSaveMap(p, url)  keep a pasted Maps link on the property (the Property dashboard)
// }
const HOSTS_KEY = 'pinSiteVisitHosts';   // { name → phone } typed on this device
const SEED_PHONES = { thirumal: '99418 80088' };
const hostPhones = () => { try { return JSON.parse(localStorage.getItem(HOSTS_KEY)) || {}; } catch (e) { return {}; } };
const phoneFor = name => { const k = str(name).toLowerCase(); return hostPhones()[k] || SEED_PHONES[k.split(' ')[0]] || ''; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const keyOf = p => (p && (p.propertyCode && !/^\d+$/.test(p.propertyCode) ? p.propertyCode : p.name)) || '';

const CSS = `
#svmModal{position:fixed;inset:0;z-index:900;background:rgba(20,18,15,.55);display:none;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
#svmModal.open{display:flex}
#svmModal .svm-box{background:var(--card,var(--white,#fff));color:var(--ink,#1c1917);border-radius:14px;width:100%;max-width:640px;box-shadow:0 20px 50px rgba(0,0,0,.25);display:flex;flex-direction:column;max-height:calc(100dvh - 48px)}
#svmModal .svm-hdr{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border,#e7e5e4)}
#svmModal .svm-hdr b{font-size:16px}
#svmModal .svm-x{border:0;background:none;font-size:22px;line-height:1;cursor:pointer;color:var(--ink3,#78716c)}
#svmModal .svm-body{padding:16px 20px;overflow-y:auto}
#svmModal .svm-for{font-size:12.5px;color:var(--ink3,#78716c);margin:0 0 12px}
#svmModal .svm-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 12px}
#svmModal .svm-f{display:flex;flex-direction:column;gap:4px;min-width:0}
#svmModal .svm-f.wide{grid-column:1/-1}
#svmModal label{font-size:12px;font-weight:600;color:var(--ink2,#44403c)}
#svmModal .svm-opt{font-weight:400;color:var(--ink3,#78716c)}
#svmModal input,#svmModal select,#svmModal textarea{width:100%;box-sizing:border-box;font:inherit;font-size:13.5px;padding:8px 10px;border:1px solid var(--border,#d6d3d1);border-radius:8px;background:var(--bg,#fafaf9);color:var(--ink,#1c1917)}
#svmModal input:focus,#svmModal select:focus,#svmModal textarea:focus{outline:none;border-color:var(--brand,#fe8d00);background:var(--card,var(--white,#fff))}
#svmModal .svm-row{display:flex;gap:6px}
#svmModal .svm-row > *{flex:1;min-width:0}
#svmModal .svm-chips{display:flex;gap:5px;flex-wrap:wrap}
#svmModal .svm-chips button{border:1px solid var(--border,#d6d3d1);background:var(--bg,#fafaf9);color:var(--ink2,#44403c);border-radius:99px;padding:4px 11px;font-size:12.5px;cursor:pointer}
#svmModal .svm-chips button.on{background:var(--ink,#1c1917);border-color:var(--ink,#1c1917);color:var(--card,#fff)}
#svmModal .svm-hint{font-size:11.5px;color:var(--ink3,#78716c)}
#svmModal .svm-hint.warn{color:var(--amber,#b45309)}
#svmModal .svm-save{display:flex;align-items:center;gap:6px;font-weight:400;font-size:12px;color:var(--ink2,#44403c);margin-top:2px}
#svmModal .svm-save input{width:auto;margin:0}
#svmModal details{margin-top:12px}
#svmModal summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--ink2,#44403c)}
#svmModal .svm-msghdr{display:flex;justify-content:space-between;align-items:center;margin:14px 0 6px;font-size:12.5px}
#svmModal .svm-link{border:0;background:none;color:var(--ink3,#78716c);font-size:12px;cursor:pointer;text-decoration:underline;padding:0}
#svmModal textarea{min-height:260px;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12.5px;line-height:1.55;resize:vertical}
#svmModal .svm-ftr{display:flex;gap:8px;justify-content:flex-end;padding:12px 20px;border-top:1px solid var(--border,#e7e5e4);flex-wrap:wrap}
#svmModal .svm-btn{border:1px solid var(--border,#d6d3d1);background:var(--card,#fff);color:var(--ink,#1c1917);border-radius:9px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer}
#svmModal .svm-btn.primary{background:#25D366;border-color:#25D366;color:#fff}
@media (max-width:560px){#svmModal .svm-grid{grid-template-columns:1fr}#svmModal .svm-ftr .svm-btn{flex:1}}
`;

let S = null;   // the dialog's state while open
const $ = id => document.getElementById(id);

function mount() {
  if ($('svmModal')) return;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const el = document.createElement('div');
  el.id = 'svmModal';
  el.innerHTML = `<div class="svm-box" role="dialog" aria-modal="true" aria-labelledby="svmTitle">
    <div class="svm-hdr"><b id="svmTitle">Site visit confirmation</b><button type="button" class="svm-x" data-svm="close" aria-label="Close">×</button></div>
    <div class="svm-body">
      <p class="svm-for" id="svmFor"></p>
      <div class="svm-grid">
        <div class="svm-f wide" id="svmPropWrap" hidden><label for="svmProp">Property</label><select id="svmProp"></select></div>
        <div class="svm-f"><label for="svmName">Client's name</label><input id="svmName" type="text" placeholder="Nitin" autocomplete="off"></div>
        <div class="svm-f"><label>Address as</label><div class="svm-chips" id="svmTitles">${['Mr.', 'Ms.', 'Sir', "Ma'am", ''].map(t => `<button type="button" data-title="${esc(t)}">${t ? esc(t) : 'Name only'}</button>`).join('')}</div></div>
        <div class="svm-f"><label for="svmDay">Day</label><input id="svmDay" type="date"></div>
        <div class="svm-f"><label for="svmTime">Time</label><select id="svmTime"></select></div>
        <div class="svm-f"><label for="svmHost">Who meets them <span class="svm-opt">optional</span></label><select id="svmHost"></select></div>
        <div class="svm-f"><label for="svmHostPhone">Their number <span class="svm-opt">optional</span></label><input id="svmHostPhone" type="tel" placeholder="99418 80088"></div>
        <div class="svm-f wide" id="svmHostNameWrap" hidden><label for="svmHostName">Name</label><input id="svmHostName" type="text" placeholder="Who meets the client" autocomplete="off"></div>
        <div class="svm-f wide"><label for="svmMap">Google Maps location</label><input id="svmMap" type="url" placeholder="https://maps.app.goo.gl/…"><span class="svm-hint" id="svmMapHint"></span><label class="svm-save" id="svmSaveMapWrap" hidden><input type="checkbox" id="svmSaveMap" checked> <span id="svmSaveMapText"></span></label></div>
      </div>
      <details id="svmMore"><summary>More — location wording, client's WhatsApp</summary>
        <div class="svm-grid" style="margin-top:10px">
          <div class="svm-f wide"><label for="svmLoc">Location as written</label><input id="svmLoc" type="text"></div>
          <div class="svm-f wide"><label for="svmPhone">Client's WhatsApp number <span class="svm-opt">opens their chat directly</span></label><input id="svmPhone" type="tel" placeholder="98400 12345"></div>
        </div>
      </details>
      <div class="svm-msghdr"><b>Message</b><button type="button" class="svm-link" data-svm="rewrite" id="svmRewrite" hidden>Undo my edits — rewrite from the fields</button></div>
      <textarea id="svmMsg" spellcheck="false" aria-label="The message"></textarea>
    </div>
    <div class="svm-ftr">
      <button type="button" class="svm-btn" data-svm="close">Close</button>
      <button type="button" class="svm-btn" data-svm="copy">📋 Copy</button>
      <button type="button" class="svm-btn primary" data-svm="wa">💬 WhatsApp</button>
    </div>
  </div>`;
  document.body.appendChild(el);
  // In the CRM the property is picked: typed for by its code, its title or its details (property-picker.js).
  if (window.PinPropertyPicker) window.PinPropertyPicker.attach($('svmProp'), {
    lookup: v => (S && v && S.properties.find(p => keyOf(p) === v)) || null,
    placeholder: 'Type a code, a name, an area, BHK… or pick'
  });
  el.addEventListener('click', e => {
    if (e.target === el) return close();
    const t = e.target.closest('[data-svm],[data-title]');
    if (!t) return;
    if (t.dataset.title != null) { S.title = t.dataset.title; paintTitles(); return refresh(); }
    ({ close, copy, wa: whatsapp, rewrite: () => { S.edited = false; refresh(); } })[t.dataset.svm]();
  });
  el.addEventListener('input', e => {
    if (e.target.id === 'svmMsg') { S.edited = true; $('svmRewrite').hidden = false; return; }
    if (e.target.id === 'svmMap') S.mapTyped = true;
    if (e.target.id === 'svmLoc') S.locTyped = true;
    refresh();
  });
  el.addEventListener('change', e => {
    if (e.target.id === 'svmProp') { S.property = S.properties.find(p => keyOf(p) === e.target.value) || null; S.mapTyped = S.locTyped = false; fillProperty(); }
    if (e.target.id === 'svmHost') pickHost();
    refresh();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('svmModal').classList.contains('open')) close(); });
}
function paintTitles() { [...$('svmTitles').children].forEach(b => b.classList.toggle('on', b.dataset.title === S.title)); }
function timeOptions(sel) {
  let out = '', found = false;
  for (let m = 6 * 60; m <= 22 * 60; m += 15) {
    const v = `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, h = Math.floor(m / 60);
    if (v === sel) found = true;
    out += `<option value="${v}"${v === sel ? ' selected' : ''}>${h % 12 || 12}:${pad(m % 60)} ${h < 12 ? 'AM' : 'PM'}</option>`;
  }
  return found || !sel ? out : `<option value="${sel}" selected>${sel}</option>` + out;
}
function fillProperty() {
  const p = S.property;
  $('svmFor').textContent = p ? [p.propertyCode, p.name].filter(Boolean).join(' · ') : 'Pick the property';
  const map = p ? str(p.mapLink) : '';
  const real = /^https?:\/\//i.test(map);
  if (!S.mapTyped) $('svmMap').value = real ? map : '';
  $('svmMapHint').textContent = !p ? '' : real ? 'From the property’s map pin.' : map ? `The property only has “${map}” as its pin — paste the Maps link.` : 'This property has no map pin yet — paste the Maps link.';
  $('svmMapHint').className = 'svm-hint' + (real ? '' : ' warn');
  const loc = p ? (siteVisitFacts(p).find(f => f.label === 'Location') || {}).value || '' : '';
  if (!S.locTyped) $('svmLoc').value = loc;
}
function pickHost() {
  const v = $('svmHost').value;
  $('svmHostNameWrap').hidden = v !== 'other';
  const name = v.startsWith('team:') ? v.slice(5) : '';
  $('svmHostPhone').value = name ? phoneFor(name) : '';
}
function hostNow() {
  const v = $('svmHost').value, phone = str($('svmHostPhone').value);
  if (v.startsWith('team:')) return { kind: 'team', name: v.slice(5), phone };
  if (v === 'other') return { kind: 'team', name: str($('svmHostName').value), phone };
  if (v === 'caretaker' || v === 'owner') return { kind: v, phone };
  return { kind: '' };
}
function atNow() {
  const d = $('svmDay').value, t = $('svmTime').value;
  if (!d) return 0;
  const [y, m, dd] = d.split('-').map(Number), [h, mi] = (t || '10:00').split(':').map(Number);
  return new Date(y, m - 1, dd, h, mi).getTime();
}
// A Maps link pasted for a property that has none (or another): offered to be kept on the property.
function newMap() {
  const m = str($('svmMap').value);
  return S.onSaveMap && S.property && /^https?:\/\//i.test(m) && m !== str(S.property.mapLink) ? m : '';
}
function saveMap() {
  const m = newMap();
  if (m && $('svmSaveMap').checked) { S.onSaveMap(S.property, m); S.mapTyped = false; }
}
function refresh() {
  if (!S) return;
  $('svmSaveMapWrap').hidden = !newMap();
  if (newMap()) $('svmSaveMapText').textContent = /^https?:\/\//i.test(str(S.property.mapLink))
    ? 'Update the property’s map pin to this link (and note it)'
    : 'Save this link as the property’s map pin (and note it) — next time it is filled in';
  if (S.edited) return;
  $('svmRewrite').hidden = true;
  $('svmMsg').value = siteVisitMessage(S.property, {
    name: $('svmName').value, title: S.title, at: atNow(), map: $('svmMap').value,
    location: S.locTyped ? $('svmLoc').value : null, host: hostNow()
  });
}
function remember() {
  const h = hostNow();
  if (h.kind !== 'team' || !h.name || !h.phone) return;
  const all = hostPhones(); all[h.name.toLowerCase()] = h.phone;
  try { localStorage.setItem(HOSTS_KEY, JSON.stringify(all)); } catch (e) {}
}
function close() { $('svmModal').classList.remove('open'); S = null; }
function copy() {
  remember(); saveMap();
  const text = $('svmMsg').value, done = () => S && S.toast('Site visit message copied');
  const fallback = () => { const ta = $('svmMsg'); ta.select(); try { document.execCommand('copy'); } catch (e) {} done(); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
}
function whatsapp() {
  remember(); saveMap();
  window.open(`https://wa.me/${waNumber($('svmPhone').value)}?text=${encodeURIComponent($('svmMsg').value)}`, '_blank', 'noopener');
}

export function openSiteVisitDialog(opts = {}) {
  mount();
  const list = opts.properties || (opts.property ? [opts.property] : []);
  const pick = opts.property || list.find(p => opts.propertyKey && (keyOf(p) === opts.propertyKey || str(p.propertyCode).toUpperCase() === str(opts.propertyKey).toUpperCase() || str(p.name) === opts.propertyKey)) || null;
  S = { property: pick, properties: list, title: opts.title != null ? opts.title : '', edited: false, mapTyped: false, locTyped: false, toast: opts.toast || (() => {}), onSaveMap: opts.onSaveMap || null };
  // The property: fixed on its own page; picked from the inventory in the CRM (the booked one first).
  const wrap = $('svmPropWrap');
  wrap.hidden = !opts.properties;
  if (opts.properties) {
    const sorted = [...list].filter(p => keyOf(p)).sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    $('svmProp').innerHTML = `<option value="">Pick the property…</option>` + sorted.map(p => `<option value="${esc(keyOf(p))}"${p === pick ? ' selected' : ''}>${esc([p.propertyCode && !/^\d+$/.test(p.propertyCode) ? p.propertyCode : '', p.name].filter(Boolean).join(' — '))}</option>`).join('');
  }
  $('svmName').value = str(opts.name);
  paintTitles();
  // When: the booking, else the next half hour (from 7 PM on: tomorrow at 11).
  let at = opts.at;
  if (!at) {
    const d = new Date(); d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
    if (d.getHours() >= 19 || d.getHours() < 7) { if (d.getHours() >= 19) d.setDate(d.getDate() + 1); d.setHours(11, 0); }
    at = d.getTime();
  }
  const a = new Date(at);
  $('svmDay').value = `${a.getFullYear()}-${pad(a.getMonth() + 1)}-${pad(a.getDate())}`;
  $('svmTime').innerHTML = timeOptions(`${pad(a.getHours())}:${pad(a.getMinutes())}`);
  // Who meets them: the team by name, the caretaker, the owner, someone else — or nobody named.
  const team = (opts.team || []).map(t => str(t.name)).filter(Boolean);
  const host = str(opts.host);
  $('svmHost').innerHTML = `<option value="">Nobody named</option>`
    + team.map(n => `<option value="team:${esc(n)}"${n === host ? ' selected' : ''}>${esc(n)}</option>`).join('')
    + `<option value="caretaker">The caretaker</option><option value="owner">The owner</option><option value="other">Someone else…</option>`;
  $('svmHostName').value = '';
  pickHost();
  $('svmPhone').value = opts.phone ? prettyPhone(opts.phone) : '';
  $('svmMore').open = false;
  fillProperty();
  refresh();
  $('svmModal').classList.add('open');
  setTimeout(() => (opts.name ? $('svmTime') : $('svmName')).focus(), 50);
}
