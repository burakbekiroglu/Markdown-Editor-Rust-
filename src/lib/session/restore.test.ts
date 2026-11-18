import { describe, expect, it } from 'vitest';

import { MAX_LISTED_MISSING, describeSkippedTabs, planRestore } from './restore';
import { createSessionData } from './schema';

function session(paths: string[], activePath: string | null = null) {
  return createSessionData({
    root: 'C:/notlar',
    tabs: paths.map((path) => ({ path, cursor: null, scroll: null })),
    activePath,
  });
}

describe('planRestore', () => {
  it('diskte olmayan dosyaları atlar ve missing listesinde toplar', async () => {
    const present = new Set(['var.md']);
    const plan = await planRestore(session(['var.md', 'yok.md']), async (path) =>
      present.has(path),
    );

    expect(plan.tabs).toEqual([{ path: 'var.md' }]);
    expect(plan.missing).toEqual(['yok.md']);
  });

  it('sekme sırasını korur ve etkin sekmeyi eşleştirir', async () => {
    const plan = await planRestore(session(['a.md', 'b.md', 'c.md'], 'b.md'), async () => true);

    expect(plan.tabs.map((tab) => tab.path)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(plan.activePath).toBe('b.md');
    expect(plan.missing).toEqual([]);
  });

  it('etkin sekme atlandıysa ilk var olan sekmeye düşer', async () => {
    const plan = await planRestore(
      session(['silinmis.md', 'b.md'], 'silinmis.md'),
      async (path) => path === 'b.md',
    );

    expect(plan.tabs.map((tab) => tab.path)).toEqual(['b.md']);
    expect(plan.activePath).toBe('b.md');
    expect(plan.missing).toEqual(['silinmis.md']);
  });

  it('etkin yol yoksa ilk sekmeye düşer', async () => {
    const plan = await planRestore(session(['a.md', 'b.md'], 'silinmis.md'), async () => true);

    expect(plan.activePath).toBe('a.md');
  });

  it('hiçbir dosya yoksa boş plan ve tüm yollar missing olur', async () => {
    const plan = await planRestore(session(['a.md', 'b.md'], 'a.md'), async () => false);

    expect(plan.tabs).toEqual([]);
    expect(plan.activePath).toBeNull();
    expect(plan.missing).toEqual(['a.md', 'b.md']);
  });

  it('sekme yoksa etkin yol null olur', async () => {
    const plan = await planRestore(session([], null), async () => true);

    expect(plan.tabs).toEqual([]);
    expect(plan.activePath).toBeNull();
    expect(plan.missing).toEqual([]);
  });
});

describe('describeSkippedTabs', () => {
  it('boş liste için boş metin döner', () => {
    expect(describeSkippedTabs([])).toBe('');
  });

  it('atlanan dosyaları sayısıyla birlikte listeler', () => {
    expect(describeSkippedTabs(['yok.md'])).toBe(
      '1 dosya artık bulunamadığı için açılmadı: yok.md',
    );
  });

  it('uzun listeyi ilk üç dosyada keser ve kalanı sayar', () => {
    const missing = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
    expect(describeSkippedTabs(missing)).toBe(
      `5 dosya artık bulunamadığı için açılmadı: ${missing
        .slice(0, MAX_LISTED_MISSING)
        .join(', ')} ve 2 dosya daha`,
    );
  });
});
