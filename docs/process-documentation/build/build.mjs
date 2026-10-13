import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import * as D from './diagrams.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'source');
const out = join(here, '..', 'html');
mkdirSync(out, { recursive: true });

const slug = s => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&amp;/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const used = new Set();
const uid = s => { let b = slug(s) || 'sec', id = b, n = 2; while (used.has(id)) id = `${b}-${n++}`; used.add(id); return id; };

const toc = [];
const renderer = new marked.Renderer();
renderer.heading = function ({ tokens, depth }) {
  const text = this.parser.parseInline(tokens);
  const level = Math.min(depth + 1, 6);
  const id = uid(text);
  if (level <= 3) toc.push({ level, id, text: text.replace(/<[^>]+>/g, '') });
  return `<h${level} id="${id}">${text}</h${level}>\n`;
};
renderer.table = function (token) {
  const head = token.header.map(c => `<th>${this.parser.parseInline(c.tokens)}</th>`).join('');
  const rows = token.rows.map(r => `<tr>${r.map(c => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('');
  return `<div class="tbl"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
};
marked.use({ renderer, gfm: true });

const md = f => marked.parse(readFileSync(join(src, f), 'utf8'));
const section = (id, eyebrow, title, lead, body) => {
  used.add(id);
  toc.push({ level: 1, id, text: title });
  return `<section class="doc" id="${id}"><header class="doc-head"><p class="eyebrow">${eyebrow}</p><h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ''}</header>${body}</section>`;
};
const strip = html => html.replace(/^<h2 id="[^"]+">[\s\S]*?<\/h2>\n/, '');   // drop the md's own title (shown in the section head)
const figure = (svg, cap) => `<figure class="fig">${svg}<figcaption>${cap}</figcaption></figure>`;

const overview = `
<div class="stats">
  <div><b>5</b><span>consoles on one sign-in</span></div>
  <div><b>24</b><span>connections between modules</span></div>
  <div><b>10</b><span>CRM pipeline stages</span></div>
  <div><b>9</b><span>Shoot &amp; Media columns</span></div>
  <div><b>4</b><span>scheduled jobs a day</span></div>
</div>
${figure(D.heroTrack(), 'One property, one path: the orange token is a listing moving from the first message to a closed deal.')}
<div class="tbl"><table><thead><tr><th>Document</th><th>Answers</th><th>Read it if you are</th></tr></thead><tbody>
<tr><td><a href="#doc1">1 · Functional overview</a></td><td>What does each module and process do?</td><td>Anyone new to the platform</td></tr>
<tr><td><a href="#doc2">2 · Business guide</a></td><td>How is each feature used, and why at that point?</td><td>Agents, shooters, editors, the owner</td></tr>
<tr><td><a href="#doc3">3 · Process &amp; field reference</a></td><td>Every process, every field, every link between modules</td><td>Process owners, trainers, auditors, developers</td></tr>
<tr><td><a href="#doc4">4 · Architecture &amp; flows</a></td><td>How the parts connect</td><td>Owner, developers, anyone changing the system</td></tr>
<tr><td><a href="#status">Release status &amp; gaps</a></td><td>What went live, what is still to do, what is missing</td><td>Owner, release manager</td></tr>
</tbody></table></div>
<p>Every statement is taken from the code itself: the live <code>main</code> at <code>b48bfaa</code> (released 13 Oct 2026, Firestore ruleset <code>132b5f73</code>), revised 14 Oct 2026. Work in progress in the working copy is listed under Release status and is not described as live.</p>`;

const doc3intro = `<p class="lead-p">The <b>property code</b> (e.g. <code>TNAG0002</code>: locality letters + serial number) is the thread that ties the modules together; the lead id and the listing id tie a person to a card.</p>
${figure(D.hubCode(), 'The property code at the centre: every module reads or writes it. Pulses show data moving along each link.')}`;

const d4 = [
  ['d-life', '4.1 End-to-end property lifecycle', D.lifecycle(), 'Five consoles, three parallel lanes, two owner gates (dashed) that the app does not enforce yet.'],
  ['d-arch', '4.2 Interconnection architecture', D.architecture(), 'Consoles talk to Firestore directly under tenant rules; anything needing a secret goes through the Vercel API; brochures are built on the owner’s Mac.'],
  ['d-crm', '4.3 CRM lead flow', D.crmLadder(), 'Seven milestones and three side columns. The AI moves forward only, never to Won, never over a person’s choice.'],
  ['d-board', '4.4 Shoot &amp; Media card flow', D.boardFlow(), 'Five of seven moves happen by themselves; On hold and Dropped are always by hand with a reason.'],
];
const doc4 = () => d4.map(([id, t, svg, cap]) => { used.add(id); toc.push({ level: 3, id, text: t.replace('&amp;', '&') }); return `<h3 id="${id}">${t}</h3>${figure(svg, cap)}`; }).join('\n');

const body = [
  section('overview', 'START HERE', 'How to read this pack', 'The 3Pin Realty platform is one connected system of five consoles that carries a property from the first seller message to a live post and a closed deal. This pack explains it at four depths.', overview),
  section('doc1', 'DOCUMENT 1', 'Functional overview', 'What every console and process does, in one line each.', strip(md('1-functional.md'))),
  section('doc2', 'DOCUMENT 2', 'Business guide', 'How each feature is used, and why at that point of the lifecycle.', strip(md('2-business.md'))),
  section('doc3', 'DOCUMENT 3', 'Process &amp; field reference', 'Every process step, every field, and every link between modules.',
    doc3intro + md('3f-interlinks.md') + md('3a-property.md') + md('3b-crm.md') + md('3c-track.md') + md('3d-finance.md') + md('3e-platform.md')),
  section('doc4', 'DOCUMENT 4', 'Architecture &amp; flows', 'Four animated diagrams of how the platform fits together.', doc4()),
  section('status', 'RELEASE', 'Release status (live 13 Oct 2026), gaps and known issues', 'What went live, what is still to do by hand, what is in progress, and where the app differs from the owner’s process.', strip(md('5-status.md'))),
].join('\n');

const nav = [...body.matchAll(/<section class="doc" id="([^"]+)"><header class="doc-head"><p class="eyebrow">([^<]*)<\/p>/g)].map(m => `<a href="#${m[1]}">${m[2].replace('DOCUMENT ', 'Doc ').replace('START HERE', 'Start').replace('RELEASE', 'Status')}</a>`).join('');
const side = (() => {
  let h = '', open = false;
  const re = /<section class="doc" id="([^"]+)"><header class="doc-head"><p class="eyebrow">[^<]*<\/p><h1>([^<]*)<\/h1>|<h3 id="([^"]+)">([\s\S]*?)<\/h3>/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[1]) { if (open) h += '</ol>'; h += `<a class="t1" href="#${m[1]}">${m[2]}</a><ol>`; open = true; }
    else h += `<li><a href="#${m[3]}">${m[4].replace(/<[^>]+>/g, '')}</a></li>`;
  }
  return h + (open ? '</ol>' : '');
})();

const css = readFileSync(join(here, 'style.css'), 'utf8');
const page = ({ title, description, brand, nav, side, body, foot }) => `<title>${title}</title>
<meta name="description" content="${description}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500&family=Sora:wght@700&display=swap">
<style>${css}</style>
<div class="topbar"><div class="brand"><span class="mark">3</span><span>${brand}</span></div><nav class="topnav">${nav}</nav><button class="theme" id="themeBtn" type="button" aria-label="Switch light or dark theme">◐</button></div>
<div class="wrap"><aside class="side"><div class="side-in">${side}</div></aside><main>${body}
<footer class="foot">${foot}</footer></main></div>
<script>
(function(){
  var root=document.documentElement, key='atlas-theme';
  try{var t=localStorage.getItem(key); if(t) root.setAttribute('data-theme',t);}catch(e){}
  document.getElementById('themeBtn').addEventListener('click',function(){
    var dark = root.getAttribute('data-theme')==='dark' || (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    var next = dark?'light':'dark'; root.setAttribute('data-theme',next); try{localStorage.setItem(key,next);}catch(e){}
  });
  [].forEach.call(document.querySelectorAll('.fig'),function(f){ if(f.scrollWidth>f.clientWidth+4){ f.scrollLeft=(f.scrollWidth-f.clientWidth)/2; f.classList.add('wide'); } });
  var links=[].slice.call(document.querySelectorAll('.topnav a, .side a'));
  var secs=[].slice.call(document.querySelectorAll('section.doc'));
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){ if(e.isIntersecting){ var id=e.target.id;
      links.forEach(function(a){ a.classList.toggle('on', a.getAttribute('href')==='#'+id); }); } });},{rootMargin:'-30% 0px -65% 0px'});
    secs.forEach(function(s){io.observe(s);});
  }
})();
</script>`;
const html = page({ title: '3Pin Process Atlas', description: 'Functional, business, process and architecture documentation of the 3Pin Realty platform.',
  brand: '3Pin Process Atlas', nav, side, body, foot: '3Pin Realty · Process Atlas · generated from the codebase · revised 14 Oct 2026 (live main b48bfaa)' });
const doc = body => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${body}</html>`;
// Artifact edition (the artifact host adds the document skeleton itself) and a standalone edition that opens from disk.
writeFileSync(join(out, '3Pin-Process-Atlas.artifact.html'), html);
writeFileSync(join(out, '3Pin-Process-Atlas.html'), doc(html));
const roadmap = readFileSync(join(src, 'ai-roadmap.html'), 'utf8');
writeFileSync(join(out, '3Pin-AI-Autopilot.html'), doc(roadmap));

// The AI & PropTech strategy: one document, its sections as the side index (## headings become h3).
{
  used.clear(); toc.length = 0;
  const sBody = strip(md('7-ai-proptech-strategy.md'));
  const sections = [...sBody.matchAll(/<h3 id="([^"]+)">([\s\S]*?)<\/h3>/g)];
  const sSide = `<a class="t1" href="#top">AI &amp; PropTech Strategy</a><ol>${sections.map(m => `<li><a href="#${m[1]}">${m[2].replace(/<[^>]+>/g, '')}</a></li>`).join('')}</ol>`;
  const navNames = { '1': 'Thesis', '3': 'Scorecard', '5': 'The plan', '7': 'Waves', '8': 'Money', '12': 'Eåsy', '13': 'Bets', '14': 'Next chain', '15': 'World', '16': 'Gaps' };
  const sNav = sections.map(m => [m[1], (m[2].replace(/<[^>]+>/g, '').match(/^(\d+)\./) || [])[1]]).filter(([, n]) => navNames[n]).map(([id, n]) => `<a href="#${id}">${navNames[n]}</a>`).join('');
  const sMain = `<section class="doc" id="top"><header class="doc-head"><p class="eyebrow">STRATEGY · 2027–2029</p><h1>AI &amp; PropTech Strategy — the 10× plan</h1><p class="lead">Where 3 PIN stands against the best AI-native brokerages and proptech products, and what to build, in what order, with the money, the business effect and the agent time for every initiative.</p></header>${sBody}</section>`;
  const sHtml = page({ title: '3Pin AI & PropTech Strategy', description: 'The 10× AI and proptech plan for 3 PIN Realty, 2027–2029: benchmarks, scorecard, twelve areas, financial model, waves and guardrails.',
    brand: '3Pin AI &amp; PropTech Strategy', nav: sNav, side: sSide, body: sMain, foot: '3Pin Realty · AI & PropTech Strategy · 14 Oct 2026' });
  writeFileSync(join(out, '3Pin-AI-PropTech-Strategy.artifact.html'), sHtml);
  writeFileSync(join(out, '3Pin-AI-PropTech-Strategy.html'), doc(sHtml));
}
console.log('built', (html.length / 1024).toFixed(0) + ' KB', toc.length, 'headings');
