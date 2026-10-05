// "Continue with Google": Firebase opens Google's own window, and what comes back is a short-lived
// token saying which Google account is at the keyboard. OpenLeaf's service checks that token and
// answers with its own session, so nothing from Firebase is kept in this browser: the sign-in is
// held in memory only, and is dropped as soon as the token has been read.
import { FirebaseError, initializeApp } from '@firebase/app';
import {
  GoogleAuthProvider, browserPopupRedirectResolver, inMemoryPersistence, initializeAuth, signInWithPopup, signOut,
  type Auth,
} from '@firebase/auth';

export interface FirebaseSettings { apiKey: string; authDomain: string; projectId: string }

export interface GoogleProof { idToken: string; email: string }

/** Something went wrong that the person can act on; `message` is written to be shown as it is. */
export class GoogleSignInError extends Error {}

let auth: Auth | null = null;

function authFor(settings: FirebaseSettings): Auth {
  if (!auth) {
    const app = initializeApp({ apiKey: settings.apiKey, authDomain: settings.authDomain, projectId: settings.projectId });
    auth = initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver });
  }
  return auth;
}

const SAID: Record<string, string> = {
  'auth/popup-blocked': 'The browser blocked Google’s window. Allow pop-ups for this page, then try again.',
  'auth/unauthorized-domain': 'This page’s address is not yet allowed to sign in. Add it under Authentication, Settings, Authorised domains in the Firebase project.',
  'auth/operation-not-allowed': 'Google sign-in is not switched on in the Firebase project (Authentication, Sign-in method).',
  'auth/network-request-failed': 'Google could not be reached. Check the connection and try again.',
  'auth/invalid-api-key': 'The service gave a Firebase key that Google does not accept. Check FIREBASE_API_KEY on the service.',
  'auth/web-storage-unsupported': 'This browser is blocking the storage Google’s window needs. Allow cookies for this page, or try another browser.',
};

/**
 * Opens Google's window. Answers with the proof once an account is chosen,
 * or with null when the window was closed without choosing.
 */
export async function proveWithGoogle(settings: FirebaseSettings): Promise<GoogleProof | null> {
  const a = authFor(settings);
  const provider = new GoogleAuthProvider();
  // Always ask which account: a personal service is often opened next to a work account.
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    const result = await signInWithPopup(a, provider);
    return { idToken: await result.user.getIdToken(), email: result.user.email ?? '' };
  } catch (err) {
    const code = err instanceof FirebaseError ? err.code : '';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' || code === 'auth/user-cancelled') return null;
    throw new GoogleSignInError(SAID[code] ?? `Google’s sign-in did not finish${code ? ` (${code})` : ''}. Try again.`);
  } finally {
    void signOut(a).catch(() => {});
  }
}
