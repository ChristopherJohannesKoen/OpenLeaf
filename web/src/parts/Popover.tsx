// A menu set beside the thing that opened it. It closes on Escape or a press anywhere else.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export function Popover({ anchor, onClose, children, align = 'start' }: { anchor: HTMLElement; onClose: () => void; children: ReactNode; align?: 'start' | 'end' }) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const b = box.current!.getBoundingClientRect();
    let left = align === 'end' ? a.right - b.width : a.left;
    let top = a.bottom + 5;
    left = Math.max(10, Math.min(left, window.innerWidth - b.width - 10));
    if (top + b.height > window.innerHeight - 10) top = Math.max(10, a.top - b.height - 5);
    setPlace({ left, top });
  }, [anchor, align]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose]);

  return (
    <div ref={box} className="ol-popover" style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: 'hidden' }}>
      {children}
    </div>
  );
}
