import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { resolveModules, type OpenLeafModule } from '../src/core/modules.js';
import { looksLikeText, normalizePath, parentFolders } from '../src/core/paths.js';
import { deepDefaults, latexEscape, mergePatch } from '../src/core/util.js';
import { parseBibLog, parseLatexLog } from '../src/modules/compile/log-parser.js';

describe('paths', () => {
  it('normalises ordinary paths', () => {
    assert.equal(normalizePath('chapters/intro.tex'), 'chapters/intro.tex');
    assert.equal(normalizePath('./main.tex'), 'main.tex');
    assert.equal(normalizePath('figures/'), 'figures');
  });

  it('rejects anything that could escape the project', () => {
    for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../../b', 'a//b', 'a\\b', '', '   ', 'a/./b', 'nul\u0000l.tex']) {
      assert.throws(() => normalizePath(bad), /./, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it('lists parent folders', () => {
    assert.deepEqual(parentFolders('a/b/c.tex'), ['a', 'a/b']);
    assert.deepEqual(parentFolders('main.tex'), []);
  });

  it('tells text from binary', () => {
    assert.equal(looksLikeText('main.tex', Buffer.from('\\documentclass{article}'), 1e6), true);
    assert.equal(looksLikeText('fig.png', Buffer.from('plain'), 1e6), false);
    assert.equal(looksLikeText('data.dat', Buffer.from([0xff, 0xfe, 0x00, 0x01]), 1e6), false);
    assert.equal(looksLikeText('big.txt', Buffer.alloc(100, 'a'), 10), false);
  });
});

describe('util', () => {
  it('applies JSON merge patches', () => {
    assert.deepEqual(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 }, f: [1] }), {
      a: 1,
      b: { d: 3, e: 4 },
      f: [1],
    });
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
    assert.deepEqual(mergePatch({ a: 1 }, hostile), { a: 1, ok: 1 });
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it('merges overrides onto defaults', () => {
    assert.deepEqual(deepDefaults({ a: { b: 1, c: 2 }, list: [1] }, { a: { c: 3 }, list: [] }), {
      a: { b: 1, c: 3 },
      list: [],
    });
  });

  it('escapes LaTeX special characters', () => {
    assert.equal(latexEscape('R&D: 50% of $x_1'), 'R\\&D: 50\\% of \\$x\\_1');
  });
});

describe('config', () => {
  it('requires a database URL', () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL/);
  });

  it('picks invite mode when an invite code is set, and detects TLS', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://u:p@dpg-abc.frankfurt-postgres.render.com/db', INVITE_CODE: 'x' });
    assert.equal(c.registration, 'invite');
    assert.equal(c.databaseSsl, true);
    assert.equal(loadConfig({ DATABASE_URL: 'postgres://u:p@dpg-abc-a/db' }).databaseSsl, false);
    assert.equal(loadConfig({ DATABASE_URL: 'postgres://u:p@dpg-abc-a/db' }).registration, 'first-user');
  });
});

describe('module resolution', () => {
  const mod = (name: string, extra: Partial<OpenLeafModule> = {}): OpenLeafModule => ({
    name,
    description: name,
    register() {},
    ...extra,
  });
  const all = [
    mod('auth', { core: true }),
    mod('projects', { core: true, dependsOn: ['auth'] }),
    mod('compile', { dependsOn: ['projects'] }),
    mod('share', { dependsOn: ['compile'] }),
  ];

  it('orders modules by dependency and keeps core modules', () => {
    const names = resolveModules(all, { enabledModules: null, disabledModules: ['share'] }).map((m) => m.name);
    assert.deepEqual(names, ['auth', 'projects', 'compile']);
    assert.deepEqual(
      resolveModules(all, { enabledModules: ['compile'], disabledModules: [] }).map((m) => m.name),
      ['auth', 'projects', 'compile'],
    );
  });

  it('explains a broken dependency', () => {
    assert.throws(
      () => resolveModules(all, { enabledModules: null, disabledModules: ['compile'] }),
      /"share" needs module "compile"/,
    );
    assert.throws(() => resolveModules(all, { enabledModules: null, disabledModules: ['nope'] }), /Unknown module/);
  });
});

describe('LaTeX log parser', () => {
  const log = [
    'This is pdfTeX, Version 3.141592653-2.6-1.40.25 (TeX Live 2023/Debian)',
    '(./main.tex',
    'LaTeX2e <2023-11-01> patch level 1',
    '(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls',
    'Document Class: article 2023/05/17 v1.4n Standard LaTeX document class',
    ') (./main.aux)',
    '',
    "LaTeX Warning: Reference `sec:missing' on page 1 undefined on input line 7.",
    '',
    ' (./chapters/one.tex',
    './chapters/one.tex:2: Undefined control sequence.',
    'l.2 ... chapter one with $x^2$ and \\undefinedmacro',
    '                                                    here.',
    'The control sequence at the end of the top line',
    '',
    ') [1]',
    'Overfull \\hbox (154.6pt too wide) in paragraph at lines 10--12',
    '[]\\T1/cmr/m/n/10 A very long line',
    '',
    'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
    "(hyperref)                removing `math shift' on input line 14.",
    '',
    "! LaTeX Error: File `missing.sty' not found.",
    '',
    'Type X to quit or <RETURN> to proceed,',
    'l.15 \\usepackage',
    '               {other}',
    '',
    'LaTeX Warning: There were undefined references.',
    ' )',
  ].join('\n');

  it('finds errors, warnings and box problems with their files and lines', () => {
    const d = parseLatexLog(log, { workdir: '/tmp/x' });
    const errors = d.filter((x) => x.level === 'error');
    assert.equal(errors.length, 2);
    assert.deepEqual(
      { file: errors[0]!.file, line: errors[0]!.line, message: errors[0]!.message },
      { file: 'chapters/one.tex', line: 2, message: 'Undefined control sequence.' },
    );
    assert.match(errors[0]!.context ?? '', /undefinedmacro/);
    assert.equal(errors[1]!.message, "File `missing.sty' not found.");
    assert.equal(errors[1]!.file, 'main.tex');
    assert.equal(errors[1]!.line, 15);

    const warnings = d.filter((x) => x.level === 'warning');
    assert.equal(warnings.length, 3);
    assert.equal(warnings[0]!.line, 7);
    assert.equal(warnings[0]!.file, 'main.tex');
    assert.match(warnings[1]!.message, /^hyperref: Token not allowed.*removing `math shift'/);
    assert.equal(warnings[1]!.line, 14);

    const boxes = d.filter((x) => x.level === 'typesetting');
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0]!.line, 10);
    assert.equal(boxes[0]!.file, 'main.tex');
  });

  it('only reports "Emergency stop" when nothing more specific was found', () => {
    const specific = parseLatexLog('./a.tex:3: Missing $ inserted.\nl.3 x_1\n\n! Emergency stop.\n');
    assert.deepEqual(specific.map((x) => x.message), ['Missing $ inserted.']);
    const bare = parseLatexLog('(./a.tex\n! Emergency stop.\nl.9 \\end\n');
    assert.equal(bare.length, 1);
    assert.equal(bare[0]!.line, 9);
  });

  it('parses BibTeX and Biber logs', () => {
    const bibtex = parseBibLog(
      [
        'This is BibTeX, Version 0.99d',
        'Warning--I didn\'t find a database entry for "nobody2020"',
        "I was expecting a `,' or a `}'---line 7 of file refs.bib",
        "I couldn't open database file missing.bib",
        '---line 12 of file main.aux',
      ].join('\n'),
    );
    assert.equal(bibtex.length, 3);
    assert.equal(bibtex[0]!.level, 'warning');
    assert.deepEqual([bibtex[1]!.file, bibtex[1]!.line, bibtex[1]!.level], ['refs.bib', 7, 'error']);
    assert.deepEqual([bibtex[2]!.file, bibtex[2]!.line], ['main.aux', 12]);

    const biber = parseBibLog(
      [
        '[0] Config.pm:307> INFO - This is Biber 2.19',
        "[90] Biber.pm:4419> WARN - I didn't find a database entry for 'nobody' (section 0)",
        '[91] Utils.pm:411> ERROR - BibTeX subsystem: refs.bib_123.utf8, line 4, syntax error',
      ].join('\n'),
    );
    assert.deepEqual(biber.map((x) => x.level), ['warning', 'error']);
    assert.equal(biber[1]!.line, 4);
  });
});
