import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from '../src/modules/compile/runner.js';
import { detectIsolation, isolate, noNetwork, NO_ISOLATION } from '../src/modules/compile/sandbox.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/core/db.js';
import { EventBus } from '../src/core/events.js';
import { CompileService, readIfFresh } from '../src/modules/compile/service.js';
import { createTestApp, newProject, signUp, type TestApp } from './helpers.js';

/*
 * How a compile is kept apart from the service on a host that offers no namespaces: the
 * launcher (native/sandbox.c) and the guard (native/guard.c). Build them with
 * `sh native/build.sh`; without them, and off Linux, these tests are skipped.
 *
 * These check that each measure does what it says for an ordinary program. They are not
 * attempts to get around it.
 */
const LAUNCHER = path.resolve('native/bin/openleaf-sandbox');
const GUARD = path.resolve('native/bin/libopenleaf-guard.so');
const onLinux = process.platform === 'linux';
const haveLauncher = onLinux && existsSync(LAUNCHER);
const supported: { seccomp?: boolean; landlock?: number } = haveLauncher
  ? JSON.parse(spawnSync(LAUNCHER, ['--probe']).stdout.toString() || '{}')
  : {};
const has = (program: string) => spawnSync('sh', ['-c', `command -v ${program}`]).status === 0;

/** Enough for `sh`, `cat` and friends to start. */
const SYSTEM = ['/usr', '/bin', '/lib', '/lib64', '/etc/ld.so.cache'].flatMap((p) => ['--ro', p]);

describe('the launcher', { skip: !haveLauncher }, () => {
  let dir = '';
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'openleaf-launcher-'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('says what this kernel supports', () => {
    assert.equal(typeof supported.seccomp, 'boolean');
    assert.equal(typeof supported.landlock, 'number');
  });

  it('starts the program and passes on its exit code', () => {
    assert.equal(spawnSync(LAUNCHER, ['--', 'sh', '-c', 'exit 7']).status, 7);
    assert.equal(spawnSync(LAUNCHER, ['--', 'true']).status, 0);
    // No program to start, or an option it does not know: it says how it is used.
    assert.equal(spawnSync(LAUNCHER, ['--']).status, 2);
    assert.equal(spawnSync(LAUNCHER, ['--frobnicate', '--', 'true']).status, 2);
  });

  it('gives the program no network', { skip: !supported.seccomp }, () => {
    // Listening on a local port is the smallest thing that needs a socket.
    const open =
      "const s = require('node:net').createServer();" +
      "s.on('error', (e) => { console.error(e.code); process.exit(1); });" +
      "s.listen(0, '127.0.0.1', () => { console.log('opened'); s.close(); });";
    const free = spawnSync(process.execPath, ['-e', open]);
    assert.equal(free.status, 0, 'a socket can be opened without the launcher');
    assert.match(free.stdout.toString(), /opened/);
    const inside = spawnSync(LAUNCHER, ['--', process.execPath, '-e', open]);
    assert.equal(inside.status, 1);
    assert.match(inside.stderr.toString(), /EACCES/);
    assert.doesNotMatch(inside.stdout.toString(), /opened/);
  });

  it('keeps the program in the process group it was started in', { skip: !supported.seccomp }, () => {
    // setsid(1) asks for a new session; refused, it says so and does not run the command.
    const res = spawnSync(LAUNCHER, ['--', 'setsid', 'true']);
    assert.notEqual(res.status, 0);
  });

  it('shows the program only the folders it was given', { skip: !(supported.landlock! >= 1) }, async () => {
    const mine = path.join(dir, 'mine');
    const other = path.join(dir, 'other');
    spawnSync('mkdir', ['-p', mine, other]);
    await writeFile(path.join(other, 'note.txt'), 'elsewhere');
    await writeFile(path.join(mine, 'own.txt'), 'here');
    const inside = (script: string) => spawnSync(LAUNCHER, [...SYSTEM, '--rw', mine, '--', 'sh', '-c', script], { cwd: mine });

    // Its own folder: read and write.
    const ok = inside('cat own.txt && echo more > new.txt && cat new.txt');
    assert.equal(ok.status, 0, ok.stderr.toString());
    assert.equal(ok.stdout.toString(), 'heremore\n');

    // A folder it was not given: neither read nor write.
    assert.notEqual(inside(`cat ${other}/note.txt`).status, 0);
    assert.notEqual(inside(`echo x > ${other}/new.txt`).status, 0);
    assert.equal(existsSync(path.join(other, 'new.txt')), false);

    // In its own folder it can make files, but not links, and it cannot run what it wrote.
    assert.notEqual(inside(`ln -s ${other}/note.txt link.txt`).status, 0);
    assert.notEqual(inside('printf "#!/bin/sh\\necho ran\\n" > tool && chmod +x tool && ./tool').status, 0);
  });
});

describe('what the service does with a folder a compile wrote in', () => {
  let dir = '';
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'openleaf-outputs-'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('reads an output only when it is a plain file', async () => {
    const elsewhere = path.join(dir, 'elsewhere.txt');
    await writeFile(elsewhere, 'not an output');
    await writeFile(path.join(dir, 'real.log'), 'a log');
    await symlink(elsewhere, path.join(dir, 'linked.log'));

    assert.equal((await readIfFresh(path.join(dir, 'real.log'), 0))?.toString(), 'a log');
    assert.equal(await readIfFresh(path.join(dir, 'linked.log'), 0), null);
    assert.equal(await readIfFresh(path.join(dir, 'missing.log'), 0), null);
    assert.equal(await readIfFresh(dir, 0), null);
    // Older than the compile that is being read: not this compile's output.
    assert.equal(await readIfFresh(path.join(dir, 'real.log'), Date.now() + 60_000), null);
    if (onLinux && spawnSync('mkfifo', [path.join(dir, 'pipe.log')]).status === 0) {
      assert.equal(await readIfFresh(path.join(dir, 'pipe.log'), 0), null);
    }
  });

  it('ends everything a run started once the run is over', async () => {
    const started = Date.now();
    const res = await run('sh', ['-c', 'sleep 30 & echo $!'], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeoutMs: 20_000,
    });
    assert.equal(res.exitCode, 0);
    assert.ok(Date.now() - started < 10_000, 'the run did not wait for what it left behind');
    const pid = Number(res.output.trim());
    assert.ok(pid > 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Gone, or ended and waiting to be collected ("Z"): either way it runs no more.
    const state = await readFile(`/proc/${pid}/stat`, 'utf8').then((stat) => stat.split(') ')[1]?.[0], () => 'gone');
    assert.match(String(state), /^(gone|Z|X)$/);
  });
});

describe('compiling on a host without namespaces', { skip: !haveLauncher || !supported.seccomp }, () => {
  let t: TestApp;
  let token = '';
  before(async () => {
    t = await createTestApp({ COMPILE_ISOLATION_SKIP: 'namespaces' });
    token = (await signUp(t, 'nora')).token;
  });
  after(() => t.destroy());

  const compile = async (files: Record<string, string>, engine = 'pdflatex') => {
    const id = await newProject(t, token, 'Apart');
    for (const [file, content] of Object.entries(files)) {
      await t.api.put(`/api/projects/${id}/files/content`, { path: file, content }, token);
    }
    const res = await t.api.post(`/api/projects/${id}/compile`, { engine }, token);
    return { id, compile: res.body.compile };
  };

  it('says which measures are in force', async () => {
    const iso = (await t.api.get('/api/system/info', token)).body.compile.isolation;
    assert.equal(iso.namespaces, false);
    assert.equal(iso.launcher, true);
    assert.equal(iso.noNetwork, true);
    assert.equal(iso.noProcessAccess, true);
    assert.equal(iso.narrowFiles, supported.landlock! >= 1);
    assert.equal(typeof iso.serviceGuarded, 'boolean');
    assert.match(iso.summary, /no network/);
  });

  for (const engine of ['pdflatex', 'xelatex', 'lualatex']) {
    it(`compiles with ${engine}`, { skip: !has(engine) }, async () => {
      const unicode = engine !== 'pdflatex';
      const { compile: c } = await compile(
        {
          'main.tex': [
            '\\documentclass{article}',
            unicode ? '\\usepackage{fontspec}' : '\\usepackage[utf8]{inputenc}\\usepackage[T1]{fontenc}',
            '\\usepackage{amsmath,graphicx,hyperref,tikz}',
            '\\begin{document}',
            '\\section{One}\\label{s} Café, naïve, see~\\ref{s}. \\tikz \\draw (0,0) -- (1,1);',
            '\\end{document}',
          ].join('\n'),
        },
        engine,
      );
      assert.equal(c.status, 'success', JSON.stringify(c.diagnostics));
    });
  }

  it('runs Biber', { skip: !has('biber') }, async () => {
    const { compile: c } = await compile({
      'main.tex': [
        '\\documentclass{article}',
        '\\usepackage[backend=biber]{biblatex}',
        '\\addbibresource{refs.bib}',
        '\\begin{document}',
        'As shown by \\textcite{knuth}. \\printbibliography',
        '\\end{document}',
      ].join('\n'),
      'refs.bib': '@book{knuth, author={Knuth, Donald E.}, title={The {\\TeX}book}, year={1984}, publisher={Addison-Wesley}}\n',
    });
    assert.equal(c.status, 'success', JSON.stringify(c.diagnostics));
  });

  it('makes an index', { skip: !has('makeindex') }, async () => {
    const { compile: c } = await compile({
      'main.tex': [
        '\\documentclass{article}',
        '\\usepackage{makeidx}\\makeindex',
        '\\begin{document}',
        'Beams\\index{beam} and columns\\index{column}. \\printindex',
        '\\end{document}',
      ].join('\n'),
    });
    assert.equal(c.status, 'success', JSON.stringify(c.diagnostics));
  });

  it('converts an EPS figure through TeX’s restricted shell commands', { skip: !has('gs') || !has('repstopdf') }, async () => {
    const { compile: c } = await compile({
      'main.tex': [
        '\\documentclass{article}',
        '\\usepackage{graphicx}',
        '\\begin{document}',
        '\\includegraphics{line.eps}',
        '\\end{document}',
      ].join('\n'),
      'line.eps': [
        '%!PS-Adobe-3.0 EPSF-3.0',
        '%%BoundingBox: 0 0 100 100',
        'newpath 10 10 moveto 90 90 lineto stroke',
        'showpage',
        '%%EOF',
        '',
      ].join('\n'),
    });
    assert.equal(c.status, 'success', JSON.stringify(c.diagnostics));
  });

  it('takes links out of a project’s folder before writing into it again', async () => {
    const { id, compile: c } = await compile({
      'main.tex': '\\documentclass{article}\\begin{document}One.\\end{document}\n',
    });
    assert.equal(c.status, 'success');
    const src = path.join(t.compileDir, 'projects', id, 'src');
    // As if a compile had left a link where a project file will later be written.
    const outside = path.join(t.compileDir, 'outside.txt');
    await writeFile(outside, 'untouched');
    await symlink(outside, path.join(src, 'notes.tex'));

    await t.api.put(`/api/projects/${id}/files/content`, { path: 'notes.tex', content: 'A note.\n' }, token);
    const again = await t.api.post(`/api/projects/${id}/compile`, { force: true }, token);
    assert.equal(again.body.compile.status, 'success');
    assert.equal(await readFile(outside, 'utf8'), 'untouched');
    assert.equal((await lstat(path.join(src, 'notes.tex'))).isFile(), true);
    assert.equal(await readFile(path.join(src, 'notes.tex'), 'utf8'), 'A note.\n');
  });

  it('starts again from nothing when the folder itself was swapped for a link', async () => {
    const { id } = await compile({ 'main.tex': '\\documentclass{article}\\begin{document}Two.\\end{document}\n' });
    const root = path.join(t.compileDir, 'projects', id);
    const decoy = path.join(t.compileDir, 'decoy');
    spawnSync('mkdir', ['-p', decoy]);
    await rm(path.join(root, 'src'), { recursive: true, force: true });
    await symlink(decoy, path.join(root, 'src'));

    const again = await t.api.post(`/api/projects/${id}/compile`, { force: true }, token);
    assert.equal(again.body.compile.status, 'success');
    assert.equal((await lstat(path.join(root, 'src'))).isDirectory(), true);
    assert.equal(existsSync(path.join(decoy, 'main.tex')), false);
  });
});

describe('choosing the isolation', { skip: !onLinux }, () => {
  it('wraps a command in the layers that are on, outermost first', () => {
    const iso = {
      ...NO_ISOLATION,
      limits: true,
      noNewPrivileges: true,
      launcher: '/x/openleaf-sandbox',
      syscalls: true,
      files: true,
      readPaths: ['/usr'],
    };
    const { cmd, args } = isolate('latexmk', ['-pdf', 'main.tex'], iso, { memoryMb: 1, maxFileMb: 2, writable: ['/work'] });
    assert.equal(cmd, 'prlimit');
    assert.deepEqual(args, [
      '--core=0',
      '--as=1048576',
      '--fsize=2097152',
      '--',
      'setpriv',
      '--no-new-privs',
      '--',
      '/x/openleaf-sandbox',
      '--ro',
      '/usr',
      '--rw',
      '/dev/null',
      '--rw',
      '/work',
      '--',
      'latexmk',
      '-pdf',
      'main.tex',
    ]);
    // Without the file rules the launcher is given no paths; with nothing on, the command is itself.
    const plain = isolate('latexmk', [], { ...iso, files: false }, { memoryMb: 0, maxFileMb: 0 });
    assert.deepEqual([plain.cmd, ...plain.args], ['prlimit', '--core=0', '--', 'setpriv', '--no-new-privs', '--', '/x/openleaf-sandbox', '--', 'latexmk']);
    assert.deepEqual(isolate('latexmk', ['a'], NO_ISOLATION, { memoryMb: 1, maxFileMb: 1 }), { cmd: 'latexmk', args: ['a'] });
  });

  it('leaves out the layers it is told to, and everything but limits when switched off', async () => {
    const off = await detectIsolation('off');
    assert.equal(off.namespaces || off.syscalls || off.files, false);
    assert.equal(noNetwork(off), false);

    const noLauncher = await detectIsolation('auto', { skip: ['launcher'] });
    assert.equal(noLauncher.syscalls || noLauncher.files, false);
    assert.equal(noLauncher.launcher, null);

    if (haveLauncher && supported.seccomp) {
      const noFiles = await detectIsolation('auto', { skip: ['namespaces', 'files'] });
      assert.deepEqual([noFiles.namespaces, noFiles.syscalls, noFiles.files], [false, true, false]);
      assert.equal(noNetwork(noFiles), true);
    }
  });

  it('steps down a layer when TeX does not compile inside it, and says so', { skip: !haveLauncher || !(supported.landlock! >= 1) }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'openleaf-stepdown-'));
    const said: string[] = [];
    const log = { info: () => {}, error: (_o: object, msg: string) => void said.push(msg) };
    const config = loadConfig({ DATABASE_URL: 'postgres://unused@localhost/unused', COMPILE_DIR: dir, COMPILE_ISOLATION_SKIP: 'namespaces' });
    try {
      // The self-test never touches the database.
      const compiler = new CompileService(null as unknown as Db, config, new EventBus(), log);
      await compiler.prepareIsolation();
      assert.equal(compiler.isolation.files, true);
      const real = compiler.isolation;

      // A host whose file rules leave TeX out altogether: nothing can start inside them.
      compiler.isolation = { ...real, readPaths: ['/var/empty-and-missing'] };
      const [result] = await compiler.runSelfTest(['pdflatex']);
      assert.equal(result!.ok, true, result!.message);
      assert.equal(compiler.isolation.files, false, 'the file rules were dropped');
      assert.equal(compiler.isolation.syscalls, true, 'the rest was kept');
      assert.equal(noNetwork(compiler.isolation), true);
      assert.match(said.join('\n'), /continuing with less of it/);

      // And one whose rules let latexmk start but hide something TeX needs (here: its formats).
      if (existsSync('/var/lib/texmf/web2c')) {
        compiler.isolation = { ...real, readPaths: real.readPaths.filter((p) => !p.startsWith('/var/lib/texmf')) };
        const [again] = await compiler.runSelfTest(['pdflatex']);
        assert.equal(again!.ok, true, again!.message);
        assert.equal(compiler.isolation.files, false);
        assert.equal(compiler.isolation.syscalls, true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to compile without the network cut when isolation is required', async () => {
    const t = await createTestApp({ COMPILE_ISOLATION: 'required', COMPILE_ISOLATION_SKIP: 'namespaces,launcher' });
    try {
      const token = (await signUp(t, 'rhea')).token;
      const id = await newProject(t, token, 'Strict');
      const res = await t.api.post(`/api/projects/${id}/compile`, {}, token);
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'isolation_unavailable');
    } finally {
      await t.destroy();
    }
  });
});

describe('the guard', { skip: !onLinux || !existsSync(GUARD) || !has('stat') }, () => {
  // Who owns a process's /proc files: the user it runs as, or root once it is guarded.
  const ownerOfOwnEnviron = (preload: boolean): { uid: number; owner: number } | null => {
    const asRoot = process.getuid!() === 0;
    if (asRoot && !has('setpriv')) return null;
    const uid = asRoot ? 65534 : process.getuid!();
    const prefix = asRoot ? ['setpriv', '--reuid=65534', '--regid=65534', '--clear-groups'] : [];
    const line = [...prefix, 'env', ...(preload ? [`LD_PRELOAD=${GUARD}`] : []), 'stat', '-c', '%u', '/proc/self/environ'];
    const res = spawnSync(line[0]!, line.slice(1));
    if (res.status !== 0) return null;
    return { uid, owner: Number(res.stdout.toString().trim()) };
  };

  it('hands a process’s memory and environment files to root', (ctx) => {
    const plain = ownerOfOwnEnviron(false);
    const guarded = ownerOfOwnEnviron(true);
    if (!plain || !guarded) return ctx.skip('cannot run as an ordinary user here');
    assert.equal(plain.owner, plain.uid, 'normally a process owns them itself');
    assert.equal(guarded.owner, 0);
    assert.notEqual(guarded.uid, 0);
  });
});
