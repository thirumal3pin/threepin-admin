// The finance module's single HTTP route.
//
// Digest and attachment upload are unrelated jobs, but they share one route because the
// Hobby plan caps a deployment at 12 Serverless Functions and this project already sits at
// that ceiling — the same reason api/meta-webhook.js carries three concerns. The handlers
// themselves live in _finance-digest.js and _finance-upload.js, which are underscore-prefixed
// and so are modules rather than routes; splitting this back into two files is a one-line
// change if the project ever moves to Pro.
//
//   GET  /api/finance                -> the daily digest, called by Vercel Cron
//   POST /api/finance                -> "send now" from the finance page
//   POST /api/finance?task=upload    -> Drive attachment upload (init / finish / delete)

import { digestGet, digestPost } from './_finance-digest.js';
import { uploadPost } from './_finance-upload.js';

export async function GET(request) {
  return digestGet(request);
}

export async function POST(request) {
  const task = new URL(request.url).searchParams.get('task');
  if (task === 'upload') return uploadPost(request);
  return digestPost(request);
}
