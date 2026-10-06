import { findBinary, run } from './runner.js';

/**
 * What stands between a compile and the service that started it, beyond TeX's own switches.
 *
 * LaTeX is a programming language and a project's files are untrusted input, so a compile is
 * kept apart from the API as far as the host allows:
 *
 *  - `limits`: a ceiling on memory and on the size of any file it writes (prlimit).
 *  - `namespaces`: its own view of processes, network and mounts (unshare). It cannot see the
 *    service's process (or anything under /proc that belongs to it) and it has no network at
 *    all, so it cannot talk to the database or to anything else.
 *  - `noNewPrivileges`: it cannot gain privileges through set-uid programs (setpriv).
 *
 * All three need only an ordinary user. Whether `namespaces` is available depends on the host:
 * many container platforms switch unprivileged namespaces off, which is why it is detected.
 */
export interface Isolation {
  limits: boolean;
  namespaces: boolean;
  noNewPrivileges: boolean;
  /** The unshare arguments that worked on this host (empty when namespaces are off). */
  namespaceArgs: string[];
}

export const NO_ISOLATION: Isolation = { limits: false, namespaces: false, noNewPrivileges: false, namespaceArgs: [] };

const BASE = ['--net', '--pid', '--fork', '--kill-child', '--mount-proc'];
// Keeping the same user id inside is preferred: it holds no privileges once the program starts.
const CANDIDATES = [
  ['--user', '--map-current-user', ...BASE],
  ['--user', '--map-root-user', ...BASE],
];

async function works(cmd: string, args: string[]): Promise<boolean> {
  const res = await run(cmd, args, { cwd: '/', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeoutMs: 8000, maxOutputBytes: 2048 });
  return res.exitCode === 0 && !res.spawnError && !res.timedOut;
}

/** Find out which of the measures this host supports. `mode: 'off'` skips namespaces. */
export async function detectIsolation(mode: 'auto' | 'off' | 'required'): Promise<Isolation> {
  const [prlimit, unshare, setpriv] = await Promise.all([findBinary('prlimit'), findBinary('unshare'), findBinary('setpriv')]);
  const iso: Isolation = { ...NO_ISOLATION };
  iso.limits = Boolean(prlimit) && (await works('prlimit', ['--core=0', '--', 'true']));
  iso.noNewPrivileges = Boolean(setpriv) && (await works('setpriv', ['--no-new-privs', '--', 'true']));
  if (mode !== 'off' && unshare) {
    for (const candidate of CANDIDATES) {
      if (await works('unshare', [...candidate, '--', 'true'])) {
        iso.namespaces = true;
        iso.namespaceArgs = candidate;
        break;
      }
    }
  }
  return iso;
}

/** Wrap a command in whatever isolation is available. */
export function isolate(
  cmd: string,
  args: string[],
  iso: Isolation,
  limits: { memoryMb: number; maxFileMb: number },
): { cmd: string; args: string[] } {
  let line = [cmd, ...args];
  if (iso.noNewPrivileges) line = ['setpriv', '--no-new-privs', '--', ...line];
  if (iso.namespaces) line = ['unshare', ...iso.namespaceArgs, '--', ...line];
  if (iso.limits) {
    const mb = 1024 * 1024;
    line = [
      'prlimit',
      '--core=0',
      ...(limits.memoryMb > 0 ? [`--as=${limits.memoryMb * mb}`] : []),
      ...(limits.maxFileMb > 0 ? [`--fsize=${limits.maxFileMb * mb}`] : []),
      '--',
      ...line,
    ];
  }
  return { cmd: line[0]!, args: line.slice(1) };
}

export function describeIsolation(iso: Isolation): string {
  const parts = [
    iso.namespaces ? 'own process, network and mount view (no network)' : 'shares the service’s process and network view',
    iso.limits ? 'memory and file-size limits' : 'no resource limits',
    iso.noNewPrivileges ? 'no new privileges' : null,
  ].filter(Boolean);
  return parts.join('; ');
}
