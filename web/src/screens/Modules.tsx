// Modules: what the workspace is made of, what it is joined to, and who is signed in.
import { useState } from 'react';
import { useApp } from '../app/context';
import { Button, Fig, Ledger, Rail, State, Switch, Wordmark, type LedgerRow } from '../ds';
import { bytes, saveBlob } from '../lib/format';
import type { PaneKey, ThemeChoice } from '../lib/prefs';
import { go } from '../lib/router';
import { failure, Notice, type NoticeData } from '../parts/Notice';
import { Select } from '../parts/Select';

export function Modules() {
  const { api, user, info, prefs, setPrefs, signOut } = useApp();
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [busy, setBusy] = useState(false);

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
    { title: 'GitHub', note: 'Keeping projects in repositories. Not built yet.', end: <State tone="note">Not linked</State> },
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
                    title: 'Backup',
                    note: `Every project as one zip.${info ? ` A project may hold up to ${bytes(info.limits.maxProjectBytes)}.` : ''}`,
                    end: <Button onClick={() => void backup()} disabled={busy}>{busy ? 'Packing' : 'Download'}</Button>,
                  }]
                : []),
            ]} />
          </div>
        </div>
      </main>
    </div>
  );
}
