import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { OpenLeafModule } from '../../core/modules.js';
import { badRequest } from '../../core/errors.js';
import { currentUser, secured } from '../../core/http.js';
import { deepDefaults, jsonSize, mergePatch } from '../../core/util.js';

const TAG = 'Settings';
const MAX_SETTINGS_BYTES = 256 * 1024;

/**
 * Defaults for every user. The stored value is free-form JSON, so a front end
 * (or a plugin) can add its own keys without any change on the server.
 */
export const DEFAULT_SETTINGS = {
  editor: {
    theme: 'light',
    fontSize: 14,
    fontFamily: 'monospace',
    keybindings: 'default', // 'default' | 'vim' | 'emacs'
    lineWrapping: true,
    lineNumbers: true,
    autoCloseBrackets: true,
    autoComplete: true,
    spellcheckLanguage: 'en-GB',
  },
  compile: {
    autoCompile: false,
    autoCompileDelayMs: 2000,
    stopOnFirstError: false,
  },
  pdf: {
    viewer: 'built-in',
    zoom: 'page-width',
    syncOnDoubleClick: true,
  },
  layout: {
    view: 'split', // 'split' | 'editor' | 'pdf'
    fileTreeWidth: 240,
    showFileTree: true,
  },
  /** Reusable text snippets: [{ name, trigger, body }] */
  snippets: [] as { name: string; trigger: string; body: string }[],
};

export const settingsModule: OpenLeafModule = {
  name: 'settings',
  description: 'Per-user preferences (editor, compile, layout, snippets) stored as free-form JSON.',
  dependsOn: ['auth'],
  migrations: [
    {
      id: '001_init',
      sql: `
        CREATE TABLE user_settings (
          user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          settings    jsonb NOT NULL DEFAULT '{}',
          updated_at  timestamptz NOT NULL DEFAULT now()
        );
      `,
    },
  ],

  register(root, { db }) {
    const app = root.withTypeProvider<TypeBoxTypeProvider>();
    const auth = { onRequest: [root.authenticate] };

    async function load(userId: string): Promise<Record<string, unknown>> {
      const res = await db.query<{ settings: Record<string, unknown> }>(
        'SELECT settings FROM user_settings WHERE user_id = $1',
        [userId],
      );
      return res.rows[0]?.settings ?? {};
    }

    async function save(userId: string, settings: unknown): Promise<void> {
      if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
        throw badRequest('Settings must be a JSON object.', 'invalid_settings');
      }
      if (jsonSize(settings) > MAX_SETTINGS_BYTES) {
        throw badRequest('Settings are limited to 256 KB.', 'settings_too_large');
      }
      await db.query(
        `INSERT INTO user_settings (user_id, settings) VALUES ($1, $2::jsonb)
         ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`,
        [userId, JSON.stringify(settings)],
      );
    }

    const view = (overrides: Record<string, unknown>) => ({
      settings: deepDefaults(DEFAULT_SETTINGS, overrides),
      overrides,
      defaults: DEFAULT_SETTINGS,
    });

    app.get(
      '/api/settings',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Your preferences (defaults merged with what you changed)',
          security: secured,
        },
      },
      async (req) => view(await load(currentUser(req).id)),
    );

    app.patch(
      '/api/settings',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Change some preferences',
          description:
            'JSON Merge Patch: send only what changes, e.g. `{"editor": {"theme": "dark"}}`. Send `null` for a key to go back to its default.',
          security: secured,
          body: Type.Record(Type.String(), Type.Unknown()),
        },
      },
      async (req) => {
        const user = currentUser(req);
        const next = mergePatch(await load(user.id), req.body) as Record<string, unknown>;
        await save(user.id, next);
        return view(next);
      },
    );

    app.put(
      '/api/settings',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Replace all of your preference overrides',
          security: secured,
          body: Type.Record(Type.String(), Type.Unknown()),
        },
      },
      async (req) => {
        const user = currentUser(req);
        await save(user.id, req.body);
        return view(req.body);
      },
    );

    app.delete(
      '/api/settings',
      { ...auth, schema: { tags: [TAG], summary: 'Reset all preferences to the defaults', security: secured } },
      async (req) => {
        await db.query('DELETE FROM user_settings WHERE user_id = $1', [currentUser(req).id]);
        return view({});
      },
    );
  },
};
