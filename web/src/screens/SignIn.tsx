// The way in: sign in to the service, create its first account, or open the sample library.
// The service says how it signs people in: with a password it keeps itself, or with a Google
// account (through Firebase), in which case it keeps no password at all.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, type Registration } from '../api/types';
import { useApp } from '../app/context';
import { Button, Field, Fig, State, Wordmark } from '../ds';
import { CoverArt } from '../parts/CoverArt';

// Which way of signing in the service used last time, so the right form shows while it wakes.
const WAY_KEY = 'openleaf.signin';
type Way = 'local' | 'firebase';
function rememberedWay(): Way | null {
  try {
    const v = localStorage.getItem(WAY_KEY);
    return v === 'local' || v === 'firebase' ? v : null;
  } catch {
    return null;
  }
}

type Reach = { state: 'asking' } | { state: 'answered'; registration: Registration } | { state: 'silent'; why: string };

export function SignIn() {
  const { service, signIn, openSample } = useApp();
  const [reach, setReach] = useState<Reach>({ state: 'asking' });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: 'email' | 'password' | 'invite' | 'form'; text: string } | null>(null);
  // With Google: the proof of who is signing in, kept while a new account is asked for the invite code.
  const [proof, setProof] = useState<{ idToken: string; email: string } | null>(null);

  // A sleeping service takes about a minute to wake: keep asking for two before giving up.
  const retry = useRef<number | undefined>(undefined);
  const ask = useCallback(() => {
    window.clearTimeout(retry.current);
    setReach({ state: 'asking' });
    let tries = 0;
    const once = () => {
      service.registration()
        .then((registration) => {
          setReach({ state: 'answered', registration });
          try { localStorage.setItem(WAY_KEY, registration.provider ?? 'local'); } catch { /* storage refused */ }
          // A service with no account yet: the first thing to do is create it.
          if (!registration.hasUsers && registration.open) setCreating(true);
        })
        .catch((err: unknown) => {
          const waking = err instanceof ApiError && err.code === 'unreachable';
          if (waking && ++tries < 24) retry.current = window.setTimeout(once, 5000);
          else setReach({ state: 'silent', why: err instanceof Error ? err.message : 'The service did not answer.' });
        });
    };
    once();
  }, [service]);

  useEffect(() => {
    ask();
    return () => window.clearTimeout(retry.current);
  }, [ask]);

  const registration = reach.state === 'answered' ? reach.registration : null;
  const mayCreate = registration?.open ?? false;
  const firebase = registration?.provider === 'firebase' ? registration.firebase ?? null : null;
  // Until the service has said how it signs people in, go by last time; the first time, show no form yet.
  const way: Way | null = registration ? registration.provider ?? 'local' : rememberedWay();
  const withGoogle = way === 'firebase';
  const withPassword = way === 'local';

  // Fetch the Google sign-in code ahead of the click, so the click itself opens the window at once.
  useEffect(() => {
    if (withGoogle) void import('../lib/google').catch(() => {});
  }, [withGoogle]);

  /** Hand the proof to the service. A new account on an invite-only service is asked for the code first. */
  const present = async (idToken: string, email: string, inviteCode?: string) => {
    try {
      signIn(await service.firebaseSignIn(idToken, inviteCode));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      const text = err instanceof Error ? err.message : 'That did not work.';
      if (code === 'invite_required') {
        setProof({ idToken, email });
        setInvite('');
      } else if (code === 'invalid_invite_code') {
        setProof({ idToken, email });
        setError({ field: 'invite', text });
      } else {
        // An hour-old proof, a closed service, an address already in use: start again from Google.
        setProof(null);
        setError({ field: 'form', text });
      }
    }
  };

  const continueWithGoogle = async () => {
    if (busy || !firebase) return;
    setError(null);
    setBusy(true);
    try {
      const { proveWithGoogle } = await import('../lib/google');
      const proved = await proveWithGoogle(firebase);
      if (proved) await present(proved.idToken, proved.email);
    } catch (err) {
      setError({ field: 'form', text: err instanceof Error ? err.message : 'Google\u2019s sign-in did not finish. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  const submitInvite = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !proof) return;
    setError(null);
    if (!invite.trim()) return setError({ field: 'invite', text: 'The invite code is needed.' });
    setBusy(true);
    try {
      await present(proof.idToken, proof.email, invite.trim());
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!email.trim()) return setError({ field: 'email', text: 'An email address is needed.' });
    if (creating && password.length < 8) return setError({ field: 'password', text: 'Use at least 8 characters.' });
    if (!password) return setError({ field: 'password', text: 'A password is needed.' });
    setBusy(true);
    try {
      const session = creating
        ? await service.register({ email: email.trim(), password, displayName: name.trim() || undefined, inviteCode: invite.trim() || undefined })
        : await service.login(email.trim(), password);
      signIn(session);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      const text = err instanceof Error ? err.message : 'That did not work.';
      if (code === 'invalid_invite_code') setError({ field: 'invite', text });
      else if (code === 'invalid_email' || code === 'email_taken') setError({ field: 'email', text });
      else if (code === 'weak_password' || code === 'invalid_credentials') setError({ field: 'password', text });
      else setError({ field: 'form', text });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ol-signin">
      <main className="ol-signin__page">
        <Wordmark size="title" />
        <h1 className="ol-screen__title ol-signin__title">{withGoogle ? (proof ? 'Create the account' : 'Sign in') : creating ? 'Create the account' : 'Sign in'}</h1>
        <p className="ol-screen__lede">
          {withGoogle
            ? proof
              ? registration && !registration.hasUsers
                ? 'This service has no account yet. The first one made becomes its owner.'
                : 'A new account on this service.'
              : 'Your projects are kept on your own service. Sign in with your Google account to open them.'
            : creating
              ? registration && !registration.hasUsers
                ? 'This service has no account yet. The first one made becomes its owner.'
                : 'A new account on this service.'
              : 'Your projects are kept on your own service. Sign in to open them.'}
        </p>

        <p className="ol-signin__service">
          <Fig>{service.address}</Fig>
          {reach.state === 'asking' && <State tone="asks">Waking the service</State>}
          {reach.state === 'answered' && <State tone="settled">Awake</State>}
          {reach.state === 'silent' && <State tone="broken">No answer</State>}
          {reach.state === 'silent' && <Button variant="bare" onClick={ask}>Try again</Button>}
        </p>
        {reach.state === 'asking' && (
          <p className="voice-scholion ol-signin__hint">A sleeping service takes up to a minute to answer the first time.</p>
        )}
        {reach.state === 'silent' && <p className="voice-scholion ol-signin__hint">{reach.why}</p>}

        {withGoogle && !proof && (
          <div className="ol-signin__form">
            {error?.field === 'form' && <p className="ol-signin__error"><State tone="broken">{error.text}</State></p>}
            <div className="ol-signin__actions">
              <Button variant="ink" onClick={() => void continueWithGoogle()} disabled={busy || !firebase}>{busy ? 'Waiting for Google' : 'Continue with Google'}</Button>
            </div>
            <p className="voice-scholion ol-signin__hint">Google asks which account, in a window of its own. This service keeps no password.</p>
          </div>
        )}

        {withGoogle && proof && (
          <form className="ol-signin__form" onSubmit={submitInvite} noValidate>
            <p className="ol-signin__who"><Fig>{proof.email}</Fig> has no account here yet.</p>
            <Field
              label="Invite code" source value={invite} onChange={setInvite} autoComplete="off" autoFocus
              hint="The INVITE_CODE set on the service."
              error={error?.field === 'invite' ? error.text : undefined}
            />
            <div className="ol-signin__actions">
              <Button variant="ink" type="submit" disabled={busy}>{busy ? 'Creating' : 'Create the account'}</Button>
              <Button variant="bare" onClick={() => { setProof(null); setError(null); }}>Use another Google account</Button>
            </div>
          </form>
        )}

        {withPassword && <form className="ol-signin__form" onSubmit={submit} noValidate>
          {creating && <Field label="Name" value={name} onChange={setName} autoComplete="name" placeholder="As it should appear on title pages" />}
          <Field
            label="Email" type="email" name="email" value={email} onChange={setEmail} autoComplete="username" autoFocus
            error={error?.field === 'email' ? error.text : undefined}
          />
          <Field
            label="Password" type="password" name="password" value={password} onChange={setPassword}
            autoComplete={creating ? 'new-password' : 'current-password'}
            hint={creating ? 'At least 8 characters.' : undefined}
            error={error?.field === 'password' ? error.text : undefined}
          />
          {creating && registration?.requiresInviteCode && (
            <Field
              label="Invite code" source value={invite} onChange={setInvite} autoComplete="off"
              hint="The INVITE_CODE set on the service."
              error={error?.field === 'invite' ? error.text : undefined}
            />
          )}
          {error?.field === 'form' && <p className="ol-signin__error"><State tone="broken">{error.text}</State></p>}
          <div className="ol-signin__actions">
            <Button variant="ink" type="submit" disabled={busy}>{busy ? (creating ? 'Creating' : 'Signing in') : creating ? 'Create the account' : 'Sign in'}</Button>
            {mayCreate && (
              <Button variant="bare" onClick={() => { setCreating((c) => !c); setError(null); }}>
                {creating ? 'Sign in instead' : 'Create an account'}
              </Button>
            )}
          </div>
        </form>}

        <div className="ol-signin__sample">
          <p className="voice-scholion">Or look around first. The sample library needs no account and saves nothing.</p>
          <Button onClick={openSample}>Open the sample library</Button>
        </div>
      </main>
      <aside className="ol-signin__art"><CoverArt /></aside>
    </div>
  );
}
