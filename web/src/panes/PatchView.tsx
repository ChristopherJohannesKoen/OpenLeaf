// A file's changes since a saved version, one line a row: what was taken out, what was put in.
import { useEffect, useState } from 'react';
import type { Api, FileDiff } from '../api/types';
import { readPatch } from '../lib/diff';

export function PatchView({ api, projectId, versionId, path }: { api: Api; projectId: string; versionId: string; path: string }) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setFailed(null);
    api.versionDiff(projectId, versionId, path)
      .then((d) => alive && setDiff(d))
      .catch((err: unknown) => alive && setFailed(err instanceof Error ? err.message : 'The comparison could not be made.'));
    return () => { alive = false; };
  }, [api, projectId, versionId, path]);

  if (failed) return <p className="ol-empty">{failed}</p>;
  if (!diff) return <p className="ol-empty">Comparing.</p>;
  if (diff.binary) return <p className="ol-empty">{path} is not text, so there are no lines to compare. It was {diff.status}.</p>;
  if (diff.status === 'unchanged' || !diff.patch) return <p className="ol-empty">{path} is the same now as it was then.</p>;

  const lines = readPatch(diff.patch);
  return (
    <div className="ol-patch" role="table" aria-label={`Changes to ${path}`}>
      {lines.map((line, i) =>
        line.kind === 'hunk' ? (
          <div key={i} className="ol-patch__hunk ol-caps">{line.text}</div>
        ) : (
          <div key={i} className={`ol-patch__line ol-patch__line--${line.kind}`} role="row">
            <span className="ol-patch__no">{line.before ?? ''}</span>
            <span className="ol-patch__no">{line.after ?? ''}</span>
            <span className="ol-patch__sign" aria-label={line.kind === 'added' ? 'put in' : line.kind === 'removed' ? 'taken out' : undefined}>
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}
            </span>
            <code className="ol-patch__text">{line.text || ' '}</code>
          </div>
        ),
      )}
    </div>
  );
}
