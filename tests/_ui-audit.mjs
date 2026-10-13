// UI audit — preloaded into any page preview:  node --import ./tests/_ui-audit.mjs tests/x-preview.mjs
//
// Every time a preview takes a screenshot of a page (each view, each width, each state it sets up),
// the same screen is also audited — first as it is, then in the other colour scheme — for what a
// person would notice and a test would not:
//   overflow   the page scrolls sideways (only the board may, inside itself)
//   overlap    two pieces of visible text drawn on top of each other
//   clipped    text cut off by its box with no ellipsis to say so
//   font       text not in Inter (a cascade collision — e.g. a class name an icon font also uses)
//   contrast   text below WCAG AA against what is actually behind it (4.5:1; 3:1 when large)
//   small      text under 11px (eye strain) — reported, judged by hand
//   target     on a phone, a button or link smaller than 24×24px
// Findings go to UI_AUDIT_OUT (JSON lines), one line per screen and scheme.
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = process.env.UI_AUDIT_OUT;
const TEST = process.env.UI_AUDIT_TEST || process.argv[1];

function auditInPage() {
  const issues = [];
  const add = (kind, el, detail) => {
    if (issues.filter(i => i.kind === kind).length >= 12) return;   // examples, not every one
    const id = el ? (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '') : '';
    const text = el ? (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50) : '';
    issues.push({ kind, el: (el ? el.tagName.toLowerCase() : '') + id, text, detail });
  };
  const count = {};
  const bump = k => { count[k] = (count[k] || 0) + 1; };
  const W = innerWidth, H = innerHeight;
  const de = document.documentElement;
  if (de.scrollWidth > W + 1) {
    // Name what sticks out (the outermost elements past the right edge), so it can be fixed.
    const out = [...document.body.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > W + 1 && getComputedStyle(e).position !== 'fixed'; })
      .filter((e, _, all) => !all.some(o => o !== e && o.contains(e))).slice(0, 3)
      .map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + '→' + Math.round(e.getBoundingClientRect().right));
    bump('overflow'); add('overflow', de, de.scrollWidth + 'px wide in a ' + W + 'px window: ' + out.join(', '));
  }

  const parse = c => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  function bgOf(el) {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none' && /gradient|url/.test(cs.backgroundImage)) return null;   // unknowable
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
      if (Number(cs.opacity) < 1) return null;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    if (!stack.length || stack[stack.length - 1].a < 1) { const bc = parse(getComputedStyle(document.body).backgroundColor); if (bc && bc.a >= 1) base = bc; }
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  }
  const isIcon = el => !!el.closest('i, svg, .fa, .fas, .far, .fab, .fa-solid, .fa-regular, .fa-brands, [class*="fa-"], .material-icons');
  const visible = el => { const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
  const textEls = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.nodeValue.trim();
    if (!t) continue;
    const el = n.parentElement;
    if (!el || seen.has(el) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION'].includes(el.tagName)) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    // Only what is visible of the text: a box that clips (an ellipsis, a scroller) hides the rest.
    let clip = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 };
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const st = getComputedStyle(e);
      if (st.overflowX !== 'visible' || st.overflowY !== 'visible') {
        const r = e.getBoundingClientRect();
        clip = { left: Math.max(clip.left, r.left), top: Math.max(clip.top, r.top), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) };
      }
    }
    const rects = [...range.getClientRects()]
      .map(r => ({ left: Math.max(r.left, clip.left), top: Math.max(r.top, clip.top), right: Math.min(r.right, clip.right), bottom: Math.min(r.bottom, clip.bottom) }))
      .map(r => ({ ...r, width: r.right - r.left, height: r.bottom - r.top }))
      .filter(r => r.width > 1 && r.height > 1);
    if (!rects.length) continue;
    const r = rects[0];
    if (r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue;
    if (!visible(el)) continue;
    // Behind something (a dialog, a sticky header)? Then it is not what the person sees.
    const cx = Math.min(W - 1, Math.max(0, r.left + Math.min(r.width, 6))), cy = Math.min(H - 1, Math.max(0, r.top + r.height / 2));
    const top = document.elementFromPoint(cx, cy);
    if (!top || !(top === el || el.contains(top) || top.contains(el))) continue;
    seen.add(el);
    textEls.push({ el, n, t, rects, r });
  }

  for (const { el, t, r } of textEls) {
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    const icon = isIcon(el) || /^[-\s]+$/.test(t) || /^[\p{Extended_Pictographic}️‍\s]+$/u.test(t);
    if (!icon) {
      const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      const codeish = !!el.closest('code, kbd, samp, pre, [class*="code"]');
      if (!codeish && fam !== 'Inter') { bump('font'); add('font', el, fam); }
      // A caret or other lone glyph is decoration, not text to read.
      if (fs < 11 && !/^[▾▴▸◂⌄⌃◍↕↑↓›‹→←✓✕×·•…\s]+$/.test(t)) { bump('small'); add('small', el, fs + 'px'); }
      // A lone separator (·, |, /) is decoration, not text to read (WCAG asks no contrast of it).
      if (!el.closest('[disabled], [aria-disabled="true"], .disabled, [aria-hidden="true"]') && !/^[·•|\/]$/.test(t)) {
        const fg = parse(cs.color), bg = bgOf(el);
        if (fg && bg) {
          const c = over(fg, bg);
          const L1 = lum(c), L2 = lum(bg);
          const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
          const large = fs >= 24 || (fs >= 18.66 && Number(cs.fontWeight) >= 700);
          if (ratio < (large ? 3 : 4.5)) { bump('contrast'); add('contrast', el, ratio.toFixed(2) + ':1 ' + cs.color + ' on rgb(' + [bg.r, bg.g, bg.b].map(Math.round).join(',') + ') [scheme ' + cs.colorScheme + (window.__auditVars ? ' ink2=' + cs.getPropertyValue('--ink2') + ' trans=' + cs.transition.slice(0, 80) : '') + ']'); }
        }
      }
    }
    // Clipped: the box hides part of the text and says nothing (no ellipsis, no clamp).
    const srOnly = e => { const s = getComputedStyle(e); return e.matches('.sr-only, .visually-hidden') || (s.position === 'absolute' && e.clientWidth <= 1 && e.clientHeight <= 1); };
    if (!srOnly(el)) for (let e = el, i = 0; e && i < 3; e = e.parentElement, i++) {
      const s = getComputedStyle(e);
      if ((s.overflowX === 'hidden' || s.overflowX === 'clip') && e.scrollWidth > e.clientWidth + 2 && s.textOverflow !== 'ellipsis' && s.webkitLineClamp === 'none' && !e.matches('[class*="scroll"], [class*="strip"], [class*="rail"]')) {
        if (e.clientWidth > 0 && s.whiteSpace === 'nowrap') { bump('clipped'); add('clipped', e, e.scrollWidth + ' > ' + e.clientWidth); }
        break;
      }
    }
  }
  // Something opaque between the topmost text and the other one is covering, not overlapping
  // (a dropdown over the board, a sticky bar over the page): walk up from the text on top to the
  // two texts' common ancestor looking for a solid background.
  const covers = (topEl, other) => {
    for (let e = topEl; e && !e.contains(other); e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a >= 0.85) return true;
      if (getComputedStyle(e).backdropFilter && getComputedStyle(e).backdropFilter !== 'none') return true;
    }
    return false;
  };
  // Overlap: two different texts drawn over each other (not one inside the other).
  for (let i = 0; i < textEls.length; i++) {
    for (let j = i + 1; j < textEls.length; j++) {
      const a = textEls[i], b = textEls[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      for (const ra of a.rects) for (const rb of b.rects) {
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w <= 1 || h <= 1) continue;
        const area = w * h, small = Math.min(ra.width * ra.height, rb.width * rb.height);
        if (area > 0.25 * small) {
          const cx = Math.max(ra.left, rb.left) + w / 2, cy = Math.max(ra.top, rb.top) + h / 2;
          const topAt = document.elementFromPoint(Math.min(W - 1, Math.max(0, cx)), Math.min(H - 1, Math.max(0, cy)));
          const onTop = topAt && (a.el.contains(topAt) || topAt.contains(a.el)) ? a.el : topAt && (b.el.contains(topAt) || topAt.contains(b.el)) ? b.el : null;
          if (onTop && covers(onTop === a.el ? a.el : b.el, onTop === a.el ? b.el : a.el)) continue;
          bump('overlap'); add('overlap', a.el, '"' + a.t.slice(0, 24) + '" × "' + b.t.slice(0, 24) + '"');
        }
      }
    }
  }
  if (W < 700) {
    // WCAG 2.5.8: a target under 24×24 still passes when a 24px circle centred on it touches no
    // other target (nor another small target's circle) — a lone checkbox in a roomy row is fine.
    const targets = [];
    for (const el of document.querySelectorAll('button, a[href], [role="button"], input[type="checkbox"], input[type="radio"], select')) {
      if (!visible(el)) continue;
      const lab = el.matches('input') ? el.closest('label') : null;
      const r = (lab || el).getBoundingClientRect();
      if (r.width && r.height) targets.push({ el, r, small: r.width < 24 || r.height < 24 });
    }
    const spaced = t => {
      const cx = t.r.left + t.r.width / 2, cy = t.r.top + t.r.height / 2;
      return targets.every(o => {
        if (o === t || o.el.contains(t.el) || t.el.contains(o.el)) return true;
        const ox = Math.max(o.r.left, Math.min(cx, o.r.right)), oy = Math.max(o.r.top, Math.min(cy, o.r.bottom));
        if (Math.hypot(cx - ox, cy - oy) < 12) return false;
        if (o.small && Math.hypot(cx - (o.r.left + o.r.width / 2), cy - (o.r.top + o.r.height / 2)) < 24) return false;
        return true;
      });
    };
    const okSpaced = new Set(targets.filter(t => t.small && spaced(t)).map(t => t.el));
    for (const el of document.querySelectorAll('button, a[href], [role="button"], input[type="checkbox"], input[type="radio"], select')) {
      if (okSpaced.has(el)) continue;
      if (!visible(el)) continue;
      // A checkbox or radio inside its label: the label is what is tapped.
      const lab = el.matches('input') ? el.closest('label') : null;
      const r = (lab || el).getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue;
      const top = document.elementFromPoint(Math.min(W - 1, r.left + r.width / 2), Math.min(H - 1, Math.max(0, r.top + r.height / 2)));
      if (!top || !(top === el || el.contains(top) || top.contains(el))) continue;
      if (r.width < 24 || r.height < 24) { bump('target'); add('target', el, Math.round(r.width) + '×' + Math.round(r.height)); }
    }
  }
  return { url: location.pathname, width: W, dark: matchMedia('(prefers-color-scheme: dark)').matches || document.documentElement.dataset.theme === 'dark', count, issues };
}

let patched = false;
function patch(proto) {
  if (patched) return; patched = true;
  const shot = proto.screenshot;
  proto.screenshot = async function (opts = {}) {
    const out = await shot.call(this, opts);
    if (!OUT || this.isClosed()) return out;
    try {
      const name = String(opts.path || '').split(/[\\/]/).pop();
      if (process.env.UI_AUDIT_VARS) await this.evaluate(() => { window.__auditVars = true; });
      const a = await this.evaluate(auditInPage);
      appendFileSync(OUT, JSON.stringify({ test: TEST, shot: name, scheme: 'as shot', ...a }) + '\n');
      const wasDark = await this.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
      await this.emulateMedia({ colorScheme: wasDark ? 'light' : 'dark' });
      await this.waitForTimeout(Number(process.env.UI_AUDIT_WAIT) || 400);   // colour transitions settle
      if (process.env.UI_AUDIT_NUDGE) await this.evaluate(() => { document.documentElement.classList.add('audit-nudge'); void document.body.offsetHeight; document.documentElement.classList.remove('audit-nudge'); });
      const b = await this.evaluate(auditInPage);
      appendFileSync(OUT, JSON.stringify({ test: TEST, shot: name, scheme: wasDark ? 'light' : 'dark', ...b }) + '\n');
      await this.emulateMedia({ colorScheme: wasDark ? 'dark' : 'light' });
      await this.waitForTimeout(250);
    } catch (e) { appendFileSync(OUT, JSON.stringify({ test: TEST, shot: String(opts.path || ''), error: String(e && e.message || e).slice(0, 200) }) + '\n'); }
    return out;
  };
}
const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const b = await launch(...args);
  if (!patched) { const ctx = await b.newContext(); const p = await ctx.newPage(); patch(Object.getPrototypeOf(p)); await ctx.close(); }
  return b;
};
