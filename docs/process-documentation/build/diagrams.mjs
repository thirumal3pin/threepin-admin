// Animated SVG diagrams for the HTML edition. Boxes are always visible;
// motion is additive (moving tokens, flowing connectors, pulses) so the page
// is complete at rest and under prefers-reduced-motion.

const box = (x, y, w, h, cls, lines) => {
  const [k, n, s] = lines;
  return `<g class="bx ${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>` +
    (k ? `<text class="k" x="${x + 14}" y="${y + 19}">${k}</text>` : '') +
    (n ? `<text class="n" x="${x + 14}" y="${y + (k ? 37 : 26)}">${n}</text>` : '') +
    (s ? `<text class="s" x="${x + 14}" y="${y + (k ? 53 : 43)}">${s}</text>` : '') + `</g>`;
};

export const heroTrack = () => {
  const stages = [
    ['CRM', 'Seller enquiry'], ['S&M', 'Card created'], ['S&M', 'Onboard'], ['GATE', 'Swami approves'],
    ['PROP', 'Brochure v1'], ['S&M', 'Shoot'], ['S&M', 'Edit + V/O'], ['POST', 'Posted + URL'],
    ['CRM', 'Visits'], ['FIN', 'Won · billed'],
  ];
  const cls = { CRM: 'm-crm', 'S&M': 'm-sm', PROP: 'm-prop', POST: 'm-post', FIN: 'm-fin', GATE: 'm-gate' };
  const w = 1000, step = 96, x0 = 44;
  let s = `<svg class="dg hero-track" viewBox="0 0 ${w} 170" role="img" aria-label="A property's path through the five consoles">`;
  s += `<path id="trackPath" class="track" d="M${x0} 92 H${x0 + step * 9}"/>`;
  stages.forEach(([m, label], i) => {
    const cx = x0 + i * step;
    s += `<g class="stop ${cls[m]}" style="--i:${i}"><circle cx="${cx}" cy="92" r="${m === 'GATE' ? 9 : 11}"/>` +
      `<text class="stop-k" x="${cx}" y="62" text-anchor="middle">${m === 'GATE' ? 'OWNER' : m.replace('S&M', 'S&amp;M')}</text>` +
      `<text class="stop-n" x="${cx}" y="126" text-anchor="middle">${label}</text></g>`;
  });
  s += `<g class="token"><circle r="7"/><animateMotion dur="9s" repeatCount="indefinite" calcMode="linear"><mpath href="#trackPath"/></animateMotion></g>`;
  return s + `</svg>`;
};

export const lifecycle = () => {
  let s = `<svg class="dg" viewBox="0 0 760 768" role="img" aria-label="A property moves through five consoles, with two owner gates">`;
  s += `<path id="lifePath" class="flowline" d="M380 70 V170 V250 V318 V388 M380 388 H140 V420 M380 388 V420 M380 388 H620 V420 M140 480 V500 H380 M620 480 V500 H380 M380 480 V528 M380 588 V602"/>`;
  s += `<path id="lifeSpine" class="spine-hidden" d="M380 70 V700"/>`;
  s += box(200, 30, 360, 60, 'm-crm', ['CRM', 'Seller enquiry arrives', 'TailorTalk chat, Add Lead form, or a board card']);
  s += box(200, 110, 360, 60, 'm-sm', ['SHOOT &amp; MEDIA', 'A card is created automatically', 'Every seller lead gets a card']);
  s += box(200, 190, 360, 60, 'm-sm', ['SHOOT &amp; MEDIA', 'Onboard the owner', 'Listing type, price, terms']);
  s += `<g class="gate"><polygon points="256,318 380,290 504,318 380,346"/><text class="n" x="380" y="323" text-anchor="middle">Swami approves</text></g>`;
  s += box(30, 420, 220, 60, 'm-prop', ['PROPERTY · BROCHURE', 'Details &amp; brochure v1', 'PDF in about 30 min']);
  s += box(270, 420, 220, 60, 'm-sm', ['SHOOT &amp; MEDIA', 'Documents', 'EC, patta · never blocks']);
  s += box(510, 420, 220, 60, 'm-sm', ['SHOOT &amp; MEDIA', 'Shoot', 'Book → shoot → raw photos']);
  s += box(200, 528, 360, 60, 'm-prop', ['PROPERTY DASHBOARD', 'Map the card to the property', 'By hand · one property, one card']);
  s += `<g class="gate"><polygon points="256,628 380,602 504,628 380,654"/><text class="n" x="380" y="633" text-anchor="middle">Swami plans the post</text></g>`;
  s += box(30, 688, 220, 60, 'm-sm', ['EDITOR', 'Edit per outlet + V/O', 'Plan → start → done']);
  s += box(270, 688, 220, 60, 'm-post', ['POSTING', 'Confirm posted + URL', 'Card moves to Live']);
  s += box(510, 688, 220, 60, 'm-fin', ['CRM · FINANCE', 'Visits, won, billed', 'Token → invoice → paid']);
  s += `<path class="flowline" d="M380 654 V670 H140 V688 M380 670 V688 M380 670 H620 V688"/>`;
  s += `<g class="token"><circle r="6"/><animateMotion dur="7s" repeatCount="indefinite"><mpath href="#lifeSpine"/></animateMotion></g>`;
  return s + `</svg>`;
};

export const architecture = () => {
  let s = `<svg class="dg" viewBox="0 0 760 560" role="img" aria-label="Every console works on one database; the API and the Mac reach outside">`;
  const flows = ['M190 96 V128', 'M190 290 V330', 'M570 290 V330', 'M346 366 H414', 'M570 402 V420 H100 V440', 'M570 420 H290 V440', 'M570 420 H480 V440', 'M570 420 H660 V440', 'M100 512 V496'];
  flows.forEach((d, i) => { s += `<path class="flow f${i % 3}" d="${d}"/>`; });
  s += box(30, 40, 320, 56, '', ['', 'Team', 'Agents, owner, shooter, editor, accounts']);
  s += box(410, 40, 320, 56, '', ['', 'Customers', 'WhatsApp, Instagram, website chat']);
  s += `<g class="bx grp"><rect x="30" y="128" width="700" height="162" rx="12"/><text class="n" x="46" y="152">Five consoles in the browser</text></g>`;
  [['Home', 'launcher', 'm-home'], ['Property', 'dashboard', 'm-prop'], ['CRM', 'leads, visits', 'm-crm'], ['Shoot &amp; Media', 'board, posting', 'm-sm'], ['Finance', 'the books', 'm-fin']]
    .forEach(([n, sub, c], i) => { s += box(46 + i * 136, 166, 124, 56, c, ['', n, sub]); });
  s += box(46, 234, 668, 44, 'dash', ['', 'Shared layer — nav rail · match engine · lead views · theme · map', '']);
  s += `<g class="bx core"><rect x="30" y="330" width="316" height="72" rx="10"/><text class="n" x="46" y="356">Firebase — system of record</text><text class="s" x="46" y="376">Sign-in with tenant tag · Firestore</text><text class="s" x="46" y="392">Storage for finance files</text></g>`;
  s += box(414, 330, 316, 72, '', ['', 'Vercel API', '12 functions · 4 daily jobs · webhooks']);
  [['Google Workspace', 'Sheets, Drive, Calendar'], ['AI models', 'Gemini, Claude Haiku'], ['Gmail + Meta', 'Email, WhatsApp digest'], ['TailorTalk', 'AI chat agent']]
    .forEach(([n, sub], i) => { s += box(30 + i * 180, 440, 160, 56, '', ['', n, sub]); });
  s += box(30, 512, 700, 40, 'dash', ['', 'Owner’s Mac — Claude Cowork builds PDFs → deliver-brochures → sync-inventory', '']);
  s += `<text class="lbl" x="200" y="316">reads and writes, by tenant</text><text class="lbl" x="580" y="316">calls</text>`;
  return s + `</svg>`;
};

export const crmLadder = () => {
  const st = [['New', '2 d'], ['Options sent', '7 d'], ['Send more details', '2 d'], ['Visit planned', '5 d'], ['Visited', '4 d'], ['Negotiating', '14 d'], ['Won', 'person only']];
  let s = `<svg class="dg" viewBox="0 0 760 470" role="img" aria-label="A lead climbs seven milestones; three side columns hold the rest">`;
  st.forEach(([n, d], i) => {
    const y = 30 + i * 58;
    s += `<g class="bx rung ${i === 6 ? 'won' : ''}" style="--i:${i}"><rect x="30" y="${y}" width="250" height="42" rx="10"/><text class="n" x="46" y="${y + 26}">${n}</text><text class="s" x="266" y="${y + 26}" text-anchor="end">${d}</text></g>`;
    if (i < 6) s += `<path class="flowline" d="M155 ${y + 42} V${y + 58}"/>`;
  });
  s += `<path class="flowline" d="M282 51 H320 V368 M282 341 H320"/>`;
  [['Sourcing', 'Nothing to show yet · 3 days', 'warn', 80], ['On hold', 'Reason + revisit date · reopens on reply', 'warn', 210], ['Lost', 'Reason required · reopens on reply', 'bad', 340]]
    .forEach(([n, sub, c, y]) => {
      s += `<path class="flow f1" d="M320 ${y + 28} H456"/>`;
      s += box(460, y, 270, 56, c, ['', n, sub]);
    });
  s += `<text class="lbl" x="330" y="420">from any open stage</text>`;
  s += `<g class="token"><circle r="6"/><animateMotion dur="6s" repeatCount="indefinite" path="M155 51 V399"/></g>`;
  return s + `</svg>`;
};

export const boardFlow = () => {
  const cols = [['New listing', 'Automatic for every seller lead', true], ['Details &amp; docs', 'By hand — details, papers, brochure', false], ['Shoot scheduled', 'Automatic when a shoot is booked', true], ['Shoot done', 'Automatic when Shoot done is saved', true], ['Media ready', 'Automatic when photos, edits, V/O, brochure done', true], ['Live — marketing', 'Automatic when a post is confirmed live', true], ['Sold / Rented', 'By hand when the deal closes', false]];
  let s = `<svg class="dg" viewBox="0 0 760 480" role="img" aria-label="Five of the seven moves on the board happen by themselves">`;
  cols.forEach(([n, how, auto], i) => {
    const y = 24 + i * 64;
    s += `<g class="bx ${i === 6 ? 'won' : 'm-sm'}"><rect x="30" y="${y}" width="230" height="44" rx="10"/><text class="n" x="46" y="${y + 27}">${n}</text></g>`;
    s += `<g class="how ${auto ? 'auto' : ''}" style="--i:${i}"><rect x="280" y="${y + 8}" width="${auto ? 82 : 66}" height="28" rx="14"/><text x="${auto ? 321 : 313}" y="${y + 27}" text-anchor="middle">${auto ? 'Automatic' : 'By hand'}</text><text class="s" x="${auto ? 376 : 360}" y="${y + 27}">${how.replace(/^(Automatic|By hand) ?—? ?/, '')}</text></g>`;
    if (i < 6) s += `<path class="flowline" d="M145 ${y + 44} V${y + 64}"/>`;
  });
  s += `<g class="token"><rect x="-26" y="-10" width="52" height="20" rx="6"/><text x="0" y="5" text-anchor="middle">card</text><animateMotion dur="8s" repeatCount="indefinite" path="M145 46 V430"/></g>`;
  return s + `</svg>`;
};

export const hubCode = () => {
  const nodes = [
    ['Inventory sheet', 'creates the code', 120, 70], ['Brochure request', 'creates the code', 640, 70],
    ['Shoot &amp; Media card', 'mapped by hand', 112, 230], ['Seller lead (CRM)', 'propertyCodes, listingCode', 646, 230],
    ['Buyer leads', 'AI links codes discussed', 120, 390], ['Posting row', 'keyed by code · URLs', 640, 390],
    ['Site-visit invite', 'seller contact by code', 380, 440], ['Finance deal', 'code copied once', 380, 20],
  ];
  let s = `<svg class="dg" viewBox="0 0 760 480" role="img" aria-label="The property code joins every module">`;
  nodes.forEach(([, , x, y], i) => { s += `<path class="flow f${i % 3}" d="M380 240 L${x} ${y + 20}"/>`; });
  s += `<g class="hub"><circle cx="380" cy="240" r="64"/><text class="k" x="380" y="228" text-anchor="middle">PROPERTY CODE</text><text class="code" x="380" y="256" text-anchor="middle">TNAG0002</text></g>`;
  nodes.forEach(([n, sub, x, y]) => {
    s += `<g class="bx node"><rect x="${x - 88}" y="${y}" width="176" height="44" rx="10"/><text class="n" x="${x}" y="${y + 19}" text-anchor="middle">${n}</text><text class="s" x="${x}" y="${y + 35}" text-anchor="middle">${sub}</text></g>`;
  });
  return s + `</svg>`;
};
