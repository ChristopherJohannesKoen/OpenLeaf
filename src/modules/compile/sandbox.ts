import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBinary, run } from './runner.js';

/**
 * What stands between a compile and the service that started it, beyond TeX's own switches.
 *
 * LaTeX is a programming language and a project's files are untrusted input, so a compile is
 * kept apart from the API as far as the host allows. There are two routes to the same end,
 * and whichever the host supports is used (both, where both work):
 *
 *  - `namespaces` (unshare): the compile gets its own view of processes, network and mounts.
 *    It cannot see the service's process and it has no network at all. Many container hosts
 *    switch unprivileged namespaces off.
 *
 *  - the launcher (`openleaf-sandbox`, built from `native/sandbox.c`), which needs nothing
 *    from the host but an ordinary Linux kernel:
 *      `syscalls`: the compile is refused sockets of any kind (so: no network), any look
 *        into another process, and leaving its process group;
 *      `files`: (kernels with Landlock) it sees only the TeX installation, to read and run,
 *        and its own folders, to read and write; nothing else in the file system.
 *
 * And always, where the tools exist:
 *
 *  - `limits`: a ceiling on memory and on the size of any file it writes (prlimit).
 *  - `noNewPrivileges`: it cannot gain privileges through set-uid programs (setpriv).
 *
 * The other half is on the service's side: see `serviceGuarded`.
 */
export interface Isolation {
  limits: boolean;
  namespaces: boolean;
  noNewPrivileges: boolean;
  /** The unshare arguments that worked on this host (empty when namespaces are off). */
  namespaceArgs: string[];
  /** Where the launcher is, when it works on this host. */
  launcher: string | null;
  syscalls: boolean;
  files: boolean;
  /** What a compile may read and run when `files` is on. */
  readPaths: string[];
}

export const NO_ISOLATION: Isolation = {
  limits: false,
  namespaces: false,
  noNewPrivileges: false,
  namespaceArgs: [],
  launcher: null,
  syscalls: false,
  files: false,
  readPaths: [],
};

/** True when a compile cannot open a network connection of any kind. */
export function noNetwork(iso: Isolation): boolean {
  return iso.namespaces || iso.syscalls;
}

const BASE = ['--net', '--pid', '--fork', '--kill-child', '--mount-proc'];
// Keeping the same user id inside is preferred: it holds no privileges once the program starts.
const CANDIDATES = [
  ['--user', '--map-current-user', ...BASE],
  ['--user', '--map-root-user', ...BASE],
];

/**
 * What any TeX installation needs to read: programs and libraries, the few files under /etc
 * that TeX, fontconfig, Perl and Ghostscript consult, and generated formats and font caches.
 * Deliberately not all of /etc, and nothing of /proc beyond two harmless facts about the
 * machine. The TeX trees and the folders of the engines themselves are added by asking
 * kpathsea, so an installation outside /usr is found too.
 */
const READ_ALWAYS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/etc/texmf',
  '/etc/fonts',
  '/etc/ghostscript',
  '/etc/perl',
  '/etc/papersize',
  '/etc/libpaper.d',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/passwd',
  '/etc/group',
  '/etc/nsswitch.conf',
  '/etc/localtime',
  '/etc/timezone',
  '/var/lib/texmf',
  '/var/lib/tex-common',
  '/var/lib/ghostscript',
  '/var/cache/fontconfig',
  '/proc/cpuinfo',
  '/proc/meminfo',
  '/dev/urandom',
  '/dev/random',
  '/dev/zero',
];

/** Besides its own folders, a compile may write here. */
const WRITE_ALWAYS = ['/dev/null'];

const QUIET_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

async function works(cmd: string, args: string[], env: NodeJS.ProcessEnv = QUIET_ENV): Promise<boolean> {
  const res = await run(cmd, args, { cwd: '/', env, timeoutMs: 8000, maxOutputBytes: 2048 });
  return res.exitCode === 0 && !res.spawnError && !res.timedOut;
}

/** The launcher: the configured path, one on PATH, or the one `native/build.sh` leaves in the source tree. */
async function findLauncher(configured?: string): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    configured,
    await findBinary('openleaf-sandbox'),
    path.resolve(here, '../../../native/bin/openleaf-sandbox'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Ask kpathsea where this installation keeps its trees, and note where the engines live. */
async function texReadPaths(env: NodeJS.ProcessEnv, binaries: string[]): Promise<string[]> {
  const found = new Set<string>();
  const home = env.HOME ? path.resolve(env.HOME) : null;
  const add = (p: string) => {
    const clean = path.resolve(p);
    if (clean === '/' || (home && (clean === home || clean.startsWith(home + path.sep)))) return;
    found.add(clean);
  };
  if (await findBinary('kpsewhich', env.PATH)) {
    for (const variable of ['TEXMF', 'TEXMFCNF']) {
      const res = await run('kpsewhich', [`-var-value=${variable}`], { cwd: '/', env, timeoutMs: 8000, maxOutputBytes: 8192 });
      // "{{}/home/x/texmf,!!/usr/share/texmf,…}" or "/etc/texmf/web2c:/usr/share/…": keep the absolute paths.
      for (const part of res.output.split(/[{},:;\s]+/)) {
        const p = part.replace(/^!!/, '').replace(/\/+$/, '');
        if (p.startsWith('/') && !p.includes('$')) add(p);
      }
    }
  }
  for (const name of binaries) {
    const bin = await findBinary(name, env.PATH);
    if (!bin) continue;
    add(path.dirname(bin));
    try {
      add(path.dirname(await realpath(bin)));
    } catch {
      /* a dangling link: nothing to add */
    }
  }
  return [...found];
}

export interface DetectOptions {
  /** The environment compiles run in, so that TeX is asked the way a compile would ask it. */
  env?: NodeJS.ProcessEnv;
  /** Programs a compile starts by name; their folders are made readable. */
  binaries?: string[];
  /** A launcher somewhere other than PATH. */
  launcher?: string;
  /** Further folders a compile may read (an unusual TeX installation, shared style files). */
  extraReadPaths?: string[];
  /** Layers to leave out even where the host offers them. */
  skip?: ('namespaces' | 'launcher' | 'files')[];
}

/** Find out which of the measures this host supports. `mode: 'off'` skips namespaces and the launcher. */
export async function detectIsolation(mode: 'auto' | 'off' | 'required', opts: DetectOptions = {}): Promise<Isolation> {
  const [prlimit, unshare, setpriv] = await Promise.all([findBinary('prlimit'), findBinary('unshare'), findBinary('setpriv')]);
  const iso: Isolation = { ...NO_ISOLATION };
  iso.limits = Boolean(prlimit) && (await works('prlimit', ['--core=0', '--', 'true']));
  iso.noNewPrivileges = Boolean(setpriv) && (await works('setpriv', ['--no-new-privs', '--', 'true']));
  if (mode === 'off') return iso;
  const skip = new Set(opts.skip ?? []);

  if (unshare && !skip.has('namespaces')) {
    for (const candidate of CANDIDATES) {
      if (await works('unshare', [...candidate, '--', 'true'])) {
        iso.namespaces = true;
        iso.namespaceArgs = candidate;
        break;
      }
    }
  }

  const launcher = skip.has('launcher') ? null : await findLauncher(opts.launcher);
  if (launcher) {
    // The launcher tries each facility for real in a child and reports what the kernel does.
    const probe = await run(launcher, ['--probe'], { cwd: '/', env: QUIET_ENV, timeoutMs: 8000, maxOutputBytes: 2048 });
    let supported: { seccomp?: boolean; landlock?: number } = {};
    try {
      supported = JSON.parse(probe.output.trim().split('\n').pop() ?? '{}') as typeof supported;
    } catch {
      /* not a launcher this code understands */
    }
    if (supported.seccomp && (await works(launcher, ['--', 'true']))) {
      iso.launcher = launcher;
      iso.syscalls = true;
      if ((supported.landlock ?? 0) >= 1 && !skip.has('files')) {
        const env = opts.env ?? QUIET_ENV;
        const readPaths = [
          ...new Set([...READ_ALWAYS, ...(await texReadPaths(env, opts.binaries ?? [])), ...(opts.extraReadPaths ?? [])]),
        ];
        if (await works(launcher, [...readPaths.flatMap((p) => ['--ro', p]), '--', 'true'])) {
          iso.files = true;
          iso.readPaths = readPaths;
        }
      }
    }
  }
  return iso;
}

export interface IsolateOptions {
  memoryMb: number;
  maxFileMb: number;
  /** Folders this run may write to (its working folder, home, caches, temporary files). */
  writable?: string[];
}

/** Wrap a command in whatever isolation is available. */
export function isolate(cmd: string, args: string[], iso: Isolation, opts: IsolateOptions): { cmd: string; args: string[] } {
  let line = [cmd, ...args];
  if (iso.syscalls && iso.launcher) {
    const paths = iso.files
      ? [
          ...iso.readPaths.flatMap((p) => ['--ro', p]),
          ...[...WRITE_ALWAYS, ...(opts.writable ?? [])].flatMap((p) => ['--rw', p]),
        ]
      : [];
    line = [iso.launcher, ...paths, '--', ...line];
  }
  if (iso.noNewPrivileges) line = ['setpriv', '--no-new-privs', '--', ...line];
  if (iso.namespaces) line = ['unshare', ...iso.namespaceArgs, '--', ...line];
  if (iso.limits) {
    const mb = 1024 * 1024;
    line = [
      'prlimit',
      '--core=0',
      ...(opts.memoryMb > 0 ? [`--as=${opts.memoryMb * mb}`] : []),
      ...(opts.maxFileMb > 0 ? [`--fsize=${opts.maxFileMb * mb}`] : []),
      '--',
      ...line,
    ];
  }
  return { cmd: line[0]!, args: line.slice(1) };
}

/**
 * Whether other processes of the same user are kept from reading this process's memory and
 * environment (where the database address and the keys are). True when the service was
 * started with the guard library (`native/guard.c`), which marks it "not dumpable": the
 * kernel then gives its /proc files to root. A service running as root cannot be guarded
 * this way, and should not run as root.
 */
export async function serviceGuarded(): Promise<boolean> {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return false;
  const uid = process.getuid();
  if (uid === 0) return false;
  try {
    return (await stat('/proc/self/environ')).uid !== uid;
  } catch {
    return false;
  }
}

export function describeIsolation(iso: Isolation, guarded = false): string {
  const parts = [
    noNetwork(iso) ? 'no network' : 'shares the service’s network',
    iso.namespaces
      ? 'own process view'
      : iso.syscalls
        ? 'cannot look into other processes'
        : 'can see the service’s process',
    iso.files ? 'sees only TeX and its own folders' : iso.namespaces ? 'own mount view' : 'shares the service’s file view',
    iso.limits ? 'memory and file-size limits' : 'no resource limits',
    iso.noNewPrivileges || iso.syscalls ? 'no new privileges' : null,
    guarded ? 'the service’s memory is closed to it' : null,
  ].filter(Boolean);
  return parts.join('; ');
}
