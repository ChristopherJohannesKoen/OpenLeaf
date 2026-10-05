// The Library: every project and the state it was left in.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Compile, Project, Template } from '../api/types';
import { useApp } from '../app/context';
import { Button, Catalogue, Confirm, Field, Menu, Rail, Wordmark, type CatalogueRow, type MenuItem } from '../ds';
import { numberWord, saveBlob, slug, when } from '../lib/format';
import { go } from '../lib/router';
import { sayCompile } from '../lib/state';
import { failure, Notice, type NoticeData } from '../parts/Notice';
import { Popover } from '../parts/Popover';
import { Select } from '../parts/Select';

type View = 'active' | 'archived' | 'trashed';
interface Extra { compile: Compile | null; note: string }

const TITLE: Record<View, string> = { active: 'Library', archived: 'Archive', trashed: 'Trash' };

export function Library() {
  const { api, info } = useApp();
  const [view, setView] = useState<View>('active');
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [extras, setExtras] = useState<Record<string, Extra>>({});
  const [templates, setTemplates] = useState<Template[]>([]);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState('blank');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const zipInput = useRef<HTMLInputElement>(null);

  const hasHistory = info?.modules.some((m) => m.name === 'history') ?? true;
  const hasCompile = info?.modules.some((m) => m.name === 'compile') ?? true;

  const load = useCallback(async () => {
    try {
      const list = await api.listProjects(view);
      setProjects(list);
      // What each project was left as: asked for one by one, a few at a time, so the list shows at once.
      const queue = [...list];
      const worker = async () => {
        for (let p = queue.shift(); p; p = queue.shift()) {
          const id = p.id;
          const description = p.description;
          const [compile, versions] = await Promise.all([
            hasCompile ? api.latestCompile(id).catch(() => null) : Promise.resolve(null),
            description || !hasHistory ? Promise.resolve([]) : api.listVersions(id).catch(() => []),
          ]);
          const note = description || versions.find((v) => v.label)?.label || '';
          setExtras((e) => ({ ...e, [id]: { compile, note } }));
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    } catch (err) {
      setProjects([]);
      setNotice({ ...failure(err, 'read the library'), actions: [{ label: 'Try again', run: () => { setNotice(null); void load(); } }] });
    }
  }, [api, view, hasCompile, hasHistory]);

  useEffect(() => {
    setProjects(null);
    void load();
  }, [load]);

  useEffect(() => {
    api.listTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, [api]);

  const act = async (doing: string, run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
    } catch (err) {
      setNotice(failure(err, doing));
    } finally {
      setBusy(false);
    }
  };

  const create = () => act('create the project', async () => {
    const name = newName.trim();
    if (!name) return;
    const project = newTemplate === 'blank' ? await api.createProject({ name }) : await api.createFromTemplate(newTemplate, { name });
    go({ name: 'project', id: project.id });
  });

  const importZip = (file: File) => act('read that zip', async () => {
    const project = await api.importZip(file);
    go({ name: 'project', id: project.id });
  });

  const rows: CatalogueRow[] = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (projects ?? [])
      .filter((p) => words.every((w) => `${p.name} ${p.description} ${p.tags.join(' ')}`.toLowerCase().includes(w)))
      .map((p) => {
        const extra = extras[p.id];
        const said = sayCompile(extra ? extra.compile : undefined);
        const pages = (p.settings.openleaf as { pages?: unknown } | undefined)?.pages;
        return {
          id: p.id, title: p.name, address: `${p.mainFile} · ${p.engine}`, tone: said.tone, state: said.words,
          pages: typeof pages === 'number' ? pages : null, edited: when(p.updatedAt), note: extra?.note ?? p.description,
        };
      });
  }, [projects, extras, query]);

  const menuItems = (id: string): MenuItem[] => {
    const project = projects?.find((p) => p.id === id);
    if (!project) return [];
    const close = (run: () => void) => () => { setMenu(null); run(); };
    const reload = () => load();
    if (view === 'trashed') {
      return [
        { label: 'Take out of the trash', onSelect: close(() => void act('restore the project', async () => { await api.moveProject(id, 'restore'); await reload(); })) },
        { rule: true },
        { label: 'Delete for good', tone: 'broken', onSelect: close(() => setDeleting(project)) },
      ];
    }
    return [
      { label: 'Open', onSelect: close(() => go({ name: 'project', id })) },
      { label: 'Rename', onSelect: close(() => setRenaming({ id, name: project.name })) },
      { label: 'Duplicate', onSelect: close(() => void act('duplicate the project', async () => { await api.duplicateProject(id); await reload(); })) },
      { label: 'Download as a zip', onSelect: close(() => void act('download the project', async () => saveBlob(await api.exportZip(id), `${slug(project.name)}.zip`))) },
      { rule: true },
      view === 'archived'
        ? { label: 'Take out of the archive', onSelect: close(() => void act('unarchive the project', async () => { await api.moveProject(id, 'unarchive'); await reload(); })) }
        : { label: 'Archive', onSelect: close(() => void act('archive the project', async () => { await api.moveProject(id, 'archive'); await reload(); })) },
      { label: 'Move to the trash', tone: 'broken', onSelect: close(() => void act('move the project to the trash', async () => { await api.moveProject(id, 'trash'); await reload(); })) },
    ];
  };

  const total = projects?.length ?? 0;
  const lede =
    projects === null ? 'Reading the library.'
    : view === 'active'
      ? total === 0
        ? 'No projects yet. Start one, or bring one in as a zip.'
        : api.kind === 'sample'
          ? `${numberWord(total)} sample ${total === 1 ? 'project' : 'projects'}. Nothing here is kept; it starts over when the page is reloaded.`
          : `${numberWord(total)} ${total === 1 ? 'project' : 'projects'}, kept on your own service.`
      : view === 'archived'
        ? total === 0 ? 'Nothing is set aside.' : `${numberWord(total)} set aside. ${total === 1 ? 'It is' : 'They are'} kept, and out of the way.`
        : total === 0 ? 'The trash is empty.' : `${numberWord(total)} in the trash. ${total === 1 ? 'It stays' : 'They stay'} here until deleted for good.`;

  return (
    <div className="ol-screen">
      <Rail active="L" modules={[{ letter: 'L', label: 'Library' }]} foot={[{ letter: 'M', label: 'Modules' }]} onSelect={(l) => l === 'M' && go({ name: 'modules' })} />
      <main className="ol-screen__page">
        <Wordmark />
        <h1 className="ol-screen__title ol-screen__title--first">{TITLE[view]}</h1>
        <p className="ol-screen__lede">{lede}</p>

        <div className="ol-screen__bar">
          <Field label="Find" value={query} onChange={setQuery} placeholder="A title or a word from its note" />
          {view === 'active' ? (
            <>
              <Button variant="bare" onClick={() => setView('archived')}>Archive</Button>
              <Button variant="bare" onClick={() => setView('trashed')}>Trash</Button>
              <Button onClick={() => zipInput.current?.click()} disabled={busy}>Import a zip</Button>
              <Button variant="ink" onClick={() => { setCreating(true); setNewName(''); }} disabled={busy}>New project</Button>
            </>
          ) : (
            <Button onClick={() => setView('active')}>Back to the Library</Button>
          )}
          <input
            ref={zipInput} type="file" accept=".zip,application/zip" hidden
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importZip(file); }}
          />
        </div>

        {notice && <Notice notice={notice} onDismiss={() => setNotice(null)} />}

        {creating && (
          <form className="ol-confirm ol-strip" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <Field label="Title" value={newName} onChange={setNewName} autoFocus placeholder="What the project is called" onEscape={() => setCreating(false)} />
            <Select
              label="Start from" value={newTemplate} onChange={setNewTemplate}
              options={[{ value: 'blank', label: 'A blank article' }, ...templates.map((t) => ({ value: t.id, label: t.name }))]}
            />
            <div className="ol-confirm__actions">
              <Button onClick={() => setCreating(false)}>Not now</Button>
              <Button variant="ink" type="submit" disabled={busy || !newName.trim()}>Create</Button>
            </div>
          </form>
        )}

        {renaming && (
          <form
            className="ol-confirm ol-strip"
            onSubmit={(e) => {
              e.preventDefault();
              const { id, name } = renaming;
              if (!name.trim()) return;
              void act('rename the project', async () => { await api.patchProject(id, { name: name.trim() }); setRenaming(null); await load(); });
            }}
          >
            <Field label="Title" value={renaming.name} onChange={(name) => setRenaming({ ...renaming, name })} autoFocus onEscape={() => setRenaming(null)} />
            <div className="ol-confirm__actions">
              <Button onClick={() => setRenaming(null)}>Keep the old one</Button>
              <Button variant="ink" type="submit" disabled={busy}>Rename</Button>
            </div>
          </form>
        )}

        {deleting && (
          <Confirm
            question={`Delete ${deleting.name} for good?`}
            detail="Its files, proofs and history go with it. This cannot be undone."
            confirmLabel="Delete" cancelLabel="Keep"
            onCancel={() => setDeleting(null)}
            onConfirm={() => { const id = deleting.id; setDeleting(null); void act('delete the project', async () => { await api.deleteProject(id); await load(); }); }}
          />
        )}

        {projects !== null && rows.length > 0 && (
          <Catalogue projects={rows} onOpen={view === 'trashed' ? undefined : (id) => go({ name: 'project', id })} onMenu={(id, anchor) => setMenu({ id, anchor })} />
        )}
        {projects !== null && total > 0 && rows.length === 0 && <p className="ol-empty">Nothing here by that name.</p>}

        {menu && (
          <Popover anchor={menu.anchor} align="end" onClose={() => setMenu(null)}>
            <Menu items={menuItems(menu.id)} width={240} />
          </Popover>
        )}
      </main>
    </div>
  );
}
