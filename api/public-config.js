// Non-secret, client-safe config values that static pages need at runtime but
// can't read from Vercel env vars directly (there's no build/templating step
// for crm.html/dashboard.html — they're served as plain static files).
// Meta's App ID and Embedded Signup Configuration ID are NOT secrets — Meta
// requires both to appear in client-side JS for FB.init/FB.login to work —
// unlike the access token, which stays server-only (see api/_bot-shared.js).
export async function GET() {
  return new Response(JSON.stringify({
    metaAppId: process.env.META_APP_ID || '',
    metaEmbeddedSignupConfigId: process.env.META_EMBEDDED_SIGNUP_CONFIG_ID || ''
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
