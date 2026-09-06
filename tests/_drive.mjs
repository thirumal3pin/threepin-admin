// Drive helper for the live E2E test: the same JWT dance as api/_brochure-shared.js, reading
// the service account key off disk the way scripts/deliver-brochures.js does.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const KEY = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH
  || 'C:/Users/3Pin Realty/Downloads/Thirumal/threepin-admin/api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json';
const IMPERSONATE = process.env.GOOGLE_IMPERSONATE_EMAIL || 'thirumal@threepin.in';
const SCOPE = 'https://www.googleapis.com/auth/drive';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function token(impersonate = true) {
  const sa = JSON.parse(readFileSync(KEY, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: sa.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  if (impersonate && IMPERSONATE) claims.sub = IMPERSONATE;
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(input); signer.end();
  const sig = signer.sign(sa.private_key).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${sig}` }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(JSON.stringify(d));
  return d.access_token;
}

export async function api(t, path, init = {}) {
  const res = await fetch('https://www.googleapis.com/drive/v3/' + path, {
    ...init,
    headers: { Authorization: `Bearer ${t}`, ...(init.headers || {}) },
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) { const e = new Error(data?.error?.message || res.status); e.status = res.status; e.data = data; throw e; }
  return data;
}

export const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
