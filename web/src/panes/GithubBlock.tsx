// The top of the History pane when the service can save to GitHub: the repository this project is
// kept in, and the button that puts what is here now into it as one commit.
import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Api, type GithubKeep, type GithubState } from '../api/types';
import { Button, Confirm, Field, Fig, State, Switch } from '../ds';
import { when } from '../lib/format';
import { go } from '../lib/router';

interface Props {
  api: Api;
  projectId: string;
  projectName: string;
  /** Increases whenever the project's files change, so "changed since" is asked again. */
  tick: number;
  /** Save what is being edited before it is sent to GitHub. */
  beforeAction: () => Promise<void>;
}

/** What GitHub accepts in a repository name, made from the project's title. */
function repoName(title: string): string {
  return title.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project';
}

export function GithubBlock({ api, projectId, projectName, tick, beforeAction }: Props) {
  const [state, setState] = useState<GithubState | null>(null);
  const [keep, setKeep] = useState<GithubKeep | null>(null);
  const [name, setName] = useState(() => repoName(projectName));
  const [isPrivate, setPrivate] = useState(true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [asking, setAsking] = useState<'overwrite' | 'forget' | null>(null);

  useEffect(() => {
    let alive = true;
    api.github().then((s) => alive && setState(s)).catch(() => alive && setState({ available: false, scope: null, account: null }));
    return () => { alive = false; };
  }, [api]);

  const linked = Boolean(state?.available && state.account);
  const read = useCallback(async () => {
    try {
      setKeep(await api.githubKeep(projectId));
    } catch {
      setKeep(null);
    }
  }, [api, projectId]);
  useEffect(() => { if (linked) void read(); }, [linked, read, tick]);

  const run = async (doing: () => Promise<GithubKeep | void>, done?: (k: GithubKeep) => string) => {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      await beforeAction();
      const result = await doing();
      if (result) {
        setKeep(result);
        if (done) setSaid(done(result));
      }
      setAsking(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'github_remote_changed') setAsking('overwrite');
      else if (err instanceof ApiError && err.code === 'github_not_linked') {
        setState((s) => (s ? { ...s, account: null } : s));
        setError(err.message);
      } else setError(err instanceof Error ? err.message : 'GitHub did not take it.');
    } finally {
      setBusy(false);
    }
  };

  const save = (overwrite = false) =>
    run(
      () => api.githubSave(projectId, { message: message.trim() || undefined, overwrite }),
      (k) => { setMessage(''); return k.saved ? 'Saved to GitHub.' : 'Nothing new to save.'; },
    );

  if (!state?.available) return null;

  if (!state.account) {
    return (
      <div className="ol-pane__ask">
        <p className="ol-github__line">GitHub: no account is linked, so this project is kept only here.</p>
        {error && <p className="ol-github__line"><State tone="broken">{error}</State></p>}
        <div className="ol-pane__ask-actions">
          <Button variant="bare" onClick={() => go({ name: 'modules' })}>Link one in Modules</Button>
        </div>
      </div>
    );
  }

  if (!keep) return null;

  if (!keep.repo) {
    return (
      <form className="ol-pane__ask ol-github__form" onSubmit={(e) => { e.preventDefault(); void run(() => api.githubCreate(projectId, { name: name.trim(), private: isPrivate }), () => 'Created and saved.'); }}>
        <Field
          label="Keep on GitHub" source value={name} onChange={setName}
          hint={<>A new repository of its own, under <Fig>{state.account.login}</Fig>.</>}
          error={error ?? undefined}
        />
        <div className="ol-pane__ask-actions ol-github__options">
          <span className="ol-github__private"><Switch label="Private repository" checked={isPrivate} onChange={setPrivate} /> <span>{isPrivate ? 'Private' : 'Public: anyone can read it'}</span></span>
          <Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating' : 'Create repository'}</Button>
        </div>
      </form>
    );
  }

  return (
    <div className="ol-pane__ask">
      <p className="ol-github__line">
        <a className="ol-link ol-fig" href={keep.repo.url} target="_blank" rel="noopener noreferrer">{keep.repo.fullName}</a>
        {' '}
        {keep.changed
          ? <State tone="asks">Changed since{keep.lastSavedAt ? ` ${when(keep.lastSavedAt)}` : ''}</State>
          : <State tone="settled">Saved{keep.lastSavedAt ? ` ${when(keep.lastSavedAt)}` : ''}</State>}
      </p>

      {asking === 'overwrite' && (
        <Confirm
          question="The repository has changes that did not come from here."
          detail="Saving puts this project's files on top. What is there now stays in the repository's history."
          confirmLabel="Save on top" cancelLabel="Leave it" danger={false}
          onCancel={() => setAsking(null)} onConfirm={() => void save(true)}
        />
      )}
      {asking === 'forget' && (
        <Confirm
          question={`Stop keeping this project in ${keep.repo.fullName}?`}
          detail="The repository and its history stay on GitHub as they are."
          confirmLabel="Stop" cancelLabel="Keep" danger={false}
          onCancel={() => setAsking(null)}
          onConfirm={() => void run(async () => { await api.githubForget(projectId); return { repo: null, lastSavedAt: null, lastCommit: null, changed: false }; })}
        />
      )}

      {asking === null && (
        <form className="ol-github__form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Field label="Save to GitHub" value={message} onChange={setMessage} placeholder="What changed, in a few words" error={error ?? undefined} hint={said ?? undefined} />
          <div className="ol-pane__ask-actions">
            <Button variant="bare" onClick={() => setAsking('forget')} disabled={busy}>Stop keeping it there</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Saving' : 'Save to GitHub'}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
