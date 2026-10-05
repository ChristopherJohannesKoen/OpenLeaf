// What every screen shares: the back end in use, who is signed in, and the preferences.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HttpApi } from '../api/http';
import { SampleApi } from '../api/sample';
import type { Api, Session, SystemInfo, User } from '../api/types';
import { applyTheme, DEFAULT_PREFS, loadLocalPrefs, prefsFromSettings, saveLocalPrefs, type Prefs } from '../lib/prefs';

const SESSION_KEY = 'openleaf.session';
const SAMPLE_KEY = 'openleaf.sample';
const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

interface AppValue {
  api: Api;
  /** The service, whether or not it is the back end in use (the sign-in screen talks to it). */
  service: HttpApi;
  user: User | null;
  info: SystemInfo | null;
  prefs: Prefs;
  setPrefs: (change: (prefs: Prefs) => Prefs) => void;
  signIn: (session: Session) => void;
  signOut: () => void;
  openSample: () => void;
}

const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>.');
  return value;
}

function storedSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function inSampleMode(): boolean {
  try {
    return sessionStorage.getItem(SAMPLE_KEY) === '1';
  } catch {
    return false;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => (inSampleMode() ? null : storedSession()));
  const [sample, setSample] = useState<SampleApi | null>(() => (inSampleMode() ? new SampleApi() : null));
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(loadLocalPrefs);

  const service = useMemo(() => new HttpApi(API_BASE, storedSession()?.token ?? null, API_BASE || (import.meta.env.DEV ? __OPENLEAF_PROXY__ : undefined)), []);
  const api: Api = sample ?? service;
  const user = sample ? SAMPLE_USER : session?.user ?? null;

  const signOut = useCallback(() => {
    if (!sample && session) void service.logout().catch(() => {});
    try {
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SAMPLE_KEY);
    } catch { /* storage refused */ }
    service.setToken(null);
    setSession(null);
    setSample(null);
    setInfo(null);
    // The next person to sign in starts at the Library, not wherever this one left off.
    window.location.hash = '#/';
  }, [sample, session, service]);

  useEffect(() => {
    service.onSignedOut = () => {
      try { localStorage.removeItem(SESSION_KEY); } catch { /* storage refused */ }
      service.setToken(null);
      setSession(null);
    };
    return () => { service.onSignedOut = null; };
  }, [service]);

  const signIn = useCallback((next: Session) => {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(next)); } catch { /* storage refused */ }
    service.setToken(next.token);
    setSample(null);
    setSession(next);
  }, [service]);

  const openSample = useCallback(() => {
    try { sessionStorage.setItem(SAMPLE_KEY, '1'); } catch { /* storage refused */ }
    setSample(new SampleApi());
  }, []);

  // Once signed in: what the back end is, and the preferences kept with the account.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    api.info().then((i) => alive && setInfo(i)).catch(() => {});
    api.getSettings()
      .then((settings) => {
        if (!alive) return;
        setPrefsState((local) => {
          const next = prefsFromSettings(settings, local);
          saveLocalPrefs(next);
          return next;
        });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [api, user]);

  useEffect(() => applyTheme(prefs.theme), [prefs.theme]);

  const pending = useRef<number | undefined>(undefined);
  const setPrefs = useCallback((change: (prefs: Prefs) => Prefs) => {
    setPrefsState((current) => {
      const next = change(current);
      saveLocalPrefs(next);
      window.clearTimeout(pending.current);
      pending.current = window.setTimeout(() => { void api.patchSettings({ openleaf: next }).catch(() => {}); }, 600);
      return next;
    });
  }, [api]);

  const value = useMemo<AppValue>(
    () => ({ api, service, user, info, prefs, setPrefs, signIn, signOut, openSample }),
    [api, service, user, info, prefs, setPrefs, signIn, signOut, openSample],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

const SAMPLE_USER: User = { id: 'sample', email: 'sample@openleaf.local', displayName: 'Sample reader', role: 'owner', createdAt: new Date(0).toISOString() };

export { DEFAULT_PREFS };
