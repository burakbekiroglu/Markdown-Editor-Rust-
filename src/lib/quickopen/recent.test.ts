import { describe, expect, it } from 'vitest';

import {
  parseRecent,
  RECENT_LIMIT,
  RECENT_STORAGE_KEY,
  RecentFilesStore,
} from './recent.svelte';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('parseRecent', () => {
  it('boş veya bozuk değerde boş liste döner', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('')).toEqual([]);
    expect(parseRecent('{bozuk')).toEqual([]);
    expect(parseRecent('"metin"')).toEqual([]);
  });

  it('dizi dışı öğeleri süzer ve sınırı uygular', () => {
    const raw = JSON.stringify(['a.md', 42, '', null, 'b.md']);
    expect(parseRecent(raw)).toEqual(['a.md', 'b.md']);

    const many = JSON.stringify(Array.from({ length: 30 }, (_, index) => `f-${index}.md`));
    expect(parseRecent(many)).toHaveLength(RECENT_LIMIT);
  });
});

describe('RecentFilesStore', () => {
  it('kaydeder, tekrarları başa taşır ve depoya yazar', () => {
    const storage = fakeStorage();
    const store = new RecentFilesStore();
    store.hydrate(storage);

    store.record('a.md');
    store.record('b.md');
    store.record('a.md');

    expect(store.list).toEqual(['a.md', 'b.md']);
    expect(JSON.parse(storage.getItem(RECENT_STORAGE_KEY) ?? '[]')).toEqual(['a.md', 'b.md']);
  });

  it('kayıtlı listeyi bir kez okur', () => {
    const storage = fakeStorage({
      [RECENT_STORAGE_KEY]: JSON.stringify(['x.md', 'y.md']),
    });
    const store = new RecentFilesStore();
    store.hydrate(storage);
    expect(store.list).toEqual(['x.md', 'y.md']);

    storage.setItem(RECENT_STORAGE_KEY, JSON.stringify(['z.md']));
    store.hydrate(storage);
    expect(store.list).toEqual(['x.md', 'y.md']);
  });

  it('boş yolu yok sayar ve listeyi sınırlar', () => {
    const store = new RecentFilesStore();
    store.hydrate(fakeStorage());
    store.record('');
    expect(store.list).toEqual([]);

    for (let index = 0; index < RECENT_LIMIT + 5; index += 1) store.record(`f-${index}.md`);
    expect(store.list).toHaveLength(RECENT_LIMIT);
    expect(store.list[0]).toBe(`f-${RECENT_LIMIT + 4}.md`);
  });
});
