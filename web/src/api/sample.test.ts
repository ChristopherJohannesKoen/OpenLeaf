import { describe, expect, it } from 'vitest';
import { SampleApi } from './sample';

describe('the sample back end', () => {
  it('has a library whose first project fails where its source says it should', async () => {
    const api = new SampleApi();
    const projects = await api.listProjects();
    expect(projects.map((p) => p.name)).toEqual(['On measure', 'Thesis', 'Lecture notes, week 9', 'Report, second draft']);
    const first = projects[0]!;
    const compile = await api.latestCompile(first.id);
    const main = await api.readText(first.id, 'main.tex');
    const error = compile!.diagnostics!.find((d) => d.level === 'error')!;
    expect(main.content.split('\n')[error.line! - 1]).toContain('{fig/cover-2}');
  });

  it('compiles clean once the two slips are corrected, and refuses a stale save', async () => {
    const api = new SampleApi();
    const id = (await api.listProjects())[0]!.id;
    const main = await api.readText(id, 'main.tex');
    const fixed = main.content.replace('{fig/cover-2}', '{fig/cover-02}').replace('{lem:nul}', '{lem:null}');
    await api.saveText(id, 'main.tex', fixed, { baseVersion: main.version });
    const compile = await api.compile(id);
    expect(compile).toMatchObject({ status: 'success', errorCount: 0, warningCount: 0 });
    await expect(api.saveText(id, 'main.tex', 'x', { baseVersion: main.version })).rejects.toMatchObject({ code: 'version_conflict' });
  });

  it('keeps versions, compares them with now and restores them', async () => {
    const api = new SampleApi();
    const id = (await api.listProjects())[0]!.id;
    const versions = await api.listVersions(id);
    const outlineOnly = versions.find((v) => v.label === 'first outline')!;
    const changes = await api.versionChanges(id, outlineOnly.id);
    expect(changes.find((c) => c.path === 'refs.bib')?.status).toBe('added');
    expect((await api.versionDiff(id, outlineOnly.id, 'main.tex')).patch).toContain('+\\begin{abstract}');
    await api.restoreVersion(id, outlineOnly.id);
    expect((await api.listFiles(id)).files.map((f) => f.path)).toEqual(['main.tex', 'preamble.tex']);
    expect((await api.listVersions(id))[0]!.label).toBe('Before restoring an earlier version');
  });
});
