// Helpers the match-live scenarios share: drive the page like a person and read what it shows.
import { join } from 'node:path';

// Wait for the search in flight to finish (the count stops saying "Searching…").
export async function settle(page, ms = 30000) {
  await page.waitForFunction(() => {
    const c = document.getElementById('resCount');
    const l = document.getElementById('list');
    const res = document.getElementById('results');
    return l && (res.hidden || (c && c.textContent !== 'Searching…' && !res.hasAttribute('data-loading')));
  }, null, { timeout: ms });
}

// Submit a form and time it: server (the /api/match response) and render (until settled).
export async function timed(page, act) {
  const t0 = Date.now();
  let serverMs = null, status = null, body = null;
  const respP = page.waitForResponse(r => r.url().includes('/api/match'), { timeout: 30000 }).then(async r => { serverMs = Date.now() - t0; status = r.status(); try { body = await r.json(); } catch (e) { /* not json */ } }).catch(() => {});
  await act();
  await respP;
  await settle(page).catch(() => {});
  return { ms: Date.now() - t0, serverMs, status, body };
}

// The toggle: Find properties | Find clients.
export const setFor = (page, v) => page.check(`#forSeg input[value="${v}"]`);
// More options, open (the field-by-field form for the side the toggle is on).
export const moreOptions = page => page.evaluate(() => { document.getElementById('refine').open = true; });

export async function smart(page, text) {
  await page.fill('#q', text);
  return timed(page, () => page.click('#qGo'));
}

// What the results area shows, as plain data.
export async function read(page) {
  return page.evaluate(() => {
    const t = s => (s ? s.textContent.replace(/\s+/g, ' ').trim() : '');
    const rows = [...document.querySelectorAll('#list > li')].map(li => {
      if (li.classList.contains('empty')) return { empty: t(li) };
      if (li.querySelector('.mt-pick')) return { pick: t(li.querySelector('.mt-pick')) };
      return {
        name: t(li.querySelector('h3')), score: t(li.querySelector('.mt-score')), src: t(li.querySelector('.mt-trust')) || t(li.querySelector('.mt-tags')),
        who: t(li.querySelector('.mt-who')), facts: t(li.querySelector('.mt-facts')), kv: t(li.querySelector('.mt-kv')), fits: [...li.querySelectorAll('.mt-fit')].map(t).join(' | '),
        why: [...li.querySelectorAll('.mt-ticks > li')].map(t), next: t(li.querySelector('.mt-next')),
        acts: [...li.querySelectorAll('.mt-acts a, .mt-acts button')].filter(a => a.checkVisibility()).map(a => t(a) + (a.getAttribute('href') ? ' [' + a.getAttribute('href').replace(/\d{6,}/g, '#') + ']' : '')),
        out: li.classList.contains('out'), held: li.classList.contains('held'),
      };
    });
    return {
      title: t(document.getElementById('resTitle')), count: t(document.getElementById('resCount')), note: t(document.getElementById('resNote')),
      tab: document.querySelector('#forSeg input:checked')?.value === 'clients' ? 'tabClients' : 'tabProps',
      refine: t(document.getElementById('readAs')), chips: t(document.getElementById('readAs')), missing: document.getElementById('readMissing').hidden ? '' : t(document.getElementById('readMissing')),
      resultsHidden: document.getElementById('results').hidden, rows,
    };
  });
}

// Strip phone numbers / emails before anything is logged (the data is private).
export const mask = s => String(s).replace(/\+?\d[\d\s-]{8,}\d/g, '[phone]').replace(/[^\s@"]+@[^\s@"]+\.[a-z]{2,}/gi, m => (/threepin\.in$/.test(m) ? m : '[email]'));

export function summary(r, n = 8) {
  const lines = [`  title="${r.title}" count="${r.count}" tab=${r.tab}${r.note ? ' note="' + r.note + '"' : ''}`];
  if (r.chips) lines.push('  chips: ' + r.chips + (r.missing ? ' | ' + r.missing : ''));
  r.rows.slice(0, n).forEach((x, i) => {
    if (x.empty) lines.push('  EMPTY: ' + x.empty);
    else if (x.pick) lines.push('  PICK: ' + x.pick);
    else lines.push(`  ${i + 1}. [${x.score}] ${x.name} | ${x.src} | ${x.facts || x.kv} | ${x.fits} | why: ${x.why.join(' / ')} | ${x.next}${x.who ? ' | who: ' + x.who : ''}${x.out ? ' (OUT)' : ''}`);
  });
  return mask(lines.join('\n'));
}

export const shot = (page, OUT, name, full = false) => page.screenshot({ path: join(OUT, name + '.png'), fullPage: full });

export async function errorsOf(page) {
  const e = [...(page.__errors || []), ...(page.__net || [])];
  page.__errors = []; page.__net = [];
  return e;
}

export async function hscroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
