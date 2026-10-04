/** Apply database migrations without starting the server: `npm run migrate`. */
import { loadConfig } from './config.js';
import { createDb, waitForDb } from './core/db.js';
import { runMigrations } from './core/migrate.js';
import { resolveModules } from './core/modules.js';
import { ALL_MODULES } from './modules/index.js';

const config = loadConfig();
const db = createDb(config);
try {
  await waitForDb(db);
  const applied = await runMigrations(db, resolveModules(ALL_MODULES, config), (msg) => console.log(msg));
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
} finally {
  await db.close();
}
