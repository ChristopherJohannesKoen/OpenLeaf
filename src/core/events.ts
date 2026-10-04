/**
 * A tiny typed event bus. Modules announce things that happened
 * (`project.compiled`, `project.deleted`, …) and other modules react without
 * the two knowing about each other. Handler failures are logged, never thrown
 * back at the emitter.
 */
export interface OpenLeafEvents {
  'user.registered': { userId: string; email: string; role: string };
  'project.created': { projectId: string; userId: string };
  'project.deleted': { projectId: string; userId: string };
  'project.files-changed': { projectId: string; userId: string };
  'project.compiled': {
    projectId: string;
    userId: string;
    compileId: string;
    status: string;
    hasPdf: boolean;
  };
}

type Handler<K extends keyof OpenLeafEvents> = (payload: OpenLeafEvents[K]) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, Handler<any>[]>();
  private pending = new Set<Promise<void>>();

  constructor(private onError: (event: string, err: unknown) => void = () => {}) {}

  on<K extends keyof OpenLeafEvents>(event: K, handler: Handler<K>): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  /** Fire handlers without waiting for them. */
  emit<K extends keyof OpenLeafEvents>(event: K, payload: OpenLeafEvents[K]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      const p = (async () => {
        try {
          await handler(payload);
        } catch (err) {
          this.onError(event, err);
        }
      })();
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    }
  }

  /** Resolve once every in-flight handler has finished (used by tests and shutdown). */
  async settle(): Promise<void> {
    while (this.pending.size) {
      await Promise.all([...this.pending]);
    }
  }
}
