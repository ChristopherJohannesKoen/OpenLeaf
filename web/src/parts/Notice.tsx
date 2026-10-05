// Something the app has to say that is not about a line of source: a request that failed, a file that
// changed elsewhere. It is set in place as a strip, with at most two answers. It never floats and never times out.
import type { ReactNode } from 'react';
import { Button, Mark, type Tone } from '../ds';

export interface NoticeData {
  tone: Extract<Tone, 'broken' | 'asks' | 'note' | 'settled'>;
  text: ReactNode;
  detail?: ReactNode;
  actions?: { label: string; run: () => void; variant?: 'quiet' | 'ink' | 'danger' }[];
}

export function Notice({ notice, onDismiss }: { notice: NoticeData; onDismiss?: () => void }) {
  return (
    <div className="ol-confirm ol-notice" role={notice.tone === 'broken' ? 'alert' : 'status'}>
      <div className="ol-confirm__words">
        <p className="ol-confirm__question"><Mark tone={notice.tone} /> {notice.text}</p>
        {notice.detail && <p className="ol-confirm__detail">{notice.detail}</p>}
      </div>
      <div className="ol-confirm__actions">
        {notice.actions?.map((a) => <Button key={a.label} variant={a.variant} onClick={a.run}>{a.label}</Button>)}
        {onDismiss && <Button variant="bare" onClick={onDismiss}>Dismiss</Button>}
      </div>
    </div>
  );
}

/** What to say about a failed request. */
export function failure(err: unknown, doing: string): NoticeData {
  const message = err instanceof Error ? err.message : String(err);
  return { tone: 'broken', text: `Could not ${doing}.`, detail: message };
}
