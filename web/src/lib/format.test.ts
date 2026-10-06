import { describe, expect, it } from 'vitest';
import { keptApart, shownAs, when } from './format';

describe('keptApart', () => {
  it('says nothing when the service says nothing', () => {
    expect(keptApart(undefined)).toBe('');
  });
  it('goes by the network first', () => {
    expect(keptApart({ namespaces: false, noNetwork: false })).toBe('A compile shares the service’s network.');
    expect(keptApart({ namespaces: false, noNetwork: true })).toBe('A compile runs without network.');
    expect(keptApart({ namespaces: false, noNetwork: true, narrowFiles: true })).toMatch(/without network and sees only TeX/);
  });
  it('reads an older service, which reports only namespaces', () => {
    expect(keptApart({ namespaces: true })).toBe('A compile runs without network.');
    expect(keptApart({ namespaces: false })).toBe('A compile shares the service’s network.');
  });
});

describe('when', () => {
  const now = new Date(2026, 9, 6, 15, 0);
  it('writes a date ahead of today plainly, with the year when it differs', () => {
    expect(when(new Date(2027, 3, 5), now)).toBe('5 Apr 2027');
    expect(when(new Date(2026, 11, 24), now)).toBe('24 Dec');
  });
});

describe('shownAs', () => {
  it('opens pictures and PDFs, and nothing that could carry script', () => {
    expect(shownAs('figs/plot.PNG')).toBe('image/png');
    expect(shownAs('paper.pdf')).toBe('application/pdf');
    expect(shownAs('figure.svg')).toBeNull();
    expect(shownAs('page.html')).toBeNull();
    expect(shownAs('README')).toBeNull();
  });
});
