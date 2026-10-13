// firebase-app.js, as the pages import it — for tests (tests/_gstatic-loader.mjs).
const apps = [];
export const initializeApp = config => { const a = { options: config }; apps.push(a); return a; };
export const getApps = () => apps;
