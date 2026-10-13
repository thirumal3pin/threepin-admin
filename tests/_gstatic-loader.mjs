// Node module hook for tests: the page modules import Firebase from the gstatic CDN; in tests those
// URLs resolve to in-memory stand-ins — Firestore over tests/fake-firestore.mjs, and a signed-in
// user whose tenant the test sets (tests/_fake-gstatic-auth.mjs).
const FAKES = {
  'firebase-firestore.js': './_fake-gstatic.mjs',
  'firebase-app.js': './_fake-gstatic-app.mjs',
  'firebase-auth.js': './_fake-gstatic-auth.mjs'
};
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('https://www.gstatic.com/firebasejs/')) {
    const fake = FAKES[specifier.split('/').pop()];
    if (fake) return { url: new URL(fake, import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
