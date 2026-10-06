import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { buildApp, type OpenLeafApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/openleaf_test';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  raw: Buffer;
  headers: Record<string, string | string[] | number | undefined>;
}

export interface Api {
  get<T = any>(url: string, token?: string | null, headers?: Record<string, string>): Promise<ApiResponse<T>>;
  post<T = any>(url: string, body?: unknown, token?: string | null): Promise<ApiResponse<T>>;
  put<T = any>(url: string, body?: unknown, token?: string | null): Promise<ApiResponse<T>>;
  patch<T = any>(url: string, body?: unknown, token?: string | null): Promise<ApiResponse<T>>;
  del<T = any>(url: string, token?: string | null): Promise<ApiResponse<T>>;
  upload<T = any>(
    url: string,
    parts: { fields?: Record<string, string>; files: { name: string; data: Buffer | string }[] },
    token?: string | null,
  ): Promise<ApiResponse<T>>;
}

export interface TestApp extends OpenLeafApp {
  compileDir: string;
  api: Api;
  /** Tear everything down, including the temporary compile directory. */
  destroy(): Promise<void>;
}

async function resetDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
}

export async function createTestApp(env: Record<string, string> = {}, reset = true): Promise<TestApp> {
  if (reset) await resetDatabase();
  const compileDir = env.COMPILE_DIR ?? (await mkdtemp(path.join(os.tmpdir(), 'openleaf-test-')));
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    NODE_ENV: 'test',
    REGISTRATION: 'open',
    STARTUP_SELFTEST: 'off',
    AUTH_RATE_LIMIT_PER_MINUTE: '100000',
    RATE_LIMIT_PER_MINUTE: '100000',
    COMPILE_TIMEOUT_MS: '240000',
    // Lets the whole suite be run as on a host without namespaces:
    //   COMPILE_ISOLATION_SKIP=namespaces npm test
    ...(process.env.COMPILE_ISOLATION_SKIP ? { COMPILE_ISOLATION_SKIP: process.env.COMPILE_ISOLATION_SKIP } : {}),
    ...env,
    COMPILE_DIR: compileDir,
  });
  const openleaf = await buildApp(config, { logger: false });
  const { app } = openleaf;

  const parse = (res: { headers: Record<string, unknown>; rawPayload: Buffer; payload: string; statusCode: number }) => {
    const type = String(res.headers['content-type'] ?? '');
    return {
      status: res.statusCode,
      body: type.includes('application/json') && res.rawPayload.length ? JSON.parse(res.payload) : null,
      raw: res.rawPayload,
      headers: res.headers as ApiResponse['headers'],
    };
  };

  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body: unknown,
    token: string | null | undefined,
    extra: Record<string, string> = {},
  ): Promise<ApiResponse> => {
    const headers: Record<string, string> = { ...extra };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await app.inject({
      method,
      url,
      headers,
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return parse(res);
  };

  const api: Api = {
    get: (url, token, headers) => call('GET', url, undefined, token, headers),
    post: (url, body, token) => call('POST', url, body, token),
    put: (url, body, token) => call('PUT', url, body, token),
    patch: (url, body, token) => call('PATCH', url, body, token),
    del: (url, token) => call('DELETE', url, undefined, token),
    async upload(url, parts, token) {
      const form = new FormData();
      for (const [k, v] of Object.entries(parts.fields ?? {})) form.append(k, v);
      for (const f of parts.files) {
        const blob = new Blob([typeof f.data === 'string' ? f.data : new Uint8Array(f.data)]);
        form.append('file', blob, f.name);
      }
      const encoded = new Response(form);
      const payload = Buffer.from(await encoded.arrayBuffer());
      const headers: Record<string, string> = { 'content-type': encoded.headers.get('content-type')! };
      if (token) headers.authorization = `Bearer ${token}`;
      return parse(await app.inject({ method: 'POST', url, headers, payload }));
    },
  };

  return {
    ...openleaf,
    compileDir,
    api,
    async destroy() {
      await openleaf.close();
      await rm(compileDir, { recursive: true, force: true });
    },
  };
}

let counter = 0;

/** Register a fresh user and return their session token. */
export async function signUp(t: TestApp, name = 'user'): Promise<{ token: string; id: string; email: string }> {
  counter += 1;
  const email = `${name}${counter}@example.com`;
  const res = await t.api.post('/api/auth/register', { email, password: 'correct horse battery', displayName: name });
  if (res.status !== 201) throw new Error(`sign-up failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, id: res.body.user.id, email };
}

export async function newProject(t: TestApp, token: string, name = 'Test project'): Promise<string> {
  const res = await t.api.post('/api/projects', { name }, token);
  if (res.status !== 201) throw new Error(`project creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.project.id;
}

/** A 1x1 PNG. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
