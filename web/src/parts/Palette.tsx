// The command palette: one field for commands, files and labels. Ctrl K opens it.
import { useEffect, useMemo, useState } from 'react';
import { Menu, type MenuItem } from '../ds';

export interface PaletteEntry {
  group: 'commands' | 'files' | 'labels' | 'sections';
  label: string;
  keys?: string;
  run: () => void;
}

export function Palette({ entries, onClose }: { entries: PaletteEntry[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const match = entries.filter((e) => words.every((w) => e.label.toLowerCase().includes(w)));
    const limits: Record<PaletteEntry['group'], number> = { commands: words.length ? 8 : 9, files: 8, sections: 6, labels: 6 };
    const out: PaletteEntry[] = [];
    for (const group of ['commands', 'files', 'sections', 'labels'] as const) {
      out.push(...match.filter((e) => e.group === group).slice(0, limits[group]));
    }
    return out;
  }, [entries, query]);

  useEffect(() => setIndex(0), [query]);

  const items: MenuItem[] = [];
  let last: string | null = null;
  shown.forEach((entry, i) => {
    if (entry.group !== last) { items.push({ heading: entry.group }); last = entry.group; }
    items.push({ label: entry.label, keys: entry.keys, active: i === index, onSelect: () => { onClose(); entry.run(); } });
  });
  if (shown.length === 0) items.push({ heading: 'nothing by that name' });

  return (
    <>
      <div className="ol-scrim" onMouseDown={onClose} />
      <div className="ol-palette" role="dialog" aria-label="Commands, files and labels">
        <Menu
          items={items} query={query} onQuery={setQuery} placeholder="A command, a file, a label" autoFocus width={560}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(shown.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); const entry = shown[index]; if (entry) { onClose(); entry.run(); } }
          }}
        />
      </div>
    </>
  );
}
