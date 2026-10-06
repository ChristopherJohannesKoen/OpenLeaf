import type { OpenLeafModule } from '../../core/modules.js';
import { forbidden } from '../../core/errors.js';
import { currentUser, secured } from '../../core/http.js';
import { VERSION } from '../../version.js';

const TAG = 'System';
const startedAt = Date.now();

export const systemModule: OpenLeafModule = {
  name: 'system',
  description: 'Health check and instance information.',
  core: true,
  dependsOn: ['auth'],

  register(app, { db, config, modules, info }) {
    const auth = { onRequest: [app.authenticate] };

    app.get('/', { schema: { hide: true } }, async () => ({
      name: 'OpenLeaf',
      docs: '/docs',
      openapi: '/docs/json',
      health: '/healthz',
    }));

    // Used by Render (and anything else) to decide whether the instance is healthy.
    app.get(
      '/healthz',
      { schema: { tags: [TAG], summary: 'Health check' }, logLevel: 'warn' },
      async (_req, reply) => {
        // Public, so it says only whether the service is up; the reason for a failure goes to the log.
        try {
          await db.query('SELECT 1');
          return { status: 'ok' };
        } catch (err) {
          app.log.error({ err }, 'health check failed');
          reply.code(503);
          return { status: 'unavailable' };
        }
      },
    );

    app.get(
      '/api/system/info',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'What this instance is running: version, modules, engines, limits',
          security: secured,
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

    app.get(
      '/api/system/request',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Owner only: how this request reached the service',
          description:
            'For setting `TRUST_PROXY` on a new host: the address the service takes the caller to have, ' +
            'and the forwarding headers it was sent. `address` should be your own public address, and ' +
            'should stay the same when you add an `X-Forwarded-For` header of your own to the request.',
          security: secured,
        },
      },
      async (req) => {
        if (currentUser(req).role !== 'owner') throw forbidden('Only the owner can see this.');
        const header = (name: string) => {
          const v = req.headers[name];
          return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v;
        };
        return {
          address: req.ip,
          chain: req.ips ?? [req.ip],
          trustProxy: config.trustProxy,
          forwardedFor: header('x-forwarded-for'),
          cfConnectingIp: header('cf-connecting-ip'),
          trueClientIp: header('true-client-ip'),
          forwardedProto: header('x-forwarded-proto'),
        };
      },
    );
  },
};
