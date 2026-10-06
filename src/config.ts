import os from 'node:os';
import path from 'node:path';

export type RegistrationMode = 'first-user' | 'invite' | 'open' | 'closed';

/** Who checks that a person is who they say: OpenLeaf itself (passwords), or Firebase Authentication. */
export type AuthProvider = 'local' | 'firebase';

export interface FirebaseConfig {
  projectId: string;
  /** The Firebase web API key. It identifies the project to Google and is not a secret. */
  apiKey: string;
  authDomain: string;
  /** Which Firebase sign-in methods are accepted, e.g. `google.com`. */
  signInProviders: string[];
  /** Where the keys that sign Firebase ID tokens are published. */
  jwksUrl: string;
}

/** Saving projects to GitHub. Present only when both GITHUB_CLIENT_ID and SECRETS_KEY are set. */
export interface GithubConfig {
  /** Client id of the GitHub OAuth app (with device flow switched on) that people link through. */
  clientId: string;
  /** Scope asked for when linking: `repo` reaches private repositories too, `public_repo` only public ones. */
  scope: string;
  apiUrl: string;
  webUrl: string;
}

export interface Config {
  env: string;
  host: string;
  port: number;
  logLevel: string;
  publicUrl: string | null;
  /**
   * Which proxies in front of the service to believe about the caller's address (rate limits
   * and logs depend on it): a list of addresses, ranges or the names `loopback`, `linklocal`,
   * `uniquelocal`; a number of hops; `true` for all of them (never safe when callers can add
   * their own forwarding header); or `false` for none.
   */
  trustProxy: boolean | number | string;

  databaseUrl: string;
  databaseSsl: boolean;
  databasePoolSize: number;

  registration: RegistrationMode;
  inviteCode: string | null;
  sessionTtlDays: number;
  /** A session ends this long after it was made, however much it is used. 0 = no such limit. */
  sessionMaxDays: number;
  authProvider: AuthProvider;
  /** Set when `authProvider` is `firebase`. */
  firebase: FirebaseConfig | null;

  corsOrigins: string[] | '*';
  rateLimitPerMinute: number;
  authRateLimitPerMinute: number;

  enabledModules: string[] | null;
  disabledModules: string[];

  maxUploadBytes: number;
  maxProjectBytes: number;
  maxTextFileBytes: number;

  /** 32 random bytes used to encrypt third-party tokens (GitHub) before they are stored. */
  secretsKey: Buffer | null;
  github: GithubConfig | null;
  /** Share links made without an expiry get this many days. 0 = they never expire. */
  shareLinkDefaultDays: number;

  compile: {
    dir: string;
    timeoutMs: number;
    concurrency: number;
    keep: number;
    defaultEngine: string;
    /** Engines people may use; null = every installed one. */
    engines: string[] | null;
    /** Ceiling on a compile's memory (address space), in MB. 0 = none. */
    memoryMb: number;
    /** Largest single file a compile may write, in MB. 0 = no limit. */
    maxFileMb: number;
    /**
     * Run each compile in its own process, network and mount view, apart from the service:
     * `auto` when the host allows it, `off` never, `required` refuse to compile without it.
     */
    isolation: 'auto' | 'off' | 'required';
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

function proxyTrust(v: string): boolean | number | string {
  const x = v.toLowerCase();
  if (['true', 'all', 'yes', 'on'].includes(x)) return true;
  if (['false', 'none', 'no', 'off', '0'].includes(x)) return false;
  if (/^\d+$/.test(x)) {
    const n = Number(x);
    if (n > 0 && n < 20) return n;
    throw new Error(`Invalid TRUST_PROXY "${v}" (a number of hops must be between 1 and 19).`);
  }
  return x; // addresses, ranges or preset names; checked when the server starts
}

function isolationMode(v: string): 'auto' | 'off' | 'required' {
  const x = v.toLowerCase();
  if (x === 'auto' || x === 'off' || x === 'required') return x;
  throw new Error(`Invalid COMPILE_ISOLATION "${v}" (use auto, off or required).`);
}

/** SECRETS_KEY: 32 bytes as base64 or hex (make one with `openssl rand -base64 32`). */
function secretsKey(v: string | undefined): Buffer | null {
  if (!v) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (key.byteLength !== 32) {
    throw new Error('SECRETS_KEY must be 32 random bytes, as base64 or hex (openssl rand -base64 32).');
  }
  return key;
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

  const authProviderRaw = str(env, 'AUTH_PROVIDER', 'local')!.toLowerCase();
  if (authProviderRaw !== 'local' && authProviderRaw !== 'firebase') {
    throw new Error(`Invalid AUTH_PROVIDER "${authProviderRaw}" (use local or firebase).`);
  }
  const authProvider = authProviderRaw as AuthProvider;
  let firebase: FirebaseConfig | null = null;
  if (authProvider === 'firebase') {
    const projectId = str(env, 'FIREBASE_PROJECT_ID');
    const apiKey = str(env, 'FIREBASE_API_KEY');
    if (!projectId || !apiKey) {
      throw new Error('AUTH_PROVIDER=firebase requires FIREBASE_PROJECT_ID and FIREBASE_API_KEY to be set.');
    }
    const providers = list(env, 'FIREBASE_SIGN_IN_PROVIDERS');
    firebase = {
      projectId,
      apiKey,
      authDomain: str(env, 'FIREBASE_AUTH_DOMAIN', `${projectId}.firebaseapp.com`)!,
      signInProviders: providers.length ? providers : ['google.com'],
      // Overridden only by the tests and by the Firebase emulator.
      jwksUrl: str(
        env,
        'FIREBASE_JWKS_URL',
        'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
      )!,
    };
  }

  const key = secretsKey(str(env, 'SECRETS_KEY'));
  const githubClientId = str(env, 'GITHUB_CLIENT_ID');
  if (githubClientId && !key) {
    throw new Error('GITHUB_CLIENT_ID needs SECRETS_KEY as well: GitHub tokens are only ever stored encrypted.');
  }
  const githubScope = str(env, 'GITHUB_SCOPE', 'repo')!;
  if (!['repo', 'public_repo'].includes(githubScope)) {
    throw new Error(`Invalid GITHUB_SCOPE "${githubScope}" (use repo or public_repo).`);
  }
  const engines = list(env, 'COMPILE_ENGINES');

  const cors = str(env, 'CORS_ORIGINS', '*')!;
  const enabled = list(env, 'OPENLEAF_MODULES');

  return {
    env: str(env, 'NODE_ENV', 'development')!,
    host: str(env, 'HOST', '0.0.0.0')!,
    port: int(env, 'PORT', 3000),
    logLevel: str(env, 'LOG_LEVEL', 'info')!,
    publicUrl: str(env, 'PUBLIC_URL') ?? str(env, 'RENDER_EXTERNAL_URL') ?? null,
    // By default believe only proxies on a private network (a platform's own load balancer):
    // the caller is then the first public address, which a caller cannot forge.
    trustProxy: proxyTrust(str(env, 'TRUST_PROXY', 'loopback, linklocal, uniquelocal')!),

    databaseUrl,
    databaseSsl: detectSsl(databaseUrl, env),
    databasePoolSize: int(env, 'DATABASE_POOL_SIZE', 5),

    registration,
    inviteCode,
    sessionTtlDays: int(env, 'SESSION_TTL_DAYS', 30),
    sessionMaxDays: int(env, 'SESSION_MAX_DAYS', 90),
    authProvider,
    firebase,

    corsOrigins: cors === '*' ? '*' : list(env, 'CORS_ORIGINS'),
    rateLimitPerMinute: int(env, 'RATE_LIMIT_PER_MINUTE', 600),
    authRateLimitPerMinute: int(env, 'AUTH_RATE_LIMIT_PER_MINUTE', 20),

    enabledModules: enabled.length ? enabled : null,
    disabledModules: list(env, 'OPENLEAF_DISABLED_MODULES'),

    maxUploadBytes: int(env, 'MAX_UPLOAD_BYTES', 25 * 1024 * 1024),
    maxProjectBytes: int(env, 'MAX_PROJECT_BYTES', 150 * 1024 * 1024),
    maxTextFileBytes: int(env, 'MAX_TEXT_FILE_BYTES', 2 * 1024 * 1024),

    secretsKey: key,
    github:
      githubClientId && key
        ? {
            clientId: githubClientId,
            scope: githubScope,
            apiUrl: str(env, 'GITHUB_API_URL', 'https://api.github.com')!.replace(/\/+$/, ''),
            webUrl: str(env, 'GITHUB_URL', 'https://github.com')!.replace(/\/+$/, ''),
          }
        : null,
    shareLinkDefaultDays: int(env, 'SHARE_LINK_DEFAULT_DAYS', 30),

    compile: {
      dir: str(env, 'COMPILE_DIR', path.join(os.tmpdir(), 'openleaf-compiles'))!,
      timeoutMs: int(env, 'COMPILE_TIMEOUT_MS', 180_000),
      concurrency: Math.max(1, int(env, 'COMPILE_CONCURRENCY', 1)),
      keep: Math.max(1, int(env, 'COMPILE_KEEP', 3)),
      defaultEngine: str(env, 'DEFAULT_ENGINE', 'pdflatex')!,
      engines: engines.length ? engines : null,
      memoryMb: int(env, 'COMPILE_MEMORY_MB', 4096),
      maxFileMb: int(env, 'COMPILE_MAX_FILE_MB', 256),
      isolation: isolationMode(str(env, 'COMPILE_ISOLATION', 'auto')!),
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
