import type { OpenLeafModule } from '../../core/modules.js';
import { VERSION } from '../../version.js';

const TAG = 'System';
const startedAt = Date.now();

export const systemModule: OpenLeafModule = {
  name: 'system',
  description: 'Health check and instance information.',
  core: true,
  dependsOn: ['auth'],

  register(app, { db, config, modules, info }) {
    app.get('/', { schema: { hide: true } }, async () => ({
      name: 'OpenLeaf',
      version: VERSION,
      docs: '/docs',
      openapi: '/docs/json',
      info: '/api/system/info',
      health: '/healthz',
    }));

    // Used by Render (and anything else) to decide whether the instance is healthy.
    app.get(
      '/healthz',
      { schema: { tags: [TAG], summary: 'Health check' }, logLevel: 'warn' },
      async (_req, reply) => {
        try {
          await db.query('SELECT 1');
          return { status: 'ok', version: VERSION, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) };
        } catch (err) {
          reply.code(503);
          return { status: 'unavailable', version: VERSION, error: `database: ${(err as Error).message}` };
        }
      },
    );

    app.get(
      '/api/system/info',
      {
        schema: {
          tags: [TAG],
          summary: 'What this instance is running: version, modules, engines, limits',
        },
      },
      async () => {
        const details: Record<string, unknown> = {};
        for (const [name, provider] of info) {
          try {
            details[name] = await provider();
          } catch (err) {
            details[name] = { error: (err as Error).message };
          }
        }
        const users = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
        return {
          name: 'OpenLeaf',
          version: VERSION,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          modules: modules.map((m) => ({ name: m.name, description: m.description, core: Boolean(m.core) })),
          registration: {
            mode: config.registration,
            hasOwner: users.rows[0]!.n > 0,
          },
          limits: {
            maxUploadBytes: config.maxUploadBytes,
            maxProjectBytes: config.maxProjectBytes,
            maxTextFileBytes: config.maxTextFileBytes,
          },
          ...details,
        };
      },
    );
  },
};
