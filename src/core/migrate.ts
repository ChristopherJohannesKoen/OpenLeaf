import type { Db } from './db.js';
import type { OpenLeafModule } from './modules.js';

const LOCK_KEY = 7_302_411; // arbitrary, just needs to be stable

/**
 * Apply every pending migration of every enabled module, in module order.
 * Guarded by a Postgres advisory lock so two instances starting together
 * cannot race.
 */
export async function runMigrations(
  db: Db,
  modules: OpenLeafModule[],
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const applied: string[] = [];
  const client = await db.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS openleaf_migrations (
        module      text NOT NULL,
        id          text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (module, id)
      )`);
    const done = await client.query('SELECT module, id FROM openleaf_migrations');
    const seen = new Set(done.rows.map((r: { module: string; id: string }) => `${r.module}/${r.id}`));

    for (const mod of modules) {
      for (const migration of mod.migrations ?? []) {
        const key = `${mod.name}/${migration.id}`;
        if (seen.has(key)) continue;
        try {
          await client.query('BEGIN');
          await client.query(migration.sql);
          await client.query('INSERT INTO openleaf_migrations (module, id) VALUES ($1, $2)', [
            mod.name,
            migration.id,
          ]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw new Error(`Migration ${key} failed: ${(err as Error).message}`);
        }
        applied.push(key);
        log(`applied migration ${key}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}
