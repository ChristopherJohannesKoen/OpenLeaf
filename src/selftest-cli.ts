/**
 * Compile the built-in test document with every installed engine, inside whatever isolation
 * this machine offers, and say what happened. Used while the Docker image is built, and
 * handy on any new host:
 *
 *   node dist/selftest-cli.js
 *
 * Exits 1 when an engine cannot produce a PDF at all. When an engine only compiles with a
 * layer of isolation left out, that is printed loudly but is not a failure: the service
 * does the same at start-up and carries on with what works.
 */
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import type { Db } from './core/db.js';
import { EventBus } from './core/events.js';
import { engineStatuses } from './modules/compile/engines.js';
import { CompileService } from './modules/compile/service.js';

async function main() {
  const config = loadConfig({
    COMPILE_DIR: path.join(os.tmpdir(), 'openleaf-selftest'),
    ...process.env,
    // Nothing here touches the database; the setting only has to be present.
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused@localhost/unused',
  });
  const log = {
    info: (o: object, msg: string) => console.log(`  ${msg}`, JSON.stringify(o)),
    error: (o: object, msg: string) => console.log(`  !! ${msg}`, JSON.stringify(o)),
  };
  const compiler = new CompileService(null as unknown as Db, config, new EventBus(), log);
  await compiler.prepareIsolation();
  const before = compiler.describeIsolation();
  console.log(`== self-test: isolation offered here: ${before}`);

  const engines = (await engineStatuses(true))
    .filter((e) => e.available && (!config.compile.engines || config.compile.engines.includes(e.id)))
    .map((e) => e.id);
  const results = await compiler.runSelfTest(engines);
  for (const r of results) {
    console.log(`== self-test: ${r.engine}: ${r.ok ? 'ok' : 'FAILED'} in ${r.durationMs} ms${r.ok ? '' : ` (${r.message})`}`);
  }

  const after = compiler.describeIsolation();
  if (after !== before) {
    console.log(`== self-test: NOTE: TeX did not compile inside all of it; what works here: ${after}`);
  }
  if (!results.length || results.some((r) => !r.ok)) process.exit(1);
}

main().catch((err) => {
  console.error('self-test could not run:', err);
  process.exit(1);
});
