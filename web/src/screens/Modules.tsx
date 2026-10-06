// Modules: what the workspace is made of, what it is joined to, and who is signed in.
import { useEffect, useState } from 'react';
import { useApp } from '../app/context';
import { Button, Confirm, Fig, Ledger, Rail, State, Switch, Wordmark, type LedgerRow } from '../ds';
import { bytes, saveBlob } from '../lib/format';
import type { PaneKey, ThemeChoice } from '../lib/prefs';
import { go } from '../lib/router';
import { failure, Notice, type NoticeData } from '../parts/Notice';
import { Select } from '../parts/Select';
import { useGithub } from '../parts/useGithub';

export function Modules() {
  const { api, user, info, prefs, setPrefs, signOut } = useApp();
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [busy, setBusy] = useState(false);
  const github = useGithub(api);
  const [asking, setAsking] = useState<'unlink' | 'everywhere' | null>(null);
  const [sessions, setSessions] = useState<number | null>(null);

  useEffect(() => {
    if (api.kind !== 'service') return;
    api.sessions().then((s) => setSessions(s.length)).catch(() => setSessions(null));
  }, [api]);

  const everywhere = async () => {
    setBusy(true);
    try {
      await api.logoutAll();
      signOut();
    } catch (err) {
      setNotice(failure(err, 'sign out everywhere'));
      setBusy(false);
      setAsking(null);
    }
  };

  const serves = (name: string) => info?.modules.some((m) => m.name === name) ?? true;
  const pane = (key: PaneKey, label: string, available = true) => (
    <Switch
      label={label} checked={available && prefs.panes[key]} disabled={!available}
      onChange={(on) => setPrefs((p) => ({ ...p, panes: { ...p.panes, [key]: on } }))}
    />
  );

  const modules: LedgerRow[] = [
    { letter: 'S', title: 'Source', note: 'The one module that cannot be put away.', end: <Switch label="Source" checked disabled /> },
    { letter: 'P', title: 'Proof', note: serves('compile') ? 'The compiled pages, kept in step with the caret.' : 'Switched off on this service.', end: pane('proof', 'Proof', serves('compile')) },
    { letter: 'A', title: 'Apparatus', note: serves('compile') ? 'What the compiler said, under the text it concerns.' : 'Switched off on this service.', end: pane('apparatus', 'Apparatus', serves('compile')) },
    { letter: 'O', title: 'Outline', note: 'Sections, numbered as LaTeX numbers them.', end: pane('outline', 'Outline') },
    { letter: 'F', title: 'Files', note: 'The project’s files, as they stand.', end: pane('files', 'Files') },
    { letter: 'H', title: 'History', note: serves('history') ? 'Saved versions, and the difference between any one and now.' : 'Switched off on this service.', end: pane('history', 'History', serves('history')) },
    { letter: 'C', title: 'Counsel', note: 'A model that reads along and leaves notes in the margin. Not built yet.', end: <Switch label="Counsel" checked={false} disabled /> },
  ];

  const engines = info?.compile?.engines.filter((e) => e.available).map((e) => e.label) ?? [];
  const connections: LedgerRow[] = [
    {
      title: api.kind === 'sample' ? 'Sample library' : 'Service',
      note: api.kind === 'sample' ? 'Nothing is kept. Sign out to link your own service.' : <>Where projects are kept and compiled: <Fig>{api.address}</Fig></>,
      end: info ? <State tone={api.kind === 'sample' ? 'note' : 'settled'}>{api.kind === 'sample' ? 'In this tab' : <>Awake, <Fig>v{info.version}</Fig></>}</State> : <State tone="asks">Asking</State>,
    },
    ...(api.kind === 'service'
      ? [{
          title: 'LaTeX',
          note: engines.length ? `Engines on the service: ${engines.join(', ')}.` : 'No engine has answered yet.',
          end: info?.compile ? <Fig>{info.compile.defaultEngine}</Fig> : null,
        }]
      : []),
    github.state?.available
      ? github.state.account
        ? {
            title: 'GitHub',
            note: <>Linked as <Fig>{github.state.account.login}</Fig>. Each project is saved to a repository of its own, from its History pane.</>,
            end: <Button onClick={() => setAsking('unlink')}>Unlink</Button>,
          }
        : {
            title: 'GitHub',
            note: 'Keep each project in a GitHub repository of its own. Linking uses a one-time code typed in at GitHub; no password comes through here.',
            end: github.phase === 'waiting' || github.phase === 'starting'
              ? <State tone="asks">Waiting for GitHub</State>
              : <Button onClick={() => void github.start()}>Link</Button>,
          }
      : {
          title: 'GitHub',
          note: api.kind === 'sample' ? 'The sample library is not joined to anything.' : 'Keeping each project in a repository of its own. Not set up on this service.',
          end: <State tone="note">{github.state ? 'Not set up' : 'Asking'}</State>,
        },
    { title: 'Hugging Face', note: 'Where Counsel’s model would run. Not built yet.', end: <State tone="note">Not linked</State> },
  ];

  const backup = async () => {
    setBusy(true);
    try {
      saveBlob(await api.backupAll(), `openleaf-backup-${new Date().toISOString().slice(0, 10)}.zip`);
    } catch (err) {
      setNotice(failure(err, 'make the backup'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ol-screen">
      <Rail active="M" modules={[{ letter: 'L', label: 'Library' }]} foot={[{ letter: 'M', label: 'Modules' }]} onSelect={(l) => l === 'L' && go({ name: 'library' })} />
      <main className="ol-screen__page">
        <Wordmark />
        <h1 className="ol-screen__title ol-screen__title--first">Modules</h1>
        <p className="ol-screen__lede">OpenLeaf is one source pane and whatever you set around it. Put a module away and the workspace closes over the gap.</p>
        {notice && <Notice notice={notice} onDismiss={() => setNotice(null)} />}

        <div className="ol-screen__cols">
          <div>
            <h2 className="ol-screen__heading">Around the source</h2>
            <Ledger rows={modules} />

            <h2 className="ol-screen__heading">While writing</h2>
            <Ledger rows={[
              { title: 'Scholia margin', note: 'Notes set beside the line they concern. It gives way first when the window is narrow.', end: pane('margin', 'Scholia margin') },
              { title: 'Compile after saving', note: 'A proof is made a moment after each save. Slow on a small service.', end: <Switch label="Compile after saving" checked={prefs.autoCompile} onChange={(on) => setPrefs((p) => ({ ...p, autoCompile: on }))} /> },
            ]} />
          </div>

          <div>
            <h2 className="ol-screen__heading">Connections</h2>
            <Ledger rows={connections} />
            {github.link && (
              <div className="ol-confirm ol-strip" role="status">
                <div className="ol-confirm__words">
                  <p className="ol-confirm__question">Type this code in at GitHub: <Fig><span className="ol-github__code">{github.link.userCode}</span></Fig></p>
                  <p className="ol-confirm__detail">
                    GitHub asks you to sign in there and to approve OpenLeaf. It can then read and write your repositories{github.state?.scope === 'public_repo' ? ' (public ones only)' : ', private ones included'}, so that it can create one for each project and save to it. This page waits and carries on by itself.
                  </p>
                </div>
                <div className="ol-confirm__actions">
                  <Button onClick={github.stop}>Stop</Button>
                  <Button variant="ink" onClick={() => window.open(github.link!.verificationUri, '_blank', 'noopener')}>Open GitHub</Button>
                </div>
              </div>
            )}
            {(github.phase === 'expired' || github.phase === 'denied') && (
              <Notice
                notice={{ tone: 'note', text: github.phase === 'denied' ? 'GitHub was told no, so nothing was linked.' : 'The code ran out before it was used. Nothing was linked.' }}
                onDismiss={github.stop}
              />
            )}
            {github.error && <Notice notice={{ tone: 'broken', text: 'GitHub could not be linked.', detail: github.error }} />}
            {asking === 'unlink' && (
              <Confirm
                question="Unlink GitHub?"
                detail="OpenLeaf forgets its token. Your repositories stay as they are. To withdraw the permission at GitHub as well, revoke OpenLeaf under Settings, Applications, Authorized OAuth Apps."
                confirmLabel="Unlink" cancelLabel="Keep" danger={false}
                onCancel={() => setAsking(null)} onConfirm={() => { setAsking(null); void github.unlink(); }}
              />
            )}

            <h2 className="ol-screen__heading">Light</h2>
            <div className="ol-screen__fields">
              <Select
                label="Theme" value={prefs.theme} onChange={(theme) => setPrefs((p) => ({ ...p, theme: theme as ThemeChoice }))}
                options={[{ value: 'auto', label: 'Follow this computer' }, { value: 'light', label: 'Daylight' }, { value: 'dark', label: 'Lamplight' }]}
              />
            </div>

            <h2 className="ol-screen__heading">Account</h2>
            <Ledger rows={[
              { title: user?.displayName || user?.email || 'Signed in', note: <><Fig>{user?.email}</Fig>{user?.role === 'owner' ? ', owner of this service' : ''}</>, end: <Button onClick={signOut}>Sign out</Button> },
              ...(api.kind === 'service'
                ? [{
                    title: 'Sessions',
                    note: sessions === null
                      ? 'Every browser this account is signed in on.'
                      : sessions === 1 ? 'Signed in on this browser only.' : `Signed in on ${sessions} browsers. A session ends 30 days after it was last used.`,
                    end: <Button onClick={() => setAsking('everywhere')} disabled={busy}>Sign out everywhere</Button>,
                  }]
                : []),
              ...(api.kind === 'service'
                ? [{
                    title: 'Backup',
                    note: `Every project as one zip.${info ? ` A project may hold up to ${bytes(info.limits.maxProjectBytes)}.` : ''}`,
                    end: <Button onClick={() => void backup()} disabled={busy}>{busy ? 'Packing' : 'Download'}</Button>,
                  }]
                : []),
            ]} />
            {asking === 'everywhere' && (
              <Confirm
                question="Sign out everywhere?"
                detail="Every browser signed in to this account is signed out, this one included. Use it if a session may have been left open somewhere."
                confirmLabel="Sign out everywhere" cancelLabel="Stay" danger={false}
                onCancel={() => setAsking(null)} onConfirm={() => void everywhere()}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
