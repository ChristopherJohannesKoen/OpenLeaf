import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Config } from './config.js';
import { createDb, waitForDb, type Db } from './core/db.js';
import { HttpError } from './core/errors.js';
import { EventBus } from './core/events.js';
import { runMigrations } from './core/migrate.js';
import { resolveModules, type ModuleContext, type OpenLeafModule } from './core/modules.js';
import { ALL_MODULES } from './modules/index.js';
import { VERSION } from './version.js';

export interface OpenLeafApp {
  app: FastifyInstance;
  db: Db;
  events: EventBus;
  modules: OpenLeafModule[];
  close(): Promise<void>;
}

export interface BuildOptions {
  logger?: boolean | Record<string, unknown>;
  /** Override the module list (defaults to every built-in module). */
  modules?: OpenLeafModule[];
}

export async function buildApp(config: Config, options: BuildOptions = {}): Promise<OpenLeafApp> {
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    trustProxy: true, // Render terminates TLS in front of us
    bodyLimit: Math.max(4 * 1024 * 1024, config.maxTextFileBytes * 2),
    routerOptions: { ignoreTrailingSlash: true },
  });

  const db = createDb(config);
  const events = new EventBus((event, err) => app.log.error({ err, event }, 'event handler failed'));
  const modules = resolveModules(options.modules ?? ALL_MODULES, config);
  const ctx: ModuleContext = {
    config,
    db,
    events,
    enabled: new Set(modules.map((m) => m.name)),
    modules,
    info: new Map(),
  };

  // ---- errors: everything leaves as { error: { code, message } } ----
  app.setErrorHandler((err: FastifyError & { details?: unknown }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
      });
    }
    if (err.validation) {
      return reply.code(400).send({
        error: { code: 'validation_error', message: err.message, details: err.validation },
      });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      return reply.code(status).send({
        error: { code: 'internal_error', message: 'Something went wrong on the server.' },
      });
    }
    const code =
      status === 429 ? 'rate_limited' : status === 413 ? 'too_large' : (err.code ?? 'request_error').toString().toLowerCase();
    return reply.code(status).send({ error: { code, message: err.message } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: { code: 'not_found', message: `No route for ${req.method} ${req.url.split('?')[0]}.` },
    });
  });

  // ---- cross-cutting plugins ----
  await app.register(cors, {
    origin: config.corsOrigins === '*' ? true : config.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'If-None-Match'],
    exposedHeaders: ['Content-Disposition', 'ETag'],
    maxAge: 600,
  });
  await app.register(helmet, {
    // This is a JSON API (auth is a bearer token, never a cookie), so the page-oriented
    // protections are relaxed to let a separately hosted front end embed PDFs and images.
    contentSecurityPolicy: false,
    frameguard: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(rateLimit, {
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/healthz',
  });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 200, fields: 20, fieldSize: 64 * 1024 },
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'OpenLeaf API',
        version: VERSION,
        description:
          'Back end of OpenLeaf, a modular self-hosted LaTeX writing service.\n\n' +
          'Sign in with `POST /api/auth/login`, then press **Authorize** and paste the token.',
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', persistAuthorization: true, tryItOutEnabled: true },
  });

  // ---- database, then modules ----
  await waitForDb(db);
  await runMigrations(db, modules, (msg) => app.log.info(msg));
  for (const mod of modules) {
    await mod.register(app, ctx);
  }
  await app.ready();
  for (const mod of modules) {
    await mod.onReady?.(app, ctx);
  }
  app.log.info({ modules: modules.map((m) => m.name), version: VERSION }, 'OpenLeaf is ready');

  return {
    app,
    db,
    events,
    modules,
    async close() {
      await app.close();
      await events.settle();
      await db.close();
    },
  };
}
