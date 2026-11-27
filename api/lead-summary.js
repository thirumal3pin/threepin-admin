// The lead AI summary's single HTTP route. Generating one summary and backfilling many used to
// be two functions; they share one so api/tailortalk.js fits under the Hobby plan's limit of
// 12 functions. The handlers live in the underscore modules, which are not routes.
//
//   POST /api/lead-summary?op=generate   one lead  (was /api/generate-lead-summary)
//   POST /api/lead-summary?op=backfill   a chunk   (was /api/backfill-lead-summaries)
//
// vercel.json rewrites the two old paths here, so a page still holding the old URL keeps working.

import { generatePost } from './_lead-summary-generate.js';
import { backfillPost } from './_lead-summary-backfill.js';
import { track, nameFor } from './_usage.js';

export const maxDuration = 60;

async function POST_raw(request) {
  const op = new URL(request.url).searchParams.get('op');
  if (op === 'generate') return generatePost(request);
  if (op === 'backfill') return backfillPost(request);
  return new Response(JSON.stringify({ error: 'Unknown op' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}

// Every request counted in the database usage log (api/_usage.js), under its name.
export const POST = (request, ...a) => track(nameFor('lead-summary', request, 'POST'), () => POST_raw(request, ...a));
