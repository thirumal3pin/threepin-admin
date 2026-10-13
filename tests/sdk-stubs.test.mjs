// The Firebase stand-ins the tests serve in place of the gstatic SDK must offer everything the
// pages import from it. A module that imports a name its stand-in lacks fails to load at all —
// and the preview then reports a timeout far from the cause. This checks it directly: every name
// any page module imports from firebase-firestore / -auth / -app, against every stand-in.
//   node tests/sdk-stubs.test.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIRS = ['crm-assets', 'track-assets', 'dashboard-assets', 'finance-assets', 'shared-assets'];
// stand-in → the libraries it replaces
const STUBS = { 'tests/_fake-gstatic.mjs': ['firestore'], 'tests/_fake-gstatic-app.mjs': ['app'], 'tests/_fake-gstatic-auth.mjs': ['auth'], 'tests/appnav-preview.mjs': ['firestore', 'auth', 'app'], 'tests/ux-sweep.mjs': ['firestore', 'auth', 'app'], 'tests/crm-tailortalk-preview.mjs': ['firestore', 'auth', 'app'] };

const need = new Map();   // name → { lib, first module importing it }
for (const d of DIRS) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter(x => x.endsWith('.js'))) {
    const src = readFileSync(join(d, f), 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']https:\/\/www\.gstatic\.com\/firebasejs\/[^"']*firebase-(firestore|auth|app)\.js["']/g)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name && !need.has(name)) need.set(name, { lib: m[2], from: `${d}/${f}` });
      }
    }
  }
}

let failed = 0;
console.log(`3 PIN Realty — Firebase stand-ins (${need.size} names imported by the pages)\n`);
for (const [stub, libs] of Object.entries(STUBS)) {
  const src = readFileSync(stub, 'utf8');
  const has = new Set();
  for (const st of src.matchAll(/export const ([^;]*);/g)) for (const n of st[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*=/g)) has.add(n[1]);
  for (const st of src.matchAll(/export (?:async )?function ([A-Za-z_$][\w$]*)/g)) has.add(st[1]);
  const missing = [...need.entries()].filter(([n, v]) => libs.includes(v.lib) && !has.has(n));
  if (missing.length) { failed++; console.log(`  FAIL  ${stub} lacks: ${missing.map(([n, v]) => `${n} (${v.from})`).join(', ')}`); }
  else console.log(`  ok    ${stub}`);
}
console.log(failed ? `\n${failed} stand-in(s) incomplete.` : '\nAll good.');
process.exit(failed ? 1 : 0);
