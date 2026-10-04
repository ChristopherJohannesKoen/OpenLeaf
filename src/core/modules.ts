import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from './db.js';
import type { EventBus } from './events.js';

export interface Migration {
  /** Unique within the module, applied in array order, e.g. `001_init`. */
  id: string;
  sql: string;
}

export interface ModuleContext {
  config: Config;
  db: Db;
  events: EventBus;
  /** Names of all modules that are enabled in this instance. */
  enabled: ReadonlySet<string>;
  /** The enabled modules, in the order they were loaded. */
  modules: ReadonlyArray<Pick<OpenLeafModule, 'name' | 'description' | 'core'>>;
  /**
   * Modules can publish a block of status information here; it is shown under
   * their name by `GET /api/system/info`.
   */
  info: Map<string, () => unknown | Promise<unknown>>;
}

/**
 * An OpenLeaf module: a self-contained feature with its own tables, routes and
 * event handlers. To add a feature, write one of these and list it in
 * `src/modules/index.ts`. To switch one off, set OPENLEAF_DISABLED_MODULES.
 */
export interface OpenLeafModule {
  name: string;
  description: string;
  /** Modules that must be enabled (and migrated) before this one. */
  dependsOn?: string[];
  /** Core modules cannot be disabled. */
  core?: boolean;
  migrations?: Migration[];
  /** Register routes, hooks and event handlers. */
  register(app: FastifyInstance, ctx: ModuleContext): Promise<void> | void;
  /** Called once after the server is ready (and migrations have run). */
  onReady?(app: FastifyInstance, ctx: ModuleContext): Promise<void> | void;
}

/** Work out which modules are on, in dependency order. */
export function resolveModules(
  all: OpenLeafModule[],
  config: Pick<Config, 'enabledModules' | 'disabledModules'>,
): OpenLeafModule[] {
  const byName = new Map(all.map((m) => [m.name, m]));
  const unknown = [...(config.enabledModules ?? []), ...config.disabledModules].filter(
    (n) => !byName.has(n),
  );
  if (unknown.length) {
    throw new Error(
      `Unknown module(s): ${unknown.join(', ')}. Available: ${[...byName.keys()].join(', ')}`,
    );
  }

  const wanted = new Set<string>();
  for (const m of all) {
    const listed = config.enabledModules ? config.enabledModules.includes(m.name) : true;
    const disabled = config.disabledModules.includes(m.name);
    if (m.core || (listed && !disabled)) wanted.add(m.name);
  }

  const ordered: OpenLeafModule[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string, chain: string[]) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      throw new Error(`Circular module dependency: ${[...chain, name].join(' -> ')}`);
    }
    const mod = byName.get(name)!;
    state.set(name, 'visiting');
    for (const dep of mod.dependsOn ?? []) {
      if (!byName.has(dep)) throw new Error(`Module "${name}" depends on unknown module "${dep}".`);
      if (!wanted.has(dep)) {
        throw new Error(
          `Module "${name}" needs module "${dep}", which is disabled. Enable "${dep}" or disable "${name}".`,
        );
      }
      visit(dep, [...chain, name]);
    }
    state.set(name, 'done');
    ordered.push(mod);
  };
  for (const m of all) if (wanted.has(m.name)) visit(m.name, []);
  return ordered;
}
