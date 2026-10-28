// ═══════ EÅSY — LOCAL DEV SERVER ═══════
//
//   npm run dev:easy                    → http://localhost:5174/crm.html
//   PORT=5180 npm run dev:easy
//
// The real CRM page and the real Eåsy API handler, on an in-memory Firestore seeded with sample
// leads, properties, visits and tasks (tests/fixtures/easy-seed.mjs). Nothing here talks to the
// live Firebase project, sends email, or calls TailorTalk / Google: the page's Firebase imports are
// pointed at local stand-ins, the API's database and sign-in are swapped by a module hook
// (scripts/dev/bot-shared.dev.mjs), and every other /api/ route answers a harmless stub.
//
// Claude: with ANTHROPIC_API_KEY in the environment or in .env.local, Eåsy uses the real model
// (and spends real money, at the effort Eåsy uses). Without one, a keyword stand-in
// (scripts/dev/stand-in.mjs) drives the same tools so every card and flow can still be tried.
//
// Pages:  /crm.html          signed in as thirumal@threepin.in (an admin)
//         /__dev/as?email=pradeep@threepin.in   switch who is signed in
//         /__dev/reset        start again from the sample data
//         /__dev              what is running

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 5174);

// .env.local (git-ignored) — only the keys this server needs.
const envFile = join(ROOT, '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*(ANTHROPIC_API_KEY|EASY_DISABLED)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// The API sees the dev database and the dev sign-in instead of the live ones.
const DEV_SHARED = pathToFileURL(join(ROOT, 'scripts/dev/bot-shared.dev.mjs')).href;
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    if (r.url.endsWith('/api/_bot-shared.js')) return { ...r, url: DEV_SHARED, shortCircuit: true };
    return r;
  }
});

const { makeStore, adminDb } = await import('../tests/fake-firestore.mjs');
const { easySeed, T, AGENT } = await import('../tests/fixtures/easy-seed.mjs');
const { rebuildLeadViews } = await import('../api/_lead-views.js');
const easy = await import('../api/_easy.js');
const botRoute = await import('../api/bot-test-message.js');

// EASY_DEV_STANDIN=1 forces the stand-in even with a key (the browser test: free and repeatable).
const realClaude = !!process.env.ANTHROPIC_API_KEY && !process.env.EASY_DEV_STANDIN;
if (!realClaude) easy.setEasyClient((await import('./dev/stand-in.mjs')).standIn);

// ── The database: one store, mirrored live to every open page ──
const store = makeStore();
const db = adminDb(store);
globalThis.__devDb = db;
const clients = new Set();
const dirty = new Set();
const rawSet = Map.prototype.set, rawDelete = Map.prototype.delete;
store.docs.set = function (k, v) { dirty.add(k); return rawSet.call(this, k, v); };
store.docs.delete = function (k) { dirty.add(k); return rawDelete.call(this, k); };
store.docs.clear = function () { for (const k of this.keys()) dirty.add(k); return Map.prototype.clear.call(this); };
store.subs.add({ fire() {
  if (!dirty.size) return;
  const changes = [...dirty].map(path => ({ path, data: store.docs.has(path) ? store.docs.get(path) : null }));
  dirty.clear();
  const msg = `data: ${JSON.stringify(changes)}\n\n`;
  for (const c of clients) c.write(msg);
} });

async function seed() {
  for (const k of [...store.docs.keys()]) store.docs.delete(k);
  const { docs } = easySeed(Date.now());
  for (const [p, d] of Object.entries(docs)) store.set(p, d);
  const leads = [...store.docs].filter(([p]) => /^leads\/[^/]+$/.test(p)).map(([p, d]) => ({ ...d, id: p.split('/')[1] }));
  await rebuildLeadViews(db, T, leads, Date.now());
  store.notify();
  console.log(`  seeded ${store.docs.size} documents`);
}
await seed();

// ── Serving ──
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const GSTATIC = /https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-(app|auth|firestore)\.js/g;
const DEV_MODULES = {
  '/__dev/firebase-firestore.js': "import '/scripts/dev/replica.mjs';\nexport * from '/tests/_fake-gstatic.mjs';\n",
  '/__dev/firebase-auth.js': "export * from '/scripts/dev/firebase-auth.mjs';\n",
  '/__dev/firebase-app.js': "export * from '/tests/_fake-gstatic-app.mjs';\n"
};
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(x => x[0]).map(([k, v]) => [k, decodeURIComponent(v || '')]));
const whoami = req => ({ email: cookies(req).easyDevAs || AGENT, tenantId: T });
const body = req => new Promise((res, rej) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => res(b)); req.on('error', rej); });
const send = (res, status, type, data) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(data); };

async function api(req, res, url) {
  const route = url.pathname === '/api/easy' ? 'easy' : url.pathname === '/api/bot-test-message' ? 'bot' : null;
  if (!route) return send(res, 200, 'application/json', JSON.stringify({ ok: true, dev: 'stubbed locally — this route is not part of Eåsy', replies: [], events: [] }));
  const raw = req.method === 'POST' ? await body(req) : undefined;
  const target = new URL(url);
  if (route === 'easy') target.searchParams.set('op', 'easy');
  const request = new Request(target, { method: req.method, headers: req.headers, body: raw });
  const t0 = Date.now();
  const response = await (route === 'bot' && !realClaude
    ? new Response(JSON.stringify({ reply: '(The AI Bot test chat needs ANTHROPIC_API_KEY in .env.local.)', extractedInfo: {} }), { headers: { 'Content-Type': 'application/json' } })
    : botRoute.POST(request));
  const text = await response.text();
  let what = ''; try { const b = JSON.parse(raw || '{}'); what = b.action || (b.history ? '“' + String(b.history.at(-1)?.text || '').slice(0, 60) + '”' : ''); } catch (e) {}
  console.log(`  ${response.status} ${url.pathname} ${what} — ${Date.now() - t0} ms`);
  send(res, response.status, 'application/json', text);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;
    if (p === '/' || p === '/__dev') {
      return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><meta charset="utf-8"><title>Eåsy dev</title><body style="font:15px system-ui;max-width:640px;margin:40px auto;padding:0 16px">
        <h1>Eåsy — local dev</h1><p>Fake Firestore with ${store.docs.size} documents. Claude: <b>${realClaude ? 'real (ANTHROPIC_API_KEY set)' : 'stand-in (no key)'}</b>. Signed in as <b>${whoami(req).email}</b>.</p>
        <p><a href="/crm.html">Open the CRM →</a></p>
        <p>Sign in as: <a href="/__dev/as?email=thirumal@threepin.in">thirumal (admin)</a> · <a href="/__dev/as?email=pradeep@threepin.in">pradeep (agent)</a></p>
        <p><a href="/__dev/reset">Reset the sample data</a></p></body>`);
    }
    if (p === '/__dev/state') return send(res, 200, 'application/json', JSON.stringify(Object.fromEntries(store.docs)));
    if (p === '/__dev/whoami') return send(res, 200, 'application/json', JSON.stringify(whoami(req)));
    if (p === '/__dev/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res); req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/__dev/write' && req.method === 'POST') {
      for (const { path, data } of JSON.parse(await body(req))) data == null ? store.docs.delete(path) : store.docs.set(path, data);
      store.notify();
      return send(res, 200, 'application/json', '{"ok":true}');
    }
    if (p === '/__dev/reset') { await seed(); res.writeHead(302, { Location: '/crm.html' }); return res.end(); }
    if (p === '/__dev/as') { res.writeHead(302, { 'Set-Cookie': `easyDevAs=${encodeURIComponent(url.searchParams.get('email') || AGENT)}; Path=/`, Location: '/crm.html' }); return res.end(); }
    if (p === '/__dev/signout') { res.writeHead(302, { Location: '/__dev' }); return res.end(); }
    if (DEV_MODULES[p]) return send(res, 200, TYPES['.js'], DEV_MODULES[p]);
    if (p.startsWith('/api/')) return api(req, res, url);

    const file = normalize(join(ROOT, decodeURIComponent(p)));
    if (!file.startsWith(ROOT) || /\/(\.env|node_modules\/\.|\.git\/)/.test(file) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'text/plain', 'not found');
    const ext = extname(file);
    let data = readFileSync(file);
    if (ext === '.js' || ext === '.mjs' || ext === '.html') {
      const s = data.toString('utf8');
      if (GSTATIC.test(s)) data = s.replace(GSTATIC, (_, which) => `/__dev/firebase-${which}.js`);
      GSTATIC.lastIndex = 0;
    }
    return send(res, 200, TYPES[ext] || 'application/octet-stream', data);
  } catch (e) {
    console.error('dev server error:', e);
    if (!res.headersSent) send(res, 500, 'text/plain', String(e && e.stack || e));
  }
});

server.listen(PORT, () => {
  console.log(`\nEåsy local dev → http://localhost:${PORT}/crm.html`);
  console.log(`  Claude: ${realClaude ? 'REAL model (ANTHROPIC_API_KEY) — questions cost money' : 'stand-in (no ANTHROPIC_API_KEY) — free, keyword rules'}`);
  console.log(`  Eåsy: ${easy.easyEnabled() ? 'on' : 'OFF (EASY_DISABLED)'} · fake Firestore, no live data, no email\n`);
});
