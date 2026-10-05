// The Proof pane's pages: the compiled PDF drawn onto sheets with pdf.js.
// Nothing from the interface is drawn on the paper; the diple that marks the caret stands on the desk.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Proof, Sheet } from '../ds';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface SyncMark { page: number; /** Points from the top of the page. */ v: number }

interface PageSize { width: number; height: number }

interface Props {
  /** The PDF's bytes. A new buffer means a new proof. */
  data: ArrayBuffer | null;
  /** 1 fits the pane's width; other values scale from there. */
  zoom: number;
  sync: SyncMark | null;
  /** Bring the synced line into view when this number changes. */
  reveal: number;
  onPages?: (count: number) => void;
  /** A double click on a page, in PDF points from its top-left corner. */
  onPick?: (page: number, h: number, v: number) => void;
  empty?: React.ReactNode;
}

function Page(props: {
  doc: PDFDocumentProxy; number: number; size: PageSize; width: number; total: number;
  sync: number | undefined; onPick?: Props['onPick'];
}) {
  const { doc, number, size, width, total, sync, onPick } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(number <= 2);

  // Draw a page only once it is near the window; a long proof then opens at once.
  useEffect(() => {
    const el = holder.current;
    if (!el || near) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { rootMargin: '600px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near || width <= 0) return;
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<unknown> } | null = null;
    void doc.getPage(number).then((page) => {
      if (cancelled || !canvas.current) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
      const viewport = page.getViewport({ scale: (width / size.width) * ratio });
      const el = canvas.current;
      el.width = Math.floor(viewport.width);
      el.height = Math.floor(viewport.height);
      const context = el.getContext('2d');
      if (!context) return;
      task = page.render({ canvasContext: context, viewport });
      task.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, number, near, width, size.width]);

  return (
    <div ref={holder} className="ol-proof__page" data-page={number}>
      <Sheet
        folio={`${number} / ${total}`} ratio={size.width / size.height}
        sync={sync === undefined ? undefined : Math.max(0, Math.min(100, (sync / size.height) * 100))}
        onDoubleClick={onPick ? (e) => {
          const box = e.currentTarget.getBoundingClientRect();
          onPick(number, ((e.clientX - box.left) / box.width) * size.width, ((e.clientY - box.top) / box.height) * size.height);
        } : undefined}
      >
        <canvas ref={canvas} className="ol-sheet__canvas" aria-label={`Page ${number} of the proof`} />
      </Sheet>
    </div>
  );
}

export function ProofView({ data, zoom, sync, reveal, onPages, onPick, empty }: Props) {
  const desk = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [deskWidth, setDeskWidth] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!data) { setDoc(null); setSizes([]); return; }
    let cancelled = false;
    setFailed(null);
    // pdf.js takes the buffer for its worker; hand it a copy so the caller's stays whole.
    const loading = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
    void loading.promise
      .then(async (loaded) => {
        const list: PageSize[] = [];
        for (let n = 1; n <= loaded.numPages; n++) {
          const page = await loaded.getPage(n);
          const view = page.getViewport({ scale: 1 });
          list.push({ width: view.width, height: view.height });
        }
        if (cancelled) { void loaded.destroy(); return; }
        setSizes(list);
        setDoc((previous) => { void previous?.destroy(); return loaded; });
        onPages?.(loaded.numPages);
      })
      .catch((err: unknown) => { if (!cancelled) setFailed(err instanceof Error ? err.message : 'The proof could not be read.'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useLayoutEffect(() => {
    const el = desk.current;
    if (!el) return;
    const measure = () => setDeskWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Bring the caret's line into view when asked.
  useEffect(() => {
    if (!reveal || !sync || !desk.current) return;
    const page = desk.current.querySelector<HTMLElement>(`[data-page="${sync.page}"]`);
    const size = sizes[sync.page - 1];
    if (!page || !size) return;
    const top = page.offsetTop + (sync.v / size.height) * page.clientHeight - desk.current.clientHeight / 2;
    desk.current.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  // A sheet fills the desk less a line of padding on either side, times the zoom.
  const sheetWidth = Math.max(160, Math.round((deskWidth - 60) * zoom));

  return (
    <Proof ref={desk} width={sheetWidth}>
      {failed && <p className="ol-empty">{failed}</p>}
      {!failed && (!doc || sizes.length === 0) && empty}
      {doc && sizes.map((size, i) => (
        <Page
          key={i} doc={doc} number={i + 1} size={size} width={sheetWidth} total={sizes.length}
          sync={sync && sync.page === i + 1 ? sync.v : undefined} onPick={onPick}
        />
      ))}
    </Proof>
  );
}
