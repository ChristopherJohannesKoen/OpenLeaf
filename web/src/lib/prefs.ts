// The app's own preferences. They are kept with the account (under `openleaf` in the service's
// free-form settings) and mirrored in this browser so the right theme is there before the first answer.
import type { Settings } from '../api/types';

export type ThemeChoice = 'auto' | 'light' | 'dark';
export type PaneKey = 'proof' | 'apparatus' | 'outline' | 'files' | 'history' | 'margin';

export interface Prefs {
  theme: ThemeChoice;
  panes: Record<PaneKey, boolean>;
  /** Compile a moment after every save. */
  autoCompile: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'auto',
  // Outline, Files and History start put away: with them out, a 1440px window has no room for the scholia margin.
  panes: { proof: true, apparatus: true, outline: false, files: false, history: false, margin: true },
  autoCompile: false,
};

const KEY = 'openleaf.prefs';

function clean(value: unknown): Prefs {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<Prefs> & { panes?: Partial<Prefs['panes']> };
  const theme: ThemeChoice = v.theme === 'light' || v.theme === 'dark' || v.theme === 'auto' ? v.theme : DEFAULT_PREFS.theme;
  const panes = { ...DEFAULT_PREFS.panes };
  for (const key of Object.keys(panes) as PaneKey[]) if (typeof v.panes?.[key] === 'boolean') panes[key] = v.panes[key]!;
  return { theme, panes, autoCompile: typeof v.autoCompile === 'boolean' ? v.autoCompile : DEFAULT_PREFS.autoCompile };
}

export function loadLocalPrefs(): Prefs {
  try {
    return clean(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveLocalPrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private windows may refuse storage; the preference then lasts for this visit only.
  }
}

export function prefsFromSettings(settings: Settings, fallback: Prefs): Prefs {
  return settings.openleaf === undefined ? fallback : clean(settings.openleaf);
}

/** Sets the theme on the document. `auto` follows the system and keeps following it. */
export function applyTheme(choice: ThemeChoice): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const set = () => {
    const theme = choice === 'auto' ? (media.matches ? 'dark' : 'light') : choice;
    document.documentElement.setAttribute('data-theme', theme);
  };
  set();
  if (choice !== 'auto') return () => {};
  media.addEventListener('change', set);
  return () => media.removeEventListener('change', set);
}
