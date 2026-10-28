// Local dev only: firebase-auth.js for the CRM page. The signed-in user is the one the dev server
// says (/__dev/whoami, set by scripts/dev/replica.mjs); the ID token is "dev:<email>", which only
// the dev server's verifyCrmUser accepts (scripts/dev/bot-shared.dev.mjs).
// Pages that sign in without Firestore (Home) still get the dev user and data.
import '/scripts/dev/replica.mjs';
const userObj = () => {
  const u = globalThis.__fakeUser;
  if (!u) return null;
  return { email: u.email, uid: u.email, emailVerified: true,
    getIdToken: async () => 'dev:' + u.email,
    getIdTokenResult: async () => ({ claims: { tenantId: u.tenantId } }) };
};
export const getAuth = () => ({ get currentUser() { return userObj(); } });
export const onAuthStateChanged = (auth, cb) => { setTimeout(() => cb(userObj()), 0); return () => {}; };
export const signInWithEmailAndPassword = async () => ({ user: userObj() });
export const signOut = async () => { location.href = '/__dev/signout'; };
// The home page's Google button (signs in as the dev user).
export class GoogleAuthProvider { setCustomParameters() {} }
export const signInWithPopup = async () => ({ user: userObj() });
