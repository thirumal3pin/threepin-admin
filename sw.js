// The service worker that makes the admin installable as an app ("📲 Install app",
// shared-assets/install-app.js). It caches nothing and answers no requests: every page and every
// piece of data comes from the network exactly as in the browser, so an installed app is never
// stale. Kept at the site root so its scope is the whole site.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
