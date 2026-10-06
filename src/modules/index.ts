import type { OpenLeafModule } from '../core/modules.js';
import { authModule } from './auth/index.js';
import { compileModule } from './compile/index.js';
import { filesModule } from './files/index.js';
import { githubModule } from './github/index.js';
import { historyModule } from './history/index.js';
import { projectsModule } from './projects/index.js';
import { settingsModule } from './settings/index.js';
import { shareModule } from './share/index.js';
import { systemModule } from './system/index.js';
import { templatesModule } from './templates/index.js';

/**
 * Every module OpenLeaf knows about. Add yours to this list.
 * `auth`, `projects` and `system` are core; the rest can be switched off with
 * OPENLEAF_DISABLED_MODULES (comma-separated), or you can list exactly which
 * to run with OPENLEAF_MODULES.
 */
export const ALL_MODULES: OpenLeafModule[] = [
  authModule,
  systemModule,
  projectsModule,
  filesModule,
  compileModule,
  historyModule,
  templatesModule,
  settingsModule,
  shareModule,
  githubModule,
];
