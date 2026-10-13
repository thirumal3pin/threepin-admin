// firebase-auth.js, as the pages import it — for tests (tests/_gstatic-loader.mjs). The signed-in
// user is globalThis.__fakeUser = { email, tenantId } (or none), told to the page asynchronously,
// as Firebase does.
export const getAuth = () => ({ get currentUser() { return userObj(); } });
const userObj = () => {
  const u = globalThis.__fakeUser;
  if (!u) return null;
  return { email: u.email, uid: u.email, getIdToken: async () => 'fake-token', getIdTokenResult: async () => ({ claims: { tenantId: u.tenantId } }) };
};
export const onAuthStateChanged = (auth, cb) => { setTimeout(() => cb(userObj()), 0); return () => {}; };
export const signInWithEmailAndPassword = async () => ({ user: userObj() });
export const signOut = async () => { globalThis.__fakeUser = null; };
