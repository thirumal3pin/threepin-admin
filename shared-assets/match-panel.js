// ═══════════════════════════════════════════════════════════════════════════
// MATCH PANEL — the one way a match is shown, on all three consoles
// ═══════════════════════════════════════════════════════════════════════════
//
// PinMatch produces the numbers; this turns them into the list a person
// reads. It exists as one file for the same reason the engine does: the
// Properties console, the CRM and the Property & Media board all show the
// same thing, and a score presented two ways in two places is a score nobody
// trusts.
//
// ── WHAT A ROW HAS TO ANSWER ──────────────────────────────────────────────
//
// An agent looking at a match is about to pick up the phone. In that moment
// they need four things, in this order:
//
//   1. Is this worth a call?          the score, and a band that says so in
//                                     words — "92%" means nothing the first
//                                     time you see it, "Strong match" does
//   2. What do I say?                 the reasons, biggest contribution first
//   3. What will they push back on?   the gaps, and the buyer's own words
//   4. How sure are we?              confidence, quietly — a buyer we know
//                                     little about is still worth calling
//
// The score bar carries 1 and 2 at once: one segment per attribute, width by
// weight, fill by what was earned. So the weak part of a 92% is visible
// without expanding anything.
//
// ── RULED OUT IS NOT HIDDEN ───────────────────────────────────────────────
//
// Vetoed matches are collapsed, never dropped. The question an agent asks of
// any ranked list is "did it miss someone?", and the only answer that builds
// trust is the list of who was excluded with the reason against each name.
// A shorter list is not a better answer.
//
// No framework, no innerHTML from unescaped data, no DOM library. Renders
// into an element the host provides, and hands actions back through
// callbacks so each console keeps its own navigation.

(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function M() {
    if (!root.PinMatch) throw new Error('PinMatchPanel needs PinMatch loaded first');
    return root.PinMatch;
  }

  // ═══════ PIECES ═══════

  // The score bar. Segments in the table's own order rather than sorted by
  // contribution, so the same attribute sits in the same place on every row
  // and a column of rows can be read down.
  function scoreBar(m) {
    const parts = (m.breakdown || []).filter(b => b.of > 0);
    if (!parts.length) return '';
    const total = parts.reduce((n, b) => n + b.of, 0);
    const segs = parts.map(b => {
      const pct = (b.of / total) * 100;
      const fill = Math.round(Math.max(0, Math.min(1, b.s)) * 100);
      const cls = b.s >= 0.75 ? '' : b.s >= 0.4 ? ' mid' : ' low';
      return `<span class="pm-seg${cls}" style="flex:0 0 ${pct.toFixed(2)}%"
        title="${esc(b.label)}: ${b.points} of ${b.of} points${b.why ? ' — ' + esc(b.why) : ''}"><i style="width:${fill}%"></i></span>`;
    }).join('');

    // The key names only the attributes that actually cost something. A
    // legend of twenty labels is not a legend.
    //
    // The threshold is 0.95, not 0.75, because anything lower made the
    // legend congratulatory instead of informative: a 95% match whose
    // location scored 0.82 was being captioned "every stated requirement
    // met", which is exactly the sentence that should be reserved for a
    // property that really does meet all of them.
    const weak = parts.filter(b => b.s < 0.95).sort((a, b) => (b.of - b.points) - (a.of - a.points)).slice(0, 3);
    const key = weak.length
      ? `<div class="pm-bars-k">${weak.map(b => `<span><b>${esc(b.label)}</b> ${b.points}/${b.of}</span>`).join('')}</div>`
      : `<div class="pm-bars-k"><span>every stated requirement met in full</span></div>`;
    return `<div class="pm-bars">${segs}</div>${key}`;
  }

  function confidence(m) {
    const pips = Math.max(1, Math.round((m.confidence || 0) * 4));
    const label = m.confidence >= 0.85 ? 'we know what they want'
      : m.confidence >= 0.6 ? 'we know most of what they want'
        : m.confidence >= 0.35 ? 'we know some of what they want'
          : 'we know very little about them';
    return `<div class="pm-conf" title="How much of the budget, area, configuration, type and size we actually hold for this buyer">
      <span class="pm-conf-t">${[1, 2, 3, 4].map(i => `<i class="${i <= pips ? 'on' : ''}"></i>`).join('')}</span>
      ${esc(label)}</div>`;
  }

  // Reasons for, then gaps against. Capped at five and three: past that an
  // agent stops reading, and the sixth reason was never the one that mattered.
  function reasons(m) {
    const out = [];
    for (const v of (m.vetoes || [])) {
      out.push(`<li class="veto"><span>${esc(v.why)}</span></li>`);
    }
    for (const f of (m.for || [])) {
      out.push(`<li><span class="pm-pts">${f.points}/${f.of}</span><span>${esc(f.why)}</span></li>`);
    }
    for (const a of (m.against || [])) {
      // A gap the buyer stated in their own words is shown as a quote — it is
      // far more persuasive than our paraphrase, and it is what the agent
      // will be answering on the call.
      const body = a.quote
        ? `${esc(a.why.replace(/ — “.*”$/, ''))} <q>${esc(a.quote)}</q>`
        : esc(a.why);
      out.push(`<li class="neg"><span class="pm-pts">−${a.lost}</span><span>${body}</span></li>`);
    }
    return out.length ? `<ul class="pm-why">${out.join('')}</ul>` : '';
  }

  function actions(list) {
    if (!list || !list.length) return '';
    return `<div class="pm-acts">${list.map(a => a.href
      ? `<a class="pm-btn ${a.primary ? 'primary' : ''}" href="${esc(a.href)}"${a.blank ? ' target="_blank" rel="noopener"' : ''}>${esc(a.label)}</a>`
      : `<button type="button" class="pm-btn ${a.primary ? 'primary' : ''}" data-pm-act="${esc(a.id)}" data-pm-key="${esc(a.key)}">${esc(a.label)}</button>`
    ).join('')}</div>`;
  }

  function row(m, shape) {
    const band = M().band(m.pct, m.vetoed);
    const t = shape(m);
    return `<div class="pm-row ${band.key}${m.vetoed ? ' out' : ''}">
      <div class="pm-r1">
        <div class="pm-sc">
          <div class="pm-sc-n">${m.vetoed ? '—' : m.pct + '%'}</div>
          <div class="pm-sc-b">${esc(band.label)}</div>
        </div>
        <div class="pm-main">
          <div class="pm-name">${t.code ? `<span class="pm-code">${esc(t.code)}</span>` : ''}${esc(t.name)}</div>
          ${t.sub ? `<div class="pm-sub">${esc(t.sub)}</div>` : ''}
          ${m.vetoed ? '' : scoreBar(m)}
        </div>
      </div>
      ${reasons(m)}
      ${m.vetoed ? '' : confidence(m)}
      ${actions(t.actions)}
    </div>`;
  }

  // ═══════ THE EXPLAINER ═══════
  //
  // Built from the engine's own table rather than written out by hand, so it
  // can never describe a weighting the engine does not use. That drift is
  // guaranteed otherwise, and a stale explanation of a score is worse than
  // none.
  function howItScores() {
    const attrs = M().ATTRIBUTES.slice().sort((a, b) => b.weight - a.weight);
    const top = attrs.slice(0, 8).map(a => `${esc(a.label)} ${a.weight}`).join(' · ');
    return `<div class="pm-note">
      <h4>How the score is worked out</h4>
      Each thing the buyer told us is scored on its own and weighted by how much it matters
      — <code>${top}</code>, and a dozen smaller ones.
      <ul>
        <li>Only what they <b>actually told us</b> counts. A buyer who never mentioned facing is not marked down for it.</li>
        <li>Nothing is pass or fail. Six percent over budget and sixty percent over are different answers.</li>
        <li>Their own objections come off the score, with the quote attached — and a price they have already called too high rules a property out.</li>
        <li><b>Confidence</b> is separate on purpose: 95% on two facts is not 95% on eleven.</li>
      </ul>
    </div>`;
  }

  // ═══════ RENDER ═══════

  /**
   * @param el      the element to render into
   * @param matches PinMatch.buyersFor() / propertiesFor() output
   * @param opts
   *   shape(m)     → { name, code, sub, actions:[{id,label,key,href,primary,blank}] }
   *   title        heading text
   *   subtitle     small grey text after the heading
   *   empty        HTML for the empty state
   *   onAction(id, key, match)   a data-pm-act button was clicked
   *   showHow      start with the explainer open
   */
  // How many matches to show before asking. A shortlist an agent would
  // actually send, rather than the entire ranked inventory.
  const CAP = 5;

  function render(el, matches, opts) {
    if (!el) return;
    const o = opts || {};
    const shape = o.shape || (m => ({ name: m.lead ? m.lead.name : (m.p && m.p.name) || '—' }));
    const live = matches.filter(m => !m.vetoed);
    const out = matches.filter(m => m.vetoed);

    const state = el.__pmState || (el.__pmState = { how: !!o.showHow, out: false, more: false });

    const head = `<div class="pm-hdr">
      <span class="pm-hdr-n">${esc(o.title || 'Matches')}</span>
      <span class="pm-hdr-sub">${esc(o.subtitle || '')}</span>
      <span class="pm-hdr-sp"></span>
      <button type="button" class="pm-link" data-pm-toggle="how">${state.how ? 'Hide' : 'How is this scored?'}</button>
    </div>`;

    let body;
    if (!live.length && !out.length) {
      body = `<div class="pm-empty">${o.empty || 'Nothing matches yet.'}</div>`;
    } else {
      // ═══════ A SHORTLIST, NOT THE WHOLE RANKING ═══════
      //
      // Every match used to render in full. Against the live inventory that
      // was 28 rows and 7,177px of panel inside a lead page — and the Notes
      // box sits BELOW it, so an agent had to scroll roughly eight thousand
      // pixels past the matches to log a call. They reported the notes
      // section as missing, which is exactly what that is.
      //
      // Five is what an agent actually sends a client. The rest are one
      // click away and nothing is dropped.
      const shown = state.more ? live : live.slice(0, CAP);
      body = shown.map(m => row(m, shape)).join('');
      if (live.length > CAP) {
        body += `<button type="button" class="pm-more" data-pm-toggle="more" aria-expanded="${state.more}">`
          + (state.more ? 'Show the top ' + CAP + ' only' : 'Show all ' + live.length + ' matches')
          + '</button>';
      }
      if (!live.length) body = `<div class="pm-empty">${o.empty || 'Nothing clears the bar yet.'}</div>`;
      if (out.length) {
        body += `<button type="button" class="pm-out-hd" data-pm-toggle="out" aria-expanded="${state.out}">
            <span class="pm-chev">›</span> ${out.length} ruled out — see why</button>`;
        if (state.out) body += out.map(m => row(m, shape)).join('');
      }
    }

    el.classList.add('pm');
    el.innerHTML = head + (state.how ? howItScores() : '') + body;

    // One delegated listener per container, attached once.
    if (!el.__pmWired) {
      el.__pmWired = true;
      el.addEventListener('click', ev => {
        const tog = ev.target.closest('[data-pm-toggle]');
        if (tog) {
          const k = tog.getAttribute('data-pm-toggle');
          el.__pmState[k] = !el.__pmState[k];
          render(el, el.__pmMatches || [], el.__pmOpts || {});
          return;
        }
        const act = ev.target.closest('[data-pm-act]');
        if (!act) return;
        const id = act.getAttribute('data-pm-act');
        const key = act.getAttribute('data-pm-key');
        const list = el.__pmMatches || [];
        const m = list.find(x => String(keyOf(x)) === String(key));
        const fn = (el.__pmOpts || {}).onAction;
        if (fn) fn(id, key, m);
      });
    }
    el.__pmMatches = matches;
    el.__pmOpts = o;
  }

  // A match's stable identity, whichever direction it came from.
  const keyOf = m => (m.lead && m.lead.id) || (m.p && m.p.id) || (m.property && m.property.id) || '';

  function busy(el, text) {
    if (!el) return;
    el.classList.add('pm');
    el.innerHTML = `<div class="pm-busy">${esc(text || 'Working out the matches…')}</div>`;
  }

  root.PinMatchPanel = { render, busy, howItScores, keyOf, esc };
  if (typeof module === 'object' && module && module.exports) module.exports = root.PinMatchPanel;
})(typeof globalThis !== 'undefined' ? globalThis : this);
