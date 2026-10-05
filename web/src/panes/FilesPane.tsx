// The Files pane: the project's files, and the few things done to them.
import { useMemo, useRef, useState } from 'react';
import type { FileMeta } from '../api/types';
import { Button, Confirm, Field, FileTree, Menu, Pane, type FileItem, type MenuItem } from '../ds';
import { Popover } from '../parts/Popover';

interface Props {
  files: FileMeta[];
  mainFile: string;
  active: string | null;
  /** Paths with changes not yet saved. */
  unsaved: ReadonlySet<string>;
  onOpen: (file: FileMeta) => void;
  onCreateFile: (path: string) => Promise<void>;
  onCreateFolder: (path: string) => Promise<void>;
  onMove: (from: string, to: string) => Promise<void>;
  onDelete: (path: string) => Promise<void>;
  onSetRoot: (path: string) => Promise<void>;
  onUpload: (files: File[], folder: string) => Promise<void>;
  onDownload: (path: string) => void;
}

type Asking =
  | { kind: 'file' | 'folder'; value: string }
  | { kind: 'rename'; from: string; value: string }
  | { kind: 'delete'; path: string; folder: boolean };

function treeItems(files: FileMeta[], closed: ReadonlySet<string>, mainFile: string, unsaved: ReadonlySet<string>): FileItem[] {
  const children = new Map<string, FileMeta[]>();
  for (const f of files) {
    const cut = f.path.lastIndexOf('/');
    const parent = cut < 0 ? '' : f.path.slice(0, cut);
    const list = children.get(parent) ?? [];
    list.push(f);
    children.set(parent, list);
  }
  const out: FileItem[] = [];
  const walk = (parent: string, depth: number) => {
    const list = (children.get(parent) ?? []).sort(
      (a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }),
    );
    for (const f of list) {
      const name = f.path.slice(f.path.lastIndexOf('/') + 1);
      const dir = f.kind === 'folder';
      const open = dir && !closed.has(f.path);
      out.push({ path: f.path, name, depth, dir, open, root: f.path === mainFile, status: unsaved.has(f.path) ? 'M' : undefined });
      if (open) walk(f.path, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

export function FilesPane(props: Props) {
  const { files, mainFile, active, unsaved } = props;
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<Asking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ item: FileItem; anchor: HTMLElement } | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const uploadTo = useRef('');

  const items = useMemo(() => treeItems(files, closed, mainFile, unsaved), [files, closed, mainFile, unsaved]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);

  // New things go beside the open file, or in the folder last pointed at.
  const folderOf = (path: string | null) => (path && path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');

  const run = async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
      setAsking(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    }
  };

  const submit = () => {
    if (!asking || asking.kind === 'delete') return;
    const value = asking.value.trim().replace(/^\/+|\/+$/g, '');
    if (!value) return;
    if (asking.kind === 'rename') {
      const from = asking.from;
      void run(() => props.onMove(from, value));
    } else if (asking.kind === 'file') void run(() => props.onCreateFile(value));
    else void run(() => props.onCreateFolder(value));
  };

  const menuItems = (item: FileItem): MenuItem[] => {
    const close = (work: () => void) => () => { setMenu(null); work(); };
    const meta = byPath.get(item.path);
    return [
      ...(item.dir
        ? [
            { label: 'New file here', onSelect: close(() => setAsking({ kind: 'file', value: `${item.path}/` })) },
            { label: 'Upload here', onSelect: close(() => { uploadTo.current = item.path; upload.current?.click(); }) },
          ]
        : [
            { label: 'Open', onSelect: close(() => meta && props.onOpen(meta)) },
            ...(meta?.kind === 'text' && /\.(tex|ltx)$/i.test(item.path) && item.path !== mainFile
              ? [{ label: 'Set as root', onSelect: close(() => void run(() => props.onSetRoot(item.path))) }]
              : []),
            { label: 'Download', onSelect: close(() => props.onDownload(item.path)) },
          ]),
      { label: 'Rename or move', onSelect: close(() => setAsking({ kind: 'rename', from: item.path, value: item.path })) },
      { rule: true },
      { label: 'Delete', tone: 'broken', onSelect: close(() => setAsking({ kind: 'delete', path: item.path, folder: !!item.dir })) },
    ];
  };

  return (
    <Pane
      letter="F" title="Files"
      actions={
        <>
          <Button variant="bare" onClick={() => setAsking({ kind: 'file', value: folderOf(active) })}>New</Button>
          <Button variant="bare" onClick={() => setAsking({ kind: 'folder', value: folderOf(active) })}>Folder</Button>
          <Button variant="bare" onClick={() => { uploadTo.current = folderOf(active).replace(/\/$/, ''); upload.current?.click(); }}>Upload</Button>
        </>
      }
    >
      <div className="ol-pane__scroll">
        {asking && asking.kind !== 'delete' && (
          <form className="ol-pane__ask" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <Field
              label={asking.kind === 'file' ? 'New file' : asking.kind === 'folder' ? 'New folder' : 'New name or place'}
              source autoFocus value={asking.value} error={error ?? undefined}
              placeholder={asking.kind === 'folder' ? 'fig' : 'ch2/method.tex'}
              onChange={(value) => setAsking({ ...asking, value })} onEscape={() => { setAsking(null); setError(null); }}
            />
            <div className="ol-pane__ask-actions">
              <Button variant="bare" onClick={() => { setAsking(null); setError(null); }}>Not now</Button>
              <Button type="submit">{asking.kind === 'rename' ? 'Move' : 'Create'}</Button>
            </div>
          </form>
        )}
        {asking?.kind === 'delete' && (
          <div className="ol-pane__ask">
            <Confirm
              question={`Delete ${asking.path}${asking.folder ? '/' : ''}?`}
              detail={
                (asking.folder ? 'Everything inside it goes too. ' : '') +
                'A saved version in History can bring it back; otherwise it is gone.' +
                (error ? ` ${error}` : '')
              }
              confirmLabel="Delete" cancelLabel="Keep"
              onCancel={() => { setAsking(null); setError(null); }}
              onConfirm={() => void run(() => props.onDelete(asking.path))}
            />
          </div>
        )}
        <FileTree
          items={items} active={active ?? undefined}
          onSelect={(item) => {
            if (item.dir) {
              setClosed((c) => { const next = new Set(c); if (next.has(item.path)) next.delete(item.path); else next.add(item.path); return next; });
            } else {
              const meta = byPath.get(item.path);
              if (meta) props.onOpen(meta);
            }
          }}
          onContext={(item, anchor) => setMenu({ item, anchor })}
        />
        {files.length === 0 && <p className="ol-empty ol-empty--pane">No files yet.</p>}
      </div>
      <input
        ref={upload} type="file" multiple hidden
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          e.target.value = '';
          if (picked.length) void run(() => props.onUpload(picked, uploadTo.current));
        }}
      />
      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)}>
          <Menu items={menuItems(menu.item)} width={220} />
        </Popover>
      )}
    </Pane>
  );
}
