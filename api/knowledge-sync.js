import { getDb, verifyCrmUser } from './_bot-shared.js';

// Knowledge base connectors for the AI bot.
//
// "Connect the link" flow: paste a link-shared Google Sheet or Google Doc and
// we pull its contents server-side (CSV / plain-text export) — no OAuth needed
// as long as the file is shared with "Anyone with the link". Uploaded PDFs /
// text files arrive already extracted to text from the browser and are stored
// the same way. Everything lands in knowledgeConfigs/{tenantId}.sources[] and
// is fed into the bot's system prompt by buildSystemPrompt().

const MAX_SOURCE_CHARS = 20000;      // per-source cap kept in Firestore

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function knowledgeRef(db, tenantId) {
  return db.collection('knowledgeConfigs').doc(tenantId);
}

async function readSources(db, tenantId) {
  const snap = await knowledgeRef(db, tenantId).get();
  return snap.exists ? (snap.data().sources || []) : [];
}

async function writeSources(db, tenantId, sources) {
  await knowledgeRef(db, tenantId).set({ sources, updatedAt: Date.now() }, { merge: true });
}

// --- Google link parsing / fetching ------------------------------------------

function parseGoogleLink(url) {
  const sheet = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (sheet) {
    const gid = (url.match(/[#&?]gid=([0-9]+)/) || [])[1] || '0';
    return {
      kind: 'sheet',
      id: sheet[1],
      exportUrl: `https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=csv&gid=${gid}`
    };
  }
  const docm = url.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (docm) {
    return {
      kind: 'doc',
      id: docm[1],
      exportUrl: `https://docs.google.com/document/d/${docm[1]}/export?format=txt`
    };
  }
  return null;
}

async function fetchGoogleContent(parsed) {
  const res = await fetch(parsed.exportUrl, { redirect: 'follow' });
  const text = await res.text();
  // A private file redirects to an HTML sign-in/accounts page instead of data.
  const looksLikeLogin = /<html/i.test(text.slice(0, 200)) &&
    /(sign in|accounts\.google\.com|Request access|ServiceLogin)/i.test(text);
  if (!res.ok || looksLikeLogin) {
    throw new Error('This file is not publicly readable. In Google, set link sharing to "Anyone with the link" (Viewer), then try again.');
  }
  return text;
}

function clamp(text) {
  const t = (text || '').trim();
  return t.length > MAX_SOURCE_CHARS ? t.slice(0, MAX_SOURCE_CHARS) : t;
}

// --- Handlers ----------------------------------------------------------------

export async function GET(request) {
  const user = await verifyCrmUser(request);
  if (!user || !user.tenantId) return json({ error: 'Unauthorized' }, 401);
  const db = getDb();
  const sources = await readSources(db, user.tenantId);
  // Don't ship full content back to the list view — just metadata.
  const meta = sources.map(({ content, ...rest }) => ({ ...rest, chars: (content || '').length }));
  return json({ sources: meta });
}

export async function POST(request) {
  const user = await verifyCrmUser(request);
  if (!user || !user.tenantId) return json({ error: 'Unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  const db = getDb();
  const tenantId = user.tenantId;
  const action = body.action;

  try {
    if (action === 'addLink') {
      const url = (body.url || '').trim();
      const parsed = parseGoogleLink(url);
      if (!parsed) {
        return json({ error: 'That does not look like a Google Sheet or Google Doc link.' }, 400);
      }
      const content = clamp(await fetchGoogleContent(parsed));
      const source = {
        id: 'src_' + Date.now(),
        type: parsed.kind === 'sheet' ? 'Google Sheet' : 'Google Doc',
        name: body.name && body.name.trim() ? body.name.trim() : (parsed.kind === 'sheet' ? 'Google Sheet' : 'Google Doc'),
        url,
        content,
        syncedAt: Date.now(),
        status: 'synced'
      };
      const sources = await readSources(db, tenantId);
      sources.push(source);
      await writeSources(db, tenantId, sources);
      return json({ ok: true, source: { ...source, content: undefined, chars: content.length } });
    }

    if (action === 'addText') {
      // Pre-extracted text from an uploaded PDF/txt, or a pasted snippet.
      const content = clamp(body.content || '');
      if (!content) return json({ error: 'No text content provided.' }, 400);
      const source = {
        id: 'src_' + Date.now(),
        type: body.sourceType || 'File',
        name: body.name && body.name.trim() ? body.name.trim() : 'Uploaded file',
        url: '',
        content,
        syncedAt: Date.now(),
        status: 'synced'
      };
      const sources = await readSources(db, tenantId);
      sources.push(source);
      await writeSources(db, tenantId, sources);
      return json({ ok: true, source: { ...source, content: undefined, chars: content.length } });
    }

    if (action === 'resync') {
      const sources = await readSources(db, tenantId);
      const src = sources.find(s => s.id === body.id);
      if (!src) return json({ error: 'Source not found.' }, 404);
      if (!src.url) return json({ error: 'This source has no link to re-sync (re-upload the file).' }, 400);
      const parsed = parseGoogleLink(src.url);
      if (!parsed) return json({ error: 'Stored link is no longer valid.' }, 400);
      src.content = clamp(await fetchGoogleContent(parsed));
      src.syncedAt = Date.now();
      src.status = 'synced';
      await writeSources(db, tenantId, sources);
      return json({ ok: true, source: { ...src, content: undefined, chars: src.content.length } });
    }

    if (action === 'remove') {
      const sources = (await readSources(db, tenantId)).filter(s => s.id !== body.id);
      await writeSources(db, tenantId, sources);
      return json({ ok: true });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('knowledge-sync error:', e);
    return json({ error: String(e.message || e) }, 200);
  }
}
