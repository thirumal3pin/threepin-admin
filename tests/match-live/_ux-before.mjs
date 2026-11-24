// The walkthrough's "before" pass: screenshots into tests/out/ux-before/.
export default async function (ctx) {
  process.env.UX_TAG = 'before';
  try { const m = await import(new URL('./80-ux-tasks.mjs?t=' + Date.now(), import.meta.url).href); await m.default(ctx); } finally { delete process.env.UX_TAG; }
}
