import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { FirebaseConfig } from '../../config.js';
import { forbidden, unauthorized } from '../../core/errors.js';

/** What a checked Firebase ID token says about the person holding it. */
export interface FirebaseIdentity {
  /** Firebase's permanent id for the account. */
  uid: string;
  email: string;
  name: string;
  /** How they signed in to Firebase, e.g. `google.com`. */
  signInProvider: string;
}

export type IdTokenVerifier = (idToken: string) => Promise<FirebaseIdentity>;

/**
 * Checks Firebase ID tokens the way Firebase documents it for servers without the Admin SDK:
 * an RS256 signature by one of Google's published keys, issued for this project, not expired,
 * and carrying a subject. On top of that OpenLeaf wants an email address that the sign-in
 * provider has verified, and a sign-in method this instance accepts.
 *
 * The keys are fetched once and cached; they are re-fetched when a token names a key that is
 * not among them (Google rotates the keys every few days).
 */
export function firebaseVerifier(firebase: FirebaseConfig): IdTokenVerifier {
  const keys = createRemoteJWKSet(new URL(firebase.jwksUrl), { cooldownDuration: 30_000, timeoutDuration: 10_000 });
  const allowed = new Set(firebase.signInProviders);

  return async (idToken) => {
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, keys, {
        algorithms: ['RS256'],
        issuer: `https://securetoken.google.com/${firebase.projectId}`,
        audience: firebase.projectId,
        clockTolerance: 30,
        requiredClaims: ['sub', 'iat', 'exp', 'auth_time'],
      }));
    } catch {
      throw unauthorized('That sign-in could not be checked. Sign in with Google again.', 'invalid_id_token');
    }

    const now = Math.floor(Date.now() / 1000) + 30;
    const authTime = payload.auth_time;
    if (typeof payload.sub !== 'string' || !payload.sub || typeof authTime !== 'number' || authTime > now) {
      throw unauthorized('That sign-in could not be checked. Sign in with Google again.', 'invalid_id_token');
    }
    if (typeof payload.iat !== 'number' || payload.iat > now) {
      throw unauthorized('That sign-in could not be checked. Sign in with Google again.', 'invalid_id_token');
    }

    const fb = payload.firebase as { sign_in_provider?: unknown } | undefined;
    const signInProvider = typeof fb?.sign_in_provider === 'string' ? fb.sign_in_provider : '';
    if (!allowed.has(signInProvider)) {
      throw forbidden('This OpenLeaf instance does not accept that way of signing in.', 'sign_in_method_not_allowed');
    }

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!email || payload.email_verified !== true) {
      throw forbidden('That account has no verified email address.', 'email_not_verified');
    }

    return {
      uid: payload.sub,
      email,
      name: typeof payload.name === 'string' ? payload.name.trim().slice(0, 120) : '',
      signInProvider,
    };
  };
}
