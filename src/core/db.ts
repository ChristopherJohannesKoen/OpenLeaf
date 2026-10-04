import pg from 'pg';
import type { Config } from '../config.js';

// Return COUNT(*)/bigint columns as JS numbers (safe for our sizes).
pg.types.setTypeParser(20, (v) => Number(v));

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/** Anything that can run SQL: the pool itself or a transaction client. */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /** Run `fn` inside a transaction; commits on success, rolls back on throw. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  pool: pg.Pool;
}

function wrap(runner: { query: (text: string, params?: unknown[]) => Promise<pg.QueryResult> }): Queryable {
  return {
    async query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
      const res = await runner.query(text, params);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    },
  };
}

export function createDb(config: Pick<Config, 'databaseUrl' | 'databaseSsl' | 'databasePoolSize'>): Db {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolSize,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  });
  // An idle client erroring (e.g. the database restarting) must not crash the process.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  const base = wrap(pool);
  return {
    pool,
    query: base.query,
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* connection is already broken */
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** Wait for the database to accept connections (useful on cold starts). */
export async function waitForDb(db: Db, attempts = 20, delayMs = 1500): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Database not reachable: ${(lastErr as Error)?.message ?? 'unknown error'}`);
}
