import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FsChange } from '../watch/events';
import { ConflictStore } from './conflictStore.svelte';
import { handleExternalChanges } from './externalChange';

interface Harness {
  store: ConflictStore;
  applied: string[];
  cleaned: string[];
  errors: unknown[];
  setEditor(contents: string): void;
  setDisk(path: string, contents: string): void;
  failRead(error: unknown): void;
  handle(changes: FsChange[]): Promise<void>;
}

const dirtyTab = { id: 'tab-1', path: 'notlar.md', dirty: true };
const cleanTab = { ...dirtyTab, dirty: false };

function harness(tab: { id: string; path: string; dirty: boolean }, initial = 'yerel'): Harness {
  const store = new ConflictStore();
  const applied: string[] = [];
  const cleaned: string[] = [];
  const errors: unknown[] = [];
  const disk = new Map<string, string>();
  let current = initial;
  let readError: unknown = null;

  store.bindEditor(tab.id, {
    contents: () => current,
    applyContents: (contents) => {
      current = contents;
      applied.push(contents);
    },
  });

  return {
    store,
    applied,
    cleaned,
    errors,
    setEditor: (contents) => {
      current = contents;
    },
    setDisk: (path, contents) => disk.set(path, contents),
    failRead: (error) => {
      readError = error;
    },
    handle: (changes) =>
      handleExternalChanges(changes, {
        tabs: () => [tab],
        conflicts: store,
        readFile: async (path) => {
          if (readError !== null) throw readError;
          const contents = disk.get(path);
          if (contents === undefined) throw new Error(`okunamadı: ${path}`);
          return contents;
        },
        markClean: (tabId) => cleaned.push(tabId),
        onError: (error) => errors.push(error),
      }),
  };
}

const modify = (path: string): FsChange => ({ path, kind: 'modify' });

describe('handleExternalChanges', () => {
  it('dirty sekmede bandı açar, editör içeriğini ve dirty işaretini korur', async () => {
    const h = harness(dirtyTab);
    h.setDisk('notlar.md', 'dış değişiklik');

    await h.handle([modify('notlar.md')]);

    expect(h.applied).toEqual([]);
    expect(h.cleaned).toEqual([]);
    expect(h.store.pending).toHaveLength(1);
    expect(h.store.pending[0].editorContents).toBe('yerel');
    expect(h.store.pending[0].diskContents).toBe('dış değişiklik');
    expect(h.store.editorContents('tab-1')).toBe('yerel');
  });

  it('temiz sekmede diski sessizce yükler ve dirty işaretini korur', async () => {
    const h = harness(cleanTab, 'eski');
    h.setDisk('notlar.md', 'yeni disk');

    await h.handle([modify('notlar.md')]);

    expect(h.applied).toEqual(['yeni disk']);
    expect(h.cleaned).toEqual(['tab-1']);
    expect(h.store.pending).toHaveLength(0);
  });

  it('arka plandaki temiz sekme de aynı partide yenilenir, etkin editör değişmez', async () => {
    const store = new ConflictStore();
    const disk = new Map([['notlar.md', 'yeni disk']]);
    const background = { id: 'tab-1', path: 'notlar.md', dirty: false };
    const active = { id: 'tab-2', path: 'diger.md', dirty: false };
    const backgroundState = { contents: 'eski' };
    const activeState = { contents: 'etkin içerik' };
    const cleaned: string[] = [];

    store.bindEditor('tab-1', {
      contents: () => backgroundState.contents,
      applyContents: (contents) => {
        backgroundState.contents = contents;
      },
    });
    store.bindEditor('tab-2', {
      contents: () => activeState.contents,
      applyContents: (contents) => {
        activeState.contents = contents;
      },
    });

    await handleExternalChanges([modify('notlar.md')], {
      tabs: () => [background, active],
      conflicts: store,
      readFile: async (path) => disk.get(path) ?? '',
      markClean: (tabId) => cleaned.push(tabId),
    });

    // Arka plan sekmesi etkinleştirilmeyi beklemeden disk içeriğini alır.
    expect(backgroundState.contents).toBe('yeni disk');
    expect(cleaned).toEqual(['tab-1']);
    // Etkin sekmenin içeriği ve durumu bu partiden etkilenmez.
    expect(activeState.contents).toBe('etkin içerik');
  });

  it('bant açıkken gelen yeni disk olayı yalnızca disk anlık görüntüsünü tazeler', async () => {
    const h = harness(dirtyTab);
    h.setDisk('notlar.md', 'ilk');
    await h.handle([modify('notlar.md')]);

    h.setEditor('yerel + devam');
    h.setDisk('notlar.md', 'ikinci');
    await h.handle([modify('notlar.md')]);

    expect(h.store.pending[0].diskContents).toBe('ikinci');
    expect(h.store.pending[0].editorContents).toBe('yerel + devam');
    expect(h.applied).toEqual([]);
  });

  it('editör bağlı değilse hiçbir içerik yazılmaz ve bant açılmaz', async () => {
    const store = new ConflictStore();
    const applied: string[] = [];
    const disk = new Map([['notlar.md', 'disk']]);

    await handleExternalChanges([modify('notlar.md')], {
      tabs: () => [dirtyTab],
      conflicts: store,
      readFile: async (path) => disk.get(path) ?? '',
      markClean: () => undefined,
    });

    expect(store.editorContents('tab-1')).toBeNull();
    expect(store.pending).toHaveLength(0);
    expect(applied).toEqual([]);
  });

  it('okuma hata verirse içerik değişmez, hata bildirilir', async () => {
    const h = harness(dirtyTab);
    h.failRead(new Error('okuma reddedildi'));

    await h.handle([modify('notlar.md')]);

    expect(h.errors).toHaveLength(1);
    expect(h.applied).toEqual([]);
    expect(h.store.pending).toHaveLength(0);
  });

  it('ilgisiz yollar ve silme olayları içerik okumaz', async () => {
    const h = harness(dirtyTab);
    let reads = 0;
    const store = new ConflictStore();
    store.bindEditor('tab-1', { contents: () => 'yerel', applyContents: () => undefined });

    await handleExternalChanges(
      [
        { path: 'baska.md', kind: 'modify' },
        { path: 'notlar.md', kind: 'remove' },
      ],
      {
        tabs: () => [dirtyTab],
        conflicts: store,
        readFile: async () => {
          reads += 1;
          return 'x';
        },
        markClean: () => undefined,
      },
    );

    expect(reads).toBe(0);
    expect(store.pending).toHaveLength(0);
    expect(h.applied).toEqual([]);
  });
});

describe('handleExternalChanges — 300 ms bütçesi', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('150 ms debounce sonrası temiz sekmeyi 300 ms içinde yeniler ve yükleme editörü kilitlemez', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const h = harness(cleanTab, 'eski');
    h.setDisk('notlar.md', 'diskteki yeni içerik');

    // Rust `watcher::DEBOUNCE`: olay ancak 150 ms'lik pencere kapandıktan sonra
    // frontend'e ulaşır; yenileme bu pencerenin üstüne ek süre eklememelidir.
    const delivered = new Promise<FsChange[]>((resolve) => {
      setTimeout(() => resolve([modify('notlar.md')]), 150);
    });
    await vi.advanceTimersByTimeAsync(150);
    const changes = await delivered;

    const pending = h.handle(changes);
    // Okuma sürerken editör içeriği okunabilir kalır: yenileme kilitlemez.
    expect(h.store.editorContents('tab-1')).toBe('eski');
    expect(h.applied).toEqual([]);

    await pending;

    // Tek atomik uygulama: yarım içerik hiç görünmez.
    expect(h.applied).toEqual(['diskteki yeni içerik']);
    // Yenileme ek bir zamanlayıcı beklemez; bütçe debounce + anlık uygulamadır.
    expect(vi.getTimerCount()).toBe(0);
    expect(Date.now() - started).toBeLessThanOrEqual(300);
  });
});
