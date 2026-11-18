/**
 * Oturum kalıcılığının `tauri-plugin-store` sözleşmesini sınar.
 *
 * `ipc.ts` modül düzeyinde tek bir depo sözleşmesi önbelleğe aldığı için her
 * test `vi.resetModules()` ile taze modül yükler; aksi halde ilk testin depo
 * örneği sonrakilere sızardı.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_VERSION,
  createSessionData,
  parseSession,
  serializeSession,
} from './schema';

const { loadStore } = vi.hoisted(() => ({ loadStore: vi.fn() }));

vi.mock('@tauri-apps/plugin-store', () => ({ load: loadStore }));

type FakeStore = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
};

function fakeStore(overrides: Partial<FakeStore> = {}): FakeStore {
  return {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function loadIpc(): Promise<typeof import('./ipc')> {
  vi.resetModules();
  return import('./ipc');
}

beforeEach(() => {
  loadStore.mockReset();
});

describe('saveSession', () => {
  it('oturumu session.json içine sürümlü JSON nesnesi olarak yazar ve diske indirir', async () => {
    const store = fakeStore();
    loadStore.mockResolvedValue(store);
    const { SESSION_STORE_KEY, SESSION_STORE_PATH, saveSession } = await loadIpc();

    const data = createSessionData({
      root: 'C:/notlar',
      tabs: [
        {
          path: 'gunluk/bugun.md',
          cursor: { anchor: 3, head: 3 },
          scroll: { top: 40, left: 0 },
        },
      ],
      activePath: 'gunluk/bugun.md',
      viewMode: 'preview',
      splitRatio: 0.6,
      sidebarWidth: 300,
    });
    await saveSession(serializeSession(data));

    expect(loadStore).toHaveBeenCalledWith(SESSION_STORE_PATH, { autoSave: false });
    expect(store.set).toHaveBeenCalledWith(SESSION_STORE_KEY, {
      version: SESSION_VERSION,
      root: 'C:/notlar',
      tabs: [
        {
          path: 'gunluk/bugun.md',
          cursor: { anchor: 3, head: 3 },
          scroll: { top: 40, left: 0 },
        },
      ],
      activePath: 'gunluk/bugun.md',
      viewMode: 'preview',
      splitRatio: 0.6,
      sidebarWidth: 300,
    });
    expect(store.save).toHaveBeenCalledTimes(1);
  });
});

describe('loadSession', () => {
  it('depodaki değeri şema doğrulamasına uygun JSON metnine çevirir', async () => {
    const stored = {
      version: SESSION_VERSION,
      root: 'C:/notlar',
      tabs: [{ path: 'a.md', cursor: null, scroll: null }],
      activePath: 'a.md',
      viewMode: 'editor',
      splitRatio: 0.5,
      sidebarWidth: 250,
    };
    const store = fakeStore({ get: vi.fn(async () => stored) });
    loadStore.mockResolvedValue(store);
    const { SESSION_STORE_KEY, loadSession } = await loadIpc();

    const raw = await loadSession();

    expect(store.get).toHaveBeenCalledWith(SESSION_STORE_KEY);
    expect(parseSession(raw ?? '')).toMatchObject({
      version: SESSION_VERSION,
      root: 'C:/notlar',
      activePath: 'a.md',
      viewMode: 'editor',
    });
  });

  it('kayıt yoksa null döner (ilk çalıştırma)', async () => {
    loadStore.mockResolvedValue(fakeStore());
    const { loadSession } = await loadIpc();

    await expect(loadSession()).resolves.toBeNull();
  });

  it('bozuk depo yüklemesi uygulamayı kilitlemez ve sonraki denemede yeniden açılır', async () => {
    const store = fakeStore({ get: vi.fn(async () => ({ version: SESSION_VERSION })) });
    loadStore.mockRejectedValueOnce(new Error('bozuk store')).mockResolvedValue(store);
    const { loadSession } = await loadIpc();

    await expect(loadSession()).resolves.toBeNull();
    await expect(loadSession()).resolves.not.toBeNull();
    expect(loadStore).toHaveBeenCalledTimes(2);
  });

  it('okuma hatası temiz başlangıca düşer', async () => {
    const store = fakeStore({
      get: vi.fn(async () => {
        throw new Error('okunamadı');
      }),
    });
    loadStore.mockResolvedValue(store);
    const { loadSession } = await loadIpc();

    await expect(loadSession()).resolves.toBeNull();
  });
});
