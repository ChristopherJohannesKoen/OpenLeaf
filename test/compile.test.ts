import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { unzipSync } from 'fflate';
import { createTestApp, newProject, signUp, type TestApp } from './helpers.js';

const isPdf = (buf: Buffer) => buf.subarray(0, 5).toString('latin1') === '%PDF-';

const GOOD = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,hyperref}
\\begin{document}
\\section{Introduction}\\label{sec:intro}
Hello from OpenLeaf, see Section~\\ref{sec:intro}.
\\input{chapters/one}
\\end{document}
`;

describe('compiling', () => {
  let t: TestApp;
  let token = '';
  let projectId = '';
  before(async () => {
    t = await createTestApp();
    token = (await signUp(t, 'alice')).token;
    projectId = await newProject(t, token, 'Compile me');
    await t.api.put(`/api/projects/${projectId}/files/content`, { path: 'main.tex', content: GOOD }, token);
    await t.api.put(
      `/api/projects/${projectId}/files/content`,
      { path: 'chapters/one.tex', content: '\\section{One}\nText in chapter one with $x^2$.\n' },
      token,
    );
  });
  after(() => t.destroy());

  const p = (suffix: string) => `/api/projects/${projectId}${suffix}`;
  const save = (path: string, content: string) => t.api.put(p('/files/content'), { path, content }, token);

  it('lists the engines that are installed', async () => {
    const res = await t.api.get('/api/compile/engines', token);
    assert.equal(res.body.defaultEngine, 'pdflatex');
    const pdflatex = res.body.engines.find((e: any) => e.id === 'pdflatex');
    assert.equal(pdflatex.available, true);
    assert.match(pdflatex.version, /pdfTeX/);
  });

  it('says so when there is nothing to show yet', async () => {
    assert.equal((await t.api.get(p('/output.pdf'), token)).status, 404);
    assert.equal((await t.api.get(p('/compiles/latest'), token)).body.compile, null);
  });

  let firstCompile = '';

  it('compiles a multi-file project to PDF', async () => {
    const res = await t.api.post(p('/compile'), {}, token);
    assert.equal(res.status, 200);
    const c = res.body.compile;
    assert.equal(c.status, 'success', JSON.stringify(c.diagnostics));
    assert.equal(c.cached, false);
    assert.equal(c.errorCount, 0);
    assert.equal(c.hasPdf, true);
    assert.equal(c.hasSynctex, true);
    assert.ok(c.pdfSize > 1000);
    firstCompile = c.id;

    const pdf = await t.api.get(p('/output.pdf'), token);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.headers['content-security-policy'], undefined);
    assert.match(String(pdf.headers['content-disposition']), /^inline; filename="Compile-me\.pdf"/);
    assert.ok(isPdf(pdf.raw));
    assert.equal(pdf.raw.length, c.pdfSize);

    const log = await t.api.get(p('/output.log'), token);
    assert.match(log.raw.toString(), /This is pdfTeX/);
    const consoleLog = await t.api.get(p('/output.log?console=true'), token);
    assert.match(consoleLog.raw.toString(), /Latexmk/);
  });

  it('reuses the result when nothing changed, unless forced', async () => {
    const again = await t.api.post(p('/compile'), {}, token);
    assert.equal(again.body.compile.id, firstCompile);
    assert.equal(again.body.compile.cached, true);

    const forced = await t.api.post(p('/compile'), { force: true }, token);
    assert.equal(forced.body.compile.cached, false);
    assert.notEqual(forced.body.compile.id, firstCompile);
    assert.equal(forced.body.compile.status, 'success');
  });

  it('maps source lines to the PDF and back with SyncTeX', async () => {
    const forward = await t.api.post(p('/synctex/forward'), { file: 'chapters/one.tex', line: 2 }, token);
    assert.equal(forward.status, 200);
    assert.ok(forward.body.positions.length >= 1);
    const pos = forward.body.positions[0];
    assert.equal(pos.page, 1);
    assert.ok(pos.h > 0 && pos.v > 0 && pos.width > 0);

    const inverse = await t.api.post(p('/synctex/inverse'), { page: 1, h: pos.h + 5, v: pos.v + 2 }, token);
    assert.equal(inverse.status, 200);
    assert.deepEqual([inverse.body.position.file, inverse.body.position.line], ['chapters/one.tex', 2]);
  });

  it('reports errors with file and line, and still returns a PDF', async () => {
    await save('chapters/one.tex', '\\section{One}\nA mistake: \\undefinedmacro here.\nSee \\ref{nowhere}.\n');
    const res = await t.api.post(p('/compile'), {}, token);
    assert.equal(res.status, 200);
    const c = res.body.compile;
    assert.equal(c.status, 'failure');
    assert.equal(c.hasPdf, true);
    assert.ok(c.errorCount >= 1);
    const error = c.diagnostics.find((d: any) => d.level === 'error');
    assert.deepEqual([error.file, error.line, error.message], ['chapters/one.tex', 2, 'Undefined control sequence.']);
    assert.match(error.context, /undefinedmacro/);
    const warning = c.diagnostics.find((d: any) => d.level === 'warning' && /nowhere/.test(d.message));
    assert.equal(warning.file, 'chapters/one.tex');
    assert.equal(warning.line, 3);

    // A failed compile is never served from the cache.
    const retry = await t.api.post(p('/compile'), {}, token);
    assert.notEqual(retry.body.compile.id, c.id);
  });

  it('stops at the first error when asked, leaving no fresh PDF', async () => {
    const res = await t.api.post(p('/compile'), { stopOnFirstError: true, clean: true }, token);
    assert.equal(res.body.compile.status, 'failure');
    assert.equal(res.body.compile.hasPdf, false);
    assert.equal(res.body.compile.message, 'The document could not be compiled.');
    // The last good PDF is still what /output.pdf serves.
    const pdf = await t.api.get(p('/output.pdf'), token);
    assert.equal(pdf.status, 200);
    assert.ok(isPdf(pdf.raw));
  });

  it('runs BibTeX and reports bibliography problems', async () => {
    await save('chapters/one.tex', '\\section{One}\nKnuth wrote a book~\\cite{knuth}; so did nobody~\\cite{ghost}.\n');
    await save('refs.bib', '@book{knuth, author={Donald Knuth}, title={The TeXbook}, year={1984}, publisher={AW}}\n');
    await save('main.tex', GOOD.replace('\\end{document}', '\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}'));
    const res = await t.api.post(p('/compile'), {}, token);
    const c = res.body.compile;
    assert.equal(c.status, 'success', JSON.stringify(c.diagnostics));
    const bib = c.diagnostics.find((d: any) => d.source === 'bibtex');
    assert.match(bib.message, /ghost/);
    assert.match((await t.api.get(p('/output.log'), token)).raw.toString(), /main\.bbl/);
  });

  it('can compile in the background', async () => {
    await save('chapters/one.tex', '\\section{One}\nBackground compile.\n');
    await save('main.tex', GOOD);
    const started = await t.api.post(p('/compile?wait=false'), {}, token);
    assert.equal(started.status, 202);
    assert.ok(['queued', 'running'].includes(started.body.compile.status));
    let c = started.body.compile;
    for (let i = 0; i < 300 && ['queued', 'running'].includes(c.status); i++) {
      await new Promise((r) => setTimeout(r, 100));
      c = (await t.api.get(c.links.self, token)).body.compile;
    }
    assert.equal(c.status, 'success');
    assert.equal((await t.api.get(c.links.pdf, token)).status, 200);
  });

  it('rejects unknown engines and missing main files', async () => {
    assert.equal((await t.api.post(p('/compile'), { engine: 'wordperfect' }, token)).body.error.code, 'unknown_engine');
    assert.equal((await t.api.post(p('/compile'), { mainFile: 'nope.tex' }, token)).body.error.code, 'main_file_missing');
  });

  it('keeps only the most recent compiles', async () => {
    const list = await t.api.get(p('/compiles'), token);
    assert.ok(list.body.compiles.length <= 4, `kept ${list.body.compiles.length}`);
    assert.ok(list.body.compiles.some((c: any) => c.hasPdf));
  });

  it('serves the PDF and SyncTeX from the database after a restart', async () => {
    const restarted = await createTestApp({}, false); // new process state, empty compile directory
    try {
      const pdf = await restarted.api.get(p('/output.pdf'), token);
      assert.equal(pdf.status, 200);
      assert.ok(isPdf(pdf.raw));
      const forward = await restarted.api.post(p('/synctex/forward'), { file: 'chapters/one.tex', line: 2 }, token);
      assert.equal(forward.status, 200);
      assert.ok(forward.body.positions.length >= 1);
    } finally {
      await restarted.destroy();
    }
  });
});

describe('other engines', () => {
  let t: TestApp;
  let token = '';
  before(async () => {
    t = await createTestApp();
    token = (await signUp(t, 'alice')).token;
  });
  after(() => t.destroy());

  const UNICODE = `\\documentclass{article}
\\usepackage{fontspec}
\\begin{document}
Unicode text: café, naïve, Stellenbosch — ünïcödé.
\\end{document}
`;

  // luaotfload (needed for fontspec under LuaLaTeX) is not part of every TeX install;
  // without it LuaLaTeX can still compile documents that use the classic fonts.
  const hasLuaotfload = spawnSync('kpsewhich', ['luaotfload-main.lua']).status === 0;
  const PLAIN = '\\documentclass{article}\n\\begin{document}\nHello from LuaLaTeX.\n\\end{document}\n';

  for (const engine of ['xelatex', 'lualatex']) {
    it(`compiles with ${engine}`, async () => {
      const id = await newProject(t, token, `With ${engine}`);
      const content = engine === 'lualatex' && !hasLuaotfload ? PLAIN : UNICODE;
      await t.api.put(`/api/projects/${id}/files/content`, { path: 'main.tex', content }, token);
      await t.api.patch(`/api/projects/${id}`, { engine }, token);
      const res = await t.api.post(`/api/projects/${id}/compile`, {}, token);
      assert.equal(res.body.compile.status, 'success', JSON.stringify(res.body.compile.diagnostics));
      assert.equal(res.body.compile.engine, engine);
      assert.ok(isPdf((await t.api.get(`/api/projects/${id}/output.pdf`, token)).raw));
    });
  }

  it('runs the start-up self-test for every installed engine', async () => {
    const withSelfTest = await createTestApp({ STARTUP_SELFTEST: 'all' }, false);
    try {
      let info: any;
      for (let i = 0; i < 600; i++) {
        info = (await withSelfTest.api.get('/api/system/info', token)).body; // same database, so the same session
        if (info.compile.selfTests.length === 3) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const byEngine = Object.fromEntries(info.compile.selfTests.map((r: any) => [r.engine, r.ok]));
      assert.equal(byEngine.pdflatex, true);
      assert.equal(byEngine.xelatex, true);
      if (hasLuaotfload) assert.equal(byEngine.lualatex, true);
    } finally {
      await withSelfTest.destroy();
    }
  });

  it('handles a main file in a sub-folder with spaces in its name', async () => {
    const id = await newProject(t, token, 'Nested');
    await t.api.put(
      `/api/projects/${id}/files/content`,
      { path: 'paper/my thesis.tex', content: '\\documentclass{article}\\begin{document}Nested\\end{document}\n' },
      token,
    );
    await t.api.patch(`/api/projects/${id}`, { mainFile: 'paper/my thesis.tex' }, token);
    const res = await t.api.post(`/api/projects/${id}/compile`, {}, token);
    assert.equal(res.body.compile.status, 'success', JSON.stringify(res.body.compile.diagnostics));
  });
});

describe('engine allow-list and isolation', () => {
  it('offers only the engines the instance allows', async () => {
    const t = await createTestApp({ COMPILE_ENGINES: 'pdflatex' });
    try {
      const token = (await signUp(t, 'erin')).token;
      const projectId = await newProject(t, token, 'One engine');
      const engines = await t.api.get('/api/compile/engines', token);
      assert.deepEqual(engines.body.engines.map((e: any) => e.id), ['pdflatex']);
      const refused = await t.api.post(`/api/projects/${projectId}/compile`, { engine: 'lualatex' }, token);
      assert.equal(refused.status, 400);
      assert.equal(refused.body.error.code, 'engine_disabled');
      const ok = await t.api.post(`/api/projects/${projectId}/compile`, {}, token);
      assert.equal(ok.body.compile.status, 'success');
    } finally {
      await t.destroy();
    }
  });

  it('says how compiles are kept apart, and still compiles with isolation switched off', async () => {
    const t = await createTestApp({ COMPILE_ISOLATION: 'off' });
    try {
      const token = (await signUp(t, 'omar')).token;
      const info = await t.api.get('/api/system/info', token);
      assert.equal(info.body.compile.isolation.namespaces, false);
      const projectId = await newProject(t, token, 'Plain');
      const res = await t.api.post(`/api/projects/${projectId}/compile`, {}, token);
      assert.equal(res.body.compile.status, 'success');
    } finally {
      await t.destroy();
    }
  });
});

describe('compile sandboxing', () => {
  let t: TestApp;
  let token = '';
  before(async () => {
    process.env.OPENLEAF_TEST_SECRET = 'super-secret-value';
    t = await createTestApp({ COMPILE_TIMEOUT_MS: '4000' });
    token = (await signUp(t, 'mallory')).token;
  });
  after(async () => {
    delete process.env.OPENLEAF_TEST_SECRET;
    await t.destroy();
  });

  const compileDoc = async (body: string, extra: Record<string, string> = {}) => {
    const id = await newProject(t, token, 'Sandbox');
    await t.api.put(
      `/api/projects/${id}/files/content`,
      { path: 'main.tex', content: `\\documentclass{article}\\begin{document}\n${body}\n\\end{document}\n` },
      token,
    );
    for (const [path, content] of Object.entries(extra)) {
      await t.api.put(`/api/projects/${id}/files/content`, { path, content }, token);
    }
    const res = await t.api.post(`/api/projects/${id}/compile`, {}, token);
    const log = (await t.api.get(`/api/projects/${id}/output.log`, token)).raw.toString();
    const consoleLog = (await t.api.get(`/api/projects/${id}/output.log?console=true`, token)).raw.toString();
    return { id, compile: res.body.compile, log, consoleLog };
  };

  it('does not run arbitrary shell commands from the document', async () => {
    const { id, log } = await compileDoc('\\immediate\\write18{touch pwned.txt}\\input{|"id"} done');
    assert.doesNotMatch(log, /uid=\d+/);
    assert.match(log, /runsystem\(touch pwned\.txt\)\.\.\.disabled \(restricted\)/);
    assert.equal(existsSync(path.join(t.compileDir, 'projects', id, 'src', 'pwned.txt')), false);
    assert.equal(existsSync(path.join(t.compileDir, 'projects', id, 'src', 'main.tex')), true);
  });

  it('can switch shell commands off completely', async () => {
    const strict = await createTestApp({ COMPILE_SHELL_ESCAPE: 'off' }, false);
    try {
      const user = (await signUp(strict, 'strict')).token;
      const pid = await newProject(strict, user, 'Strict');
      await strict.api.put(
        `/api/projects/${pid}/files/content`,
        { path: 'main.tex', content: '\\documentclass{article}\\begin{document}\\immediate\\write18{kpsewhich article.cls}x\\end{document}' },
        user,
      );
      await strict.api.post(`/api/projects/${pid}/compile`, {}, user);
      const log = (await strict.api.get(`/api/projects/${pid}/output.log`, user)).raw.toString();
      assert.match(log, /\\write18 disabled|runsystem\(kpsewhich article\.cls\)\.\.\.disabled\./);
    } finally {
      await strict.destroy();
    }
  });

  it('cannot read files outside the project', async () => {
    const { compile, log } = await compileDoc('\\input{/etc/passwd} \\input{../../../../etc/hostname}');
    assert.equal(compile.status, 'failure');
    assert.doesNotMatch(log, /root:x:0:0/);
    assert.match(log, /not found|openin_any = p/);
  });

  it("does not expose the server's environment to the compiler", async () => {
    const { log, consoleLog } = await compileDoc('\\input{/proc/self/environ} \\input{/proc/1/environ}');
    assert.doesNotMatch(log + consoleLog, /super-secret-value|DATABASE_URL/);
  });

  it('ignores a latexmkrc in the project unless explicitly allowed', async () => {
    const { compile, consoleLog } = await compileDoc('Plain document.', {
      latexmkrc: 'system("echo RC-WAS-EXECUTED");\n',
      '.latexmkrc': 'system("echo RC-WAS-EXECUTED");\n',
    });
    assert.equal(compile.status, 'success');
    assert.doesNotMatch(consoleLog, /RC-WAS-EXECUTED/);
  });

  it('stops a compile that runs too long', async () => {
    const { compile } = await compileDoc('\\loop\\iftrue\\repeat');
    assert.equal(compile.status, 'timeout');
    assert.equal(compile.hasPdf, false);
    assert.match(compile.message, /stopped after 4 seconds/);
  });
});

describe('history', () => {
  let t: TestApp;
  let token = '';
  let projectId = '';
  before(async () => {
    t = await createTestApp({ HISTORY_AUTO_INTERVAL_MINUTES: '0' });
    token = (await signUp(t, 'alice')).token;
    projectId = await newProject(t, token, 'Versioned');
  });
  after(() => t.destroy());

  const p = (suffix: string) => `/api/projects/${projectId}${suffix}`;
  const save = (path: string, content: string) => t.api.put(p('/files/content'), { path, content }, token);
  const DOC = (text: string) => `\\documentclass{article}\\begin{document}\n${text}\n\\end{document}\n`;

  let v1 = '';

  it('saves a named version', async () => {
    await save('main.tex', DOC('Version one.'));
    await save('notes/todo.txt', 'first note');
    const res = await t.api.post(p('/versions'), { label: 'First draft' }, token);
    assert.equal(res.status, 201);
    assert.equal(res.body.version.label, 'First draft');
    assert.equal(res.body.version.fileCount, 2);
    v1 = res.body.version.id;
    const detail = await t.api.get(p(`/versions/${v1}`), token);
    assert.deepEqual(detail.body.files.map((f: any) => f.path), ['main.tex', 'notes', 'notes/todo.txt']);
  });

  it('shows what changed since a version', async () => {
    await save('main.tex', DOC('Version two.'));
    await save('extra.tex', 'new file');
    await t.api.del(p('/files?path=notes'), token);

    const diff = await t.api.get(p(`/versions/${v1}/diff`), token);
    assert.deepEqual(diff.body.changes, [
      { path: 'extra.tex', kind: 'text', status: 'added' },
      { path: 'main.tex', kind: 'text', status: 'modified' },
      { path: 'notes/todo.txt', kind: 'text', status: 'removed' },
    ]);

    const file = await t.api.get(p(`/versions/${v1}/diff?path=main.tex`), token);
    assert.equal(file.body.status, 'modified');
    assert.match(file.body.patch, /-Version one\.\n\+Version two\./);
    assert.match(file.body.before, /Version one/);
    assert.match(file.body.after, /Version two/);

    const old = await t.api.get(p(`/versions/${v1}/file?path=notes/todo.txt`), token);
    assert.equal(old.body.file.content, 'first note');
  });

  it('saves a version automatically after a successful compile', async () => {
    const res = await t.api.post(p('/compile'), {}, token);
    assert.equal(res.body.compile.status, 'success');
    await t.events.settle();
    const list = await t.api.get(p('/versions'), token);
    assert.deepEqual(list.body.versions.map((v: any) => v.kind), ['auto', 'manual']);

    // Compiling the same content again does not add another one.
    await t.api.post(p('/compile'), { force: true }, token);
    await t.events.settle();
    assert.equal((await t.api.get(p('/versions'), token)).body.versions.length, 2);
  });

  it('restores a version and keeps a backup of what it replaced', async () => {
    await save('main.tex', DOC('Unsaved work in progress.'));
    const before = (await t.api.get(p('/files/content?path=main.tex'), token)).body.file.version;

    const res = await t.api.post(p(`/versions/${v1}/restore`), undefined, token);
    assert.equal(res.status, 200);
    assert.equal(res.body.backup.kind, 'restore');

    const main = await t.api.get(p('/files/content?path=main.tex'), token);
    assert.match(main.body.file.content, /Version one/);
    assert.ok(main.body.file.version > before, 'changed files get a higher version number');
    assert.equal((await t.api.get(p('/files/content?path=notes/todo.txt'), token)).body.file.content, 'first note');
    assert.equal((await t.api.get(p('/files/content?path=extra.tex'), token)).status, 404);

    // The backup really holds the work that was replaced.
    const backup = await t.api.get(p(`/versions/${res.body.backup.id}/file?path=main.tex`), token);
    assert.match(backup.body.file.content, /Unsaved work in progress/);

    // Restoring when the current state is already saved makes no second backup.
    const again = await t.api.post(p(`/versions/${v1}/restore`), undefined, token);
    assert.equal(again.body.backup, null);
  });

  it('exports a version as a zip, renames and deletes versions', async () => {
    const zip = await t.api.get(p(`/versions/${v1}/export.zip`), token);
    assert.deepEqual(Object.keys(unzipSync(zip.raw)).sort(), ['main.tex', 'notes/', 'notes/todo.txt']);

    const list = (await t.api.get(p('/versions'), token)).body.versions;
    const auto = list.find((v: any) => v.kind === 'auto');
    const named = await t.api.patch(p(`/versions/${auto.id}`), { label: 'Submitted' }, token);
    assert.equal(named.body.version.kind, 'manual');

    const blobsBefore = (await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM history_blobs')).rows[0]!.n;
    for (const v of list) assert.equal((await t.api.del(p(`/versions/${v.id}`), token)).status, 204);
    const blobsAfter = (await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM history_blobs')).rows[0]!.n;
    assert.ok(blobsBefore > 0);
    assert.equal(blobsAfter, 0, 'stored contents are cleaned up with their versions');
  });
});

describe('share links', () => {
  let t: TestApp;
  let token = '';
  let projectId = '';
  before(async () => {
    t = await createTestApp({ PUBLIC_URL: 'https://openleaf.example.com/' });
    token = (await signUp(t, 'alice')).token;
    projectId = await newProject(t, token, 'For my supervisor');
  });
  after(() => t.destroy());

  it('gives read-only access to the latest PDF without an account', async () => {
    const created = await t.api.post(`/api/projects/${projectId}/share-links`, { label: 'Supervisor' }, token);
    assert.equal(created.status, 201);
    assert.match(created.body.pdfUrl, /^https:\/\/openleaf\.example\.com\/api\/shared\/ols_[\w-]+\/output\.pdf$/);
    const base = `/api/shared/${created.body.token}`;

    const early = await t.api.get(base);
    assert.equal(early.body.hasPdf, false);
    assert.equal((await t.api.get(`${base}/output.pdf`)).status, 404);

    await t.api.post(`/api/projects/${projectId}/compile`, {}, token);
    const info = await t.api.get(base);
    assert.deepEqual([info.body.project.name, info.body.hasPdf], ['For my supervisor', true]);
    const pdf = await t.api.get(`${base}/output.pdf`);
    assert.equal(pdf.status, 200);
    assert.ok(isPdf(pdf.raw));

    // The link gives access to nothing else.
    assert.equal((await t.api.get(`/api/projects/${projectId}/files`, created.body.token)).status, 401);

    const list = await t.api.get(`/api/projects/${projectId}/share-links`, token);
    assert.equal(list.body.links.length, 1);
    assert.ok(list.body.links[0].lastUsedAt);

    assert.equal((await t.api.del(`/api/projects/${projectId}/share-links/${created.body.link.id}`, token)).status, 204);
    assert.equal((await t.api.get(`${base}/output.pdf`)).status, 404);
    assert.equal((await t.api.get('/api/shared/ols_not-a-real-token')).status, 404);
  });
});

describe('built-in templates', () => {
  let t: TestApp;
  let token = '';
  before(async () => {
    t = await createTestApp();
    token = (await signUp(t, 'alice')).token;
  });
  after(() => t.destroy());

  for (const template of ['article', 'report', 'beamer', 'notes', 'assignment']) {
    it(`"${template}" compiles cleanly`, async () => {
      const created = await t.api.post(`/api/templates/${template}/projects`, { name: `Test of ${template} & Co_1`, author: 'A. Student' }, token);
      assert.equal(created.status, 201);
      const res = await t.api.post(`/api/projects/${created.body.project.id}/compile`, {}, token);
      const c = res.body.compile;
      assert.equal(c.status, 'success', JSON.stringify(c.diagnostics));
      assert.equal(c.errorCount, 0);
      const undefinedRefs = c.diagnostics.filter((d: any) => /undefined/i.test(d.message));
      assert.deepEqual(undefinedRefs, []);
    });
  }
});
