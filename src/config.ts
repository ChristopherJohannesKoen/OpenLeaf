import os from 'node:os';
import path from 'node:path';

export type RegistrationMode = 'first-user' | 'invite' | 'open' | 'closed';

export interface Config {
  env: string;
  host: string;
  port: number;
  logLevel: string;
  publicUrl: string | null;

  databaseUrl: string;
  databaseSsl: boolean;
  databasePoolSize: number;

  registration: RegistrationMode;
  inviteCode: string | null;
  sessionTtlDays: number;

  corsOrigins: string[] | '*';
  rateLimitPerMinute: number;
  authRateLimitPerMinute: number;

  enabledModules: string[] | null;
  disabledModules: string[];

  maxUploadBytes: number;
  maxProjectBytes: number;
  maxTextFileBytes: number;

  compile: {
    dir: string;
    timeoutMs: number;
    concurrency: number;
    keep: number;
    defaultEngine: string;
    allowLatexmkrc: boolean;
    /**
     * What documents may run on the server: `restricted` (TeX Live's short safe list, e.g. EPS
     * conversion), `off` (nothing) or `full` (anything — needed by minted; only for trusted users).
     */
    shellEscape: 'off' | 'restricted' | 'full';
    /** `default`: test the default engine at start-up; `all`: every installed engine; `off`: none. */
    startupSelfTest: 'off' | 'default' | 'all';
  };

  history: {
    autoIntervalMinutes: number;
    autoKeep: number;
  };
}

function str(env: NodeJS.ProcessEnv, key: string, fallback?: string): string | undefined {
  const v = env[key];
  if (v === undefined || v.trim() === '') return fallback;
  return v.trim();
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const v = str(env, key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid value for ${key}: expected a non-negative number, got "${v}"`);
  }
  return Math.floor(n);
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const v = str(env, key);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function list(env: NodeJS.ProcessEnv, key: string): string[] {
  const v = str(env, key);
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Decide whether the Postgres connection needs TLS.
 * Render's *internal* hostnames (e.g. `dpg-abc123-a`) have no dots and do not
 * use TLS; external hostnames (`….frankfurt-postgres.render.com`) require it.
 */
function detectSsl(databaseUrl: string, env: NodeJS.ProcessEnv): boolean {
  const explicit = str(env, 'DATABASE_SSL');
  if (explicit && explicit.toLowerCase() !== 'auto') {
    return ['1', 'true', 'yes', 'on', 'require'].includes(explicit.toLowerCase());
  }
  try {
    const u = new URL(databaseUrl);
    const sslmode = u.searchParams.get('sslmode');
    if (sslmode) return sslmode !== 'disable';
    const host = u.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    return host.includes('.');
  } catch {
    return false;
  }
}

function shellEscapeMode(v: string): 'off' | 'restricted' | 'full' {
  const x = v.toLowerCase();
  if (x === 'off' || x === 'restricted' || x === 'full') return x;
  throw new Error(`Invalid COMPILE_SHELL_ESCAPE "${v}" (use off, restricted or full).`);
}

function selfTestMode(v: string): 'off' | 'default' | 'all' {
  const x = v.toLowerCase();
  if (x === 'all') return 'all';
  if (['0', 'false', 'no', 'off'].includes(x)) return 'off';
  return 'default';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = str(env, 'DATABASE_URL');
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (a Postgres connection string).');
  }

  const inviteCode = str(env, 'INVITE_CODE') ?? null;
  const registrationRaw = str(env, 'REGISTRATION', inviteCode ? 'invite' : 'first-user')!;
  if (!['first-user', 'invite', 'open', 'closed'].includes(registrationRaw)) {
    throw new Error(
      `Invalid REGISTRATION "${registrationRaw}" (use first-user, invite, open or closed).`,
    );
  }
  const registration = registrationRaw as RegistrationMode;
  if (registration === 'invite' && !inviteCode) {
    throw new Error('REGISTRATION=invite requires INVITE_CODE to be set.');
  }

  const cors = str(env, 'CORS_ORIGINS', '*')!;
  const enabled = list(env, 'OPENLEAF_MODULES');

  return {
    env: str(env, 'NODE_ENV', 'development')!,
    host: str(env, 'HOST', '0.0.0.0')!,
    port: int(env, 'PORT', 3000),
    logLevel: str(env, 'LOG_LEVEL', 'info')!,
    publicUrl: str(env, 'PUBLIC_URL') ?? str(env, 'RENDER_EXTERNAL_URL') ?? null,

    databaseUrl,
    databaseSsl: detectSsl(databaseUrl, env),
    databasePoolSize: int(env, 'DATABASE_POOL_SIZE', 5),

    registration,
    inviteCode,
    sessionTtlDays: int(env, 'SESSION_TTL_DAYS', 30),

    corsOrigins: cors === '*' ? '*' : list(env, 'CORS_ORIGINS'),
    rateLimitPerMinute: int(env, 'RATE_LIMIT_PER_MINUTE', 600),
    authRateLimitPerMinute: int(env, 'AUTH_RATE_LIMIT_PER_MINUTE', 20),

    enabledModules: enabled.length ? enabled : null,
    disabledModules: list(env, 'OPENLEAF_DISABLED_MODULES'),

    maxUploadBytes: int(env, 'MAX_UPLOAD_BYTES', 25 * 1024 * 1024),
    maxProjectBytes: int(env, 'MAX_PROJECT_BYTES', 150 * 1024 * 1024),
    maxTextFileBytes: int(env, 'MAX_TEXT_FILE_BYTES', 2 * 1024 * 1024),

    compile: {
      dir: str(env, 'COMPILE_DIR', path.join(os.tmpdir(), 'openleaf-compiles'))!,
      timeoutMs: int(env, 'COMPILE_TIMEOUT_MS', 180_000),
      concurrency: Math.max(1, int(env, 'COMPILE_CONCURRENCY', 1)),
      keep: Math.max(1, int(env, 'COMPILE_KEEP', 3)),
      defaultEngine: str(env, 'DEFAULT_ENGINE', 'pdflatex')!,
      allowLatexmkrc: bool(env, 'ALLOW_LATEXMKRC', false),
      shellEscape: shellEscapeMode(str(env, 'COMPILE_SHELL_ESCAPE', 'restricted')!),
      startupSelfTest: selfTestMode(str(env, 'STARTUP_SELFTEST', 'default')!),
    },

    history: {
      autoIntervalMinutes: int(env, 'HISTORY_AUTO_INTERVAL_MINUTES', 10),
      autoKeep: Math.max(1, int(env, 'HISTORY_AUTO_KEEP', 100)),
    },
  };
}
