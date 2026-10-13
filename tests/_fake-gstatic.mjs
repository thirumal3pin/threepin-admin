// firebase-firestore.js, as the pages import it — over the in-memory store a test puts in
// globalThis.__fakeStore (tests/fake-firestore.mjs).
import { webApi, FieldPath as FP } from './fake-firestore.mjs';
const api = () => webApi(globalThis.__fakeStore);
export const doc = (...a) => api().doc(...a);
export const collection = (...a) => api().collection(...a);
export const where = (...a) => api().where(...a);
export const query = (...a) => api().query(...a);
export const getDoc = (...a) => api().getDoc(...a);
export const getDocs = (...a) => api().getDocs(...a);
export const setDoc = (...a) => api().setDoc(...a);
export const updateDoc = (...a) => api().updateDoc(...a);
export const deleteDoc = (...a) => api().deleteDoc(...a);
export const onSnapshot = (...a) => api().onSnapshot(...a);
export const writeBatch = (...a) => api().writeBatch(...a);
export const runTransaction = (...a) => api().runTransaction(...a);
export const deleteField = () => api().deleteField();
export const serverTimestamp = () => api().serverTimestamp();
export const FieldPath = FP;
// The rest of the library, as far as a page needs it to load (setup and finance-only calls).
export const getFirestore = () => ({}), initializeFirestore = () => ({}), persistentLocalCache = () => ({}), persistentMultipleTabManager = () => ({});
export const terminate = async () => {}, clearIndexedDbPersistence = async () => {}, waitForPendingWrites = async () => {};
export const getDocFromServer = (...a) => api().getDoc(...a), getDocsFromServer = (...a) => api().getDocs(...a);
export const limit = n => ({ limit: n }), orderBy = f => ({ orderBy: f }), getCountFromServer = async () => ({ data: () => ({ count: 0 }) });
export const Timestamp = { fromMillis: ms => ({ toMillis: () => ms }), now: () => ({ toMillis: () => Date.now() }) };
