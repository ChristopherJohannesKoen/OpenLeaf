// The History pane: saved versions, what changed since each, and the way back.
import { useCallback, useEffect, useState } from 'react';
import type { Api, Change, Version } from '../api/types';
import { Button, Confirm, cx, Field, Fig, Mark, Pane } from '../ds';
import { clock, when } from '../lib/format';

interface Props {
  api: Api;
  projectId: string;
  /** Increases whenever the project's files change, so the comparison is made again. */
  tick: number;
  onDiff: (version: Version, path: string) => void;
  /** Save what is being edited before a version is made or restored. */
  beforeAction: () => Promise<void>;
  onRestored: () => Promise<void>;
}

const LETTER: Record<Change['status'], 'A' | 'M' | 'D'> = { added: 'A', modified: 'M', removed: 'D' };
const SAID: Record<Change['status'], string> = { added: 'added since', modified: 'changed since', removed: 'removed since' };

export function HistoryPane({ api, projectId, tick, onDiff, beforeAction, onRestored }: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [label, setLabel] = useState('');
  const [restoring, setRestoring] = useState<Version | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setVersions(await api.listVersions(projectId));
    } catch (err) {
      setVersions([]);
      setError(err instanceof Error ? err.message : 'History could not be read.');
    }
  }, [api, projectId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selected) { setChanges(null); return; }
    let alive = true;
    setChanges(null);
    api.versionChanges(projectId, selected).then((c) => alive && setChanges(c)).catch(() => alive && setChanges([]));
    return () => { alive = false; };
  }, [api, projectId, selected, tick]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await beforeAction();
      const version = await api.createVersion(projectId, label.trim());
      setLabel('');
      await load();
      setSelected(version.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The version could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (version: Version) => {
    setBusy(true);
    setError(null);
    try {
      await beforeAction();
      await api.restoreVersion(projectId, version.id);
      setRestoring(null);
      await onRestored();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The version could not be restored.');
    } finally {
      setBusy(false);
    }
  };

  const picked = versions?.find((v) => v.id === selected) ?? null;

  return (
    <Pane letter="H" title="History" meta={versions ? String(versions.length) : ''}>
      <div className="ol-pane__scroll">
        <form className="ol-pane__ask" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Field label="Save a version" value={label} onChange={setLabel} placeholder="What changed, in a few words" error={error ?? undefined} />
          <div className="ol-pane__ask-actions">
            <Button type="submit" disabled={busy}>Save version</Button>
          </div>
        </form>

        {restoring && (
          <div className="ol-pane__ask">
            <Confirm
              question={`Put the project back to ${when(restoring.createdAt)}?`}
              detail="What you have now is saved as a version first, so this can be undone."
              confirmLabel="Restore" cancelLabel="Stay" danger={false}
              onCancel={() => setRestoring(null)} onConfirm={() => void restore(restoring)}
            />
          </div>
        )}

        {versions && versions.length === 0 && <p className="ol-empty ol-empty--pane">No versions yet. One is kept after each proof that compiles, and whenever you save one.</p>}

        <ol className="ol-history">
          {versions?.map((v) => (
            <li key={v.id}>
              <button
                type="button" className={cx('ol-history__item', v.id === selected && 'ol-history__item--active')}
                onClick={() => setSelected(v.id === selected ? null : v.id)} aria-expanded={v.id === selected}
              >
                <span>{v.id === selected && <Mark tone="here" />}</span>
                <span className="ol-fig ol-history__when">{when(v.createdAt).replace('today ', '')}{when(v.createdAt).startsWith('today') ? '' : ` ${clock(v.createdAt)}`}</span>
                <span className="ol-history__label">{v.label || (v.kind === 'auto' ? 'kept after a proof' : v.kind === 'restore' ? 'kept before a restore' : 'unnamed')}</span>
              </button>
              {v.id === selected && (
                <div className="ol-history__detail">
                  {changes === null && <p className="ol-history__none">Comparing with now.</p>}
                  {changes && changes.length === 0 && <p className="ol-history__none">Nothing has changed since.</p>}
                  {changes?.map((c) => (
                    <button key={c.path} type="button" className="ol-file ol-history__change" title={`${c.path}: ${SAID[c.status]}`} onClick={() => picked && onDiff(picked, c.path)}>
                      <span />
                      <span className="ol-file__name">{c.path}</span>
                      <span className={`ol-file__status ol-file__status--${LETTER[c.status]}`}>{LETTER[c.status]}</span>
                    </button>
                  ))}
                  <div className="ol-pane__ask-actions">
                    <Fig>{v.fileCount} files</Fig>
                    <Button variant="bare" onClick={() => setRestoring(v)} disabled={busy || (changes !== null && changes.length === 0)}>Restore</Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>
    </Pane>
  );
}
