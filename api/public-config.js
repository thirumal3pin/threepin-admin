// Non-secret, client-safe config values that static pages need at runtime but
// can't read from Vercel env vars directly (there's no build/templating step
// for crm.html/dashboard.html — they're served as plain static files).
// Meta's App ID and Embedded Signup Configuration ID are NOT secrets — Meta
// requires both to appear in client-side JS for FB.init/FB.login to work —
// unlike the access token, which stays server-only (see api/_bot-shared.js).
// The Maps key rides along here rather than in a 13th serverless function:
// api/ is at Vercel's 12-function ceiling, and this endpoint already exists
// for exactly this purpose. A Maps BROWSER key is not a secret either — it
// has to appear in the script URL for the Maps JS API to load at all. It is
// protected by an HTTP-referrer restriction in the Google Cloud console, not
// by hiding it, so restrict it to admin.threepin.in/* before deploying. An
// unrestricted key in a public page is somebody else's map bill.
export async function GET() {
  return new Response(JSON.stringify({
    metaAppId: process.env.META_APP_ID || '',
    metaEmbeddedSignupConfigId: process.env.META_EMBEDDED_SIGNUP_CONFIG_ID || '',
    googleMapsApiKey: process.env.GOOGLE_MAPS_BROWSER_KEY || ''
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
