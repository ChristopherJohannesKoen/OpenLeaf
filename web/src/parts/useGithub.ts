// Linking a GitHub account from the Modules screen. GitHub's "device flow": the service asks
// GitHub for a short code, the person types it in at github.com and approves, and the service
// is then handed a token which it keeps (encrypted) and never shows. No GitHub password and no
// token ever pass through this page.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, GithubLinkStart, GithubState } from '../api/types';

export type LinkPhase = 'idle' | 'starting' | 'waiting' | 'expired' | 'denied';

export function useGithub(api: Api) {
  const [state, setState] = useState<GithubState | null>(null);
  const [link, setLink] = useState<GithubLinkStart | null>(null);
  const [phase, setPhase] = useState<LinkPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const read = useCallback(() => {
    api.github().then(setState).catch(() => setState({ available: false, scope: null, account: null }));
  }, [api]);
  useEffect(() => {
    read();
    return () => window.clearTimeout(timer.current);
  }, [read]);

  const stop = useCallback(() => {
    window.clearTimeout(timer.current);
    setLink(null);
    setPhase('idle');
  }, []);

  const start = useCallback(async () => {
    window.clearTimeout(timer.current);
    setError(null);
    setPhase('starting');
    try {
      const started = await api.githubLinkStart();
      setLink(started);
      setPhase('waiting');
      const ask = (afterSeconds: number) => {
        timer.current = window.setTimeout(async () => {
          try {
            const answer = await api.githubLinkPoll(started.linkId);
            if (answer.status === 'pending') return ask(Math.max(answer.intervalSeconds ?? started.intervalSeconds, 2));
            if (answer.status === 'linked') {
              setState((s) => ({ available: true, scope: s?.scope ?? null, account: answer.account }));
              setLink(null);
              setPhase('idle');
              return;
            }
            setLink(null);
            setPhase(answer.status);
          } catch (err) {
            setLink(null);
            setPhase('idle');
            setError(err instanceof Error ? err.message : 'GitHub could not be asked.');
          }
        }, afterSeconds * 1000);
      };
      ask(Math.max(started.intervalSeconds, 2));
    } catch (err) {
      setPhase('idle');
      setError(err instanceof Error ? err.message : 'Linking could not be started.');
    }
  }, [api]);

  const unlink = useCallback(async () => {
    setError(null);
    try {
      await api.githubUnlink();
      setState((s) => (s ? { ...s, account: null } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The account could not be unlinked.');
    }
  }, [api]);

  return { state, link, phase, error, start, stop, unlink };
}
