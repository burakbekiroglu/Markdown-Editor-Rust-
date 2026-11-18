import { describe, expect, it } from 'vitest';

import { ConflictStore } from './conflictStore.svelte';
import { writeMine, type WriteMineDeps } from './writeMine';

const dirtyTab = { id: 'tab-1', path: 'notlar.md', dirty: true };

interface Harness {
  deps: WriteMineDeps;
  writes: { path: string; contents: string }[];
  saved: { tabId: string; hash: string | null; unchanged: boolean }[];
  errors: unknown[];
  store: ConflictStore;
  setEditor(contents: string): void;
  failWrite(error: unknown): void;
}

function harness(): Harness {
  const store = new ConflictStore();
  let current = 'benim sürümüm';
  const writes: { path: string; contents: string }[] = [];
  const saved: { tabId: string; hash: string | null; unchanged: boolean }[] = [];
  const errors: unknown[] = [];
  let writeError: unknown = null;

  store.bindEditor('tab-1', {
    contents: () => current,
    applyContents: (contents) => {
      current = contents;
    },
  });

  store.observe({
    tab: dirtyTab,
    editorContents: current,
    diskContents: 'diskteki sürüm',
    now: 1,
  });

  const deps: WriteMineDeps = {
    conflicts: store,
    write: async (path, contents) => {
      if (writeError !== null) throw writeError;
      writes.push({ path, contents });
      return { hash: 'hash-2' };
    },
    recordSaved: (tabId, hash, unchanged) => saved.push({ tabId, hash, unchanged }),
    onError: (error) => errors.push(error),
  };

  return {
    deps,
    writes,
    saved,
    errors,
    store,
    setEditor: (contents) => {
      current = contents;
    },
    failWrite: (error) => {
      writeError = error;
    },
  };
}

describe('writeMine', () => {
  it('editör içeriğini hash beklemeden diske yazar, bandı kapatır ve sekmeyi temizler', async () => {
    const h = harness();

    const outcome = await writeMine('tab-1', h.deps);

    expect(outcome).toBe('written');
    expect(h.writes).toEqual([{ path: 'notlar.md', contents: 'benim sürümüm' }]);
    expect(h.saved).toEqual([{ tabId: 'tab-1', hash: 'hash-2', unchanged: true }]);
    expect(h.store.pending).toHaveLength(0);
  });

  it('yazma sürerken yazmaya devam edildiyse sekme dirty kalır', async () => {
    const h = harness();
    const deps: WriteMineDeps = {
      ...h.deps,
      write: async (path, contents) => {
        h.writes.push({ path, contents });
        // Kullanıcı yazma sürerken yazmaya devam etti.
        h.setEditor('yazma sırasında eklenen metin');
        return { hash: 'hash-2' };
      },
    };

    await writeMine('tab-1', deps);

    expect(h.saved).toEqual([{ tabId: 'tab-1', hash: 'hash-2', unchanged: false }]);
  });

  it('yazma başarısız olursa bant açık kalır, hata bildirilir ve disk değişmez', async () => {
    const h = harness();
    h.failWrite(new Error('yazma reddedildi'));

    const outcome = await writeMine('tab-1', h.deps);

    expect(outcome).toBe('failed');
    expect(h.writes).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.saved).toEqual([]);
    expect(h.store.pending).toHaveLength(1);
  });

  it('bant yoksa hiçbir yazma denemesi yapılmaz', async () => {
    const h = harness();
    h.store.keepMine('tab-1');

    expect(await writeMine('tab-1', h.deps)).toBe('not-found');
    expect(h.writes).toEqual([]);
    expect(h.saved).toEqual([]);
  });

  it('editör bağlantısı yoksa çakışma anındaki içerik yazılır ve sekme dirty kalır', async () => {
    const store = new ConflictStore();
    store.observe({
      tab: dirtyTab,
      editorContents: 'benim sürümüm',
      diskContents: 'diskteki sürüm',
    });
    const writes: { path: string; contents: string }[] = [];
    const saved: { id: string; hash: string | null; unchanged: boolean }[] = [];

    const outcome = await writeMine('tab-1', {
      conflicts: store,
      write: async (path, contents) => {
        writes.push({ path, contents });
        return { hash: 'hash-2' };
      },
      recordSaved: (id, hash, unchanged) => saved.push({ id, hash, unchanged }),
      onError: () => undefined,
    });

    expect(outcome).toBe('written');
    expect(writes).toEqual([{ path: 'notlar.md', contents: 'benim sürümüm' }]);
    expect(saved).toEqual([{ id: 'tab-1', hash: 'hash-2', unchanged: false }]);
  });
});
