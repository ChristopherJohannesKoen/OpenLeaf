import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main() {
  // The guard library (native/guard.c) did its work when this process started; the programs
  // the service starts have no use for it.
  if (process.env.LD_PRELOAD?.includes('openleaf-guard')) delete process.env.LD_PRELOAD;

  const config = loadConfig();
  const openleaf = await buildApp(config);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    openleaf.app.log.info({ signal }, 'shutting down');
    try {
      await openleaf.close();
      process.exit(0);
    } catch (err) {
      openleaf.app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await openleaf.app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error('OpenLeaf failed to start:', err);
  process.exit(1);
});
