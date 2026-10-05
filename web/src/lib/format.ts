// How OpenLeaf writes times, dates and sizes: 24-hour times, "2 Oct", no relative fuzz beyond yesterday.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const two = (n: number) => String(n).padStart(2, '0');

export function clock(when: string | Date | null | undefined): string {
  if (!when) return '';
  const d = new Date(when);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** "today 14:07", "yesterday", "2 Oct", "2 Oct 2025". */
export function when(value: string | Date | null | undefined, now = new Date()): string {
  if (!value) return '';
  const d = new Date(value);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0) return `today ${clock(d)}`;
  if (days === 1) return 'yesterday';
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

export function seconds(ms: number | null | undefined): string {
  if (ms == null) return '';
  return `${(ms / 1000).toFixed(1)} s`;
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}

export function numberWord(n: number): string {
  const words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
  return words[n] ?? String(n);
}

/** Hands a blob to the browser as a download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}
