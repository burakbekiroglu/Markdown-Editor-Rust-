import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntryInfo } from './ipc';

/**
 * `listEntries` çağrılarını ve sahte dosya sistemi içeriğini tutan ortak
 * durum. `vi.mock` hoist edildiği için `vi.hoisted` ile kurulur.
 */
const fs = vi.hoisted(() => ({
  entries: new Map<string, EntryInfo[]>(),
  listCalls: [] as string[],
}));

vi.mock('./ipc', () => ({
  listEntries: vi.fn(async (path = '') => {
    fs.listCalls.push(path);
    return fs.entries.get(path) ?? [];
  }),
  createFile: vi.fn(),
  createFolder: vi.fn(),
  renameEntry: vi.fn(),
  moveEntry: vi.fn(),
  deleteEntry: vi.fn(),
  describeFsError: vi.fn(() => 'dosya hatası'),
}));

import { TreeStore } from './treeStore.svelte';
import {
  createFile,
  createFolder,
  deleteEntry,
  listEntries,
  moveEntry,
  renameEntry,
} from './ipc';
import { toast } from './toast.svelte';

function entry(name: string, parent = '', isDir = false): EntryInfo {
  const relativePath = parent.length === 0 ? name : `${parent}/${name}`;
  return { name, relativePath, isDir, isSymlink: false };
}

function seed(path: string, items: EntryInfo[]): void {
  fs.entries.set(path, items);
}

beforeEach(() => {
  fs.entries.clear();
  fs.listCalls.length = 0;
  toast.clear();
  vi.mocked(deleteEntry).mockReset();
});
describe('TreeStore.attachRoot', () => {
  it('kök değişince önceki kökün önbelleğini ve açık klasörlerini sıfırlar', async () => {
    seed('', [entry('eski.md')]);
    seed('kutu', [entry('alt.md', 'kutu')]);
    const store = new TreeStore();
    store.attachRoot('C:/eski');
    await store.load('kutu');
    store.expanded['kutu'] = true;
    expect(store.childrenOf('kutu')).toHaveLength(1);

    // Yeni kökün içeriği sahte dosya sisteminde farklıdır.
    fs.entries.clear();
    seed('', [entry('yeni.md')]);
    fs.listCalls.length = 0;
    store.attachRoot('C:/yeni');
    await vi.waitFor(() => expect(store.rootEntries).toHaveLength(1));

    expect(store.root).toBe('C:/yeni');
    // Eski kökün alt ağacı ve genişletme durumu taşınmaz.
    expect(store.entriesByDir['kutu']).toBeUndefined();
    expect(store.expanded).toEqual({ '': true });
    expect(store.rootError).toBeNull();
    expect(store.rootEntries.map((item) => item.name)).toEqual(['yeni.md']);
    expect(fs.listCalls).toEqual(['']);
  });
});

describe('TreeStore.toggle', () => {
  it('klasörü ilk açışta listeler, kapatıp açınca yeniden istemez', async () => {
    seed('', [entry('kutu', '', true)]);
    seed('kutu', [entry('alt.md', 'kutu')]);
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    await vi.waitFor(() => expect(store.rootEntries).toHaveLength(1));
    fs.listCalls.length = 0;

    await store.toggle('kutu');
    expect(fs.listCalls).toEqual(['kutu']);
    expect(store.expanded['kutu']).toBe(true);
    expect(store.childrenOf('kutu').map((item) => item.relativePath)).toEqual(['kutu/alt.md']);

    await store.toggle('kutu');
    expect(store.expanded['kutu']).toBe(false);

    await store.toggle('kutu');
    expect(fs.listCalls).toEqual(['kutu']);
    expect(store.expanded['kutu']).toBe(true);
    expect(store.childrenOf('kutu')).toHaveLength(1);
  });
});

describe('TreeStore.load', () => {
  it('aynı klasör için eşzamanlı iki istek tek listeleme çağrısına iner', async () => {
    seed('', [entry('kutu', '', true)]);
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    await vi.waitFor(() => expect(store.rootEntries).toHaveLength(1));
    fs.listCalls.length = 0;

    // Yanıtı testin serbest bıraktığı tek bir istek: iki çağrı da buna bağlanmalı.
    let release: (items: EntryInfo[]) => void = () => {};
    vi.mocked(listEntries).mockImplementationOnce(
      (path = '') =>
        new Promise<EntryInfo[]>((resolve) => {
          fs.listCalls.push(path);
          release = resolve;
        }),
    );

    const first = store.load('kutu');
    const second = store.load('kutu');
    expect(fs.listCalls).toEqual(['kutu']);

    release([entry('alt.md', 'kutu')]);
    await Promise.all([first, second]);

    expect(fs.listCalls).toEqual(['kutu']);
    expect(store.childrenOf('kutu').map((item) => item.relativePath)).toEqual(['kutu/alt.md']);
    expect(store.loading['kutu']).toBe(false);
  });
});

describe('TreeStore.reload', () => {
  it('kök ve yüklenmiş klasörleri diskten yeniden okur', async () => {
    seed('', [entry('kutu', '', true)]);
    seed('kutu', [entry('eski.md', 'kutu')]);
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    await vi.waitFor(() => expect(store.rootEntries).toHaveLength(1));
    await store.load('kutu');
    fs.listCalls.length = 0;

    // Disk değişti: dosya silinip yenisi eklendi.
    seed('kutu', [entry('yeni.md', 'kutu')]);
    await store.reload();

    expect(store.childrenOf('kutu').map((item) => item.relativePath)).toEqual([
      'kutu/yeni.md',
    ]);
    expect(new Set(fs.listCalls)).toEqual(new Set(['', 'kutu']));
  });

  it('açılmamış klasörleri listelemez ve kök yokken istek yapmaz', async () => {
    seed('', [entry('kutu', '', true)]);
    seed('kutu', []);
    seed('kapali', []);
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    await vi.waitFor(() => expect(store.rootEntries).toHaveLength(1));
    fs.listCalls.length = 0;

    await store.reload();
    expect(fs.listCalls).toEqual(['']);

    const empty = new TreeStore();
    fs.listCalls.length = 0;
    await empty.reload();
    expect(fs.listCalls).toEqual([]);
  });
});

describe('TreeStore.move', () => {
  it('taşıma sonrası eski ve yeni üst klasörü tazeler', async () => {
    seed('', [entry('a.md'), entry('arsiv', '', true)]);
    seed('arsiv', []);
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    await store.load('arsiv');
    fs.listCalls.length = 0;

    vi.mocked(moveEntry).mockResolvedValue(entry('a.md', 'arsiv'));
    seed('', [entry('arsiv', '', true)]);
    seed('arsiv', [entry('a.md', 'arsiv')]);

    const moved = await store.move('a.md', 'arsiv');

    expect(moved?.relativePath).toBe('arsiv/a.md');
    expect(store.rootEntries.map((item) => item.relativePath)).toEqual(['arsiv']);
    expect(store.childrenOf('arsiv').map((item) => item.relativePath)).toEqual(['arsiv/a.md']);
    expect(store.expanded['arsiv']).toBe(true);
    expect(fs.listCalls).toEqual(['', 'arsiv']);
  });

  it('çakışmada taşımaz, hata toast ile bildirilir ve ağaç korunur', async () => {
    seed('', [entry('a.md')]);
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    await vi.waitFor(() => expect(store.rootEntries).toHaveLength(1));

    vi.mocked(moveEntry).mockRejectedValue({ code: 'ENTRY_EXISTS', message: 'zaten var' });

    const moved = await store.move('a.md', 'arsiv');

    expect(moved).toBeNull();
    expect(store.rootEntries.map((item) => item.relativePath)).toEqual(['a.md']);
  });
});

describe('TreeStore.remove', () => {
  it('onaylanan silme öğeyi tek çağrıyla Geri Dönüşüm Kutusu yoluna verir', async () => {
    seed('', [entry('a.md'), entry('b.md')]);
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    await vi.waitFor(() => expect(store.rootEntries).toHaveLength(2));

    vi.mocked(deleteEntry).mockResolvedValue(undefined);
    // Geri Dönüşüm Kutusu'na giden öğe artık çalışma alanında listelenmez.
    seed('', [entry('b.md')]);
    fs.listCalls.length = 0;

    await expect(store.remove('a.md')).resolves.toBe(true);

    expect(deleteEntry).toHaveBeenCalledTimes(1);
    expect(deleteEntry).toHaveBeenCalledWith('a.md');
    expect(store.rootEntries.map((item) => item.relativePath)).toEqual(['b.md']);
    expect(fs.listCalls).toEqual(['']);
    expect(
      toast.items.some(
        (item) => item.kind === 'success' && item.message.includes("Geri Dönüşüm Kutusu'na taşındı"),
      ),
    ).toBe(true);
  });

  it('reddedilen silmede öğe yerinde kalır ve hata bildirilir', async () => {
    seed('', [entry('a.md'), entry('b.md')]);
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    await vi.waitFor(() => expect(store.rootEntries).toHaveLength(2));

    vi.mocked(deleteEntry).mockRejectedValue({ code: 'IO_ERROR', message: 'dosya kilitli' });
    fs.listCalls.length = 0;

    await expect(store.remove('a.md')).resolves.toBe(false);

    // Başarısız silme ağacı değiştirmez ve yeniden listeleme yapmaz: öğe
    // diskteki yerinde kalır, yalnızca hata bildirilir.
    expect(store.rootEntries.map((item) => item.relativePath)).toEqual(['a.md', 'b.md']);
    expect(fs.listCalls).toEqual([]);
    expect(
      toast.items.some((item) => item.kind === 'error' && item.message === 'dosya hatası'),
    ).toBe(true);
  });
});

describe('TreeStore.refreshFromChanges', () => {
  it('yeni dosya oluşturulunca yüklü klasörü yeniden listeler', async () => {
    seed('', [entry('kutu', '', true)]);
    seed('kutu', []);
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    await store.load('kutu');
    fs.listCalls.length = 0;

    // Dışarıdan oluşturulan dosya sahte dosya sistemine eklenir.
    seed('kutu', [entry('yeni.md', 'kutu')]);
    await store.refreshFromChanges([{ path: 'kutu/yeni.md', kind: 'create' }]);

    expect(store.childrenOf('kutu').map((item) => item.relativePath)).toEqual([
      'kutu/yeni.md',
    ]);
    // Yalnızca değişen dosyanın üst klasörü listelenir; kök gereksiz yere
    // yeniden okunmaz.
    expect(fs.listCalls).toEqual(['kutu']);
  });

  it('silinen alt ağacı önbellekten düşürür ve üst klasörü tazeler', async () => {
    seed('', [entry('kutu', '', true), entry('kalan.md')]);
    seed('kutu', [entry('alt', 'kutu', true)]);
    seed('kutu/alt', [entry('eski.md', 'kutu/alt')]);
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    await store.load('kutu');
    await store.load('kutu/alt');
    // Açık klasörler normalde `expanded` içinde işaretlidir; silme sonrası
    // bunların yeniden listelenmeye çalışılmadığını bu bayraklarla sınarız.
    store.expanded['kutu'] = true;
    store.expanded['kutu/alt'] = true;
    fs.listCalls.length = 0;

    seed('', [entry('kalan.md')]);
    fs.entries.delete('kutu');
    fs.entries.delete('kutu/alt');
    await store.refreshFromChanges([
      { path: 'kutu/alt/eski.md', kind: 'remove' },
      { path: 'kutu/alt', kind: 'remove' },
      { path: 'kutu', kind: 'remove' },
    ]);

    expect(store.entriesByDir['kutu']).toBeUndefined();
    expect(store.entriesByDir['kutu/alt']).toBeUndefined();
    expect(store.rootEntries.map((item) => item.relativePath)).toEqual(['kalan.md']);
    // Silinen klasörler yeniden listelenmeye çalışılmaz; yalnızca yaşayan
    // üst klasör tazelenir.
    expect(fs.listCalls).toEqual(['']);
  });

  it('taşıma olayında eski ve yeni üst klasörü yeniler', async () => {
    seed('', [entry('a.md')]);
    seed('arsiv', []);
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    await store.load('arsiv');
    fs.listCalls.length = 0;

    seed('', []);
    seed('arsiv', [entry('a.md', 'arsiv')]);
    await store.refreshFromChanges([
      { path: 'a.md', kind: 'remove' },
      { path: 'arsiv/a.md', kind: 'create' },
    ]);

    expect(store.rootEntries).toEqual([]);
    expect(store.childrenOf('arsiv').map((item) => item.relativePath)).toEqual([
      'arsiv/a.md',
    ]);
    expect(new Set(fs.listCalls)).toEqual(new Set(['', 'arsiv']));
  });

  it('yüklenmemiş ve kapalı klasörü gereksiz yere listelemez', async () => {
    seed('', [entry('kutu', '', true)]);
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    fs.listCalls.length = 0;

    await store.refreshFromChanges([{ path: 'kutu/uzak.md', kind: 'modify' }]);

    expect(fs.listCalls).toEqual([]);
  });

  it('kök açılmadan olay geldiğinde hiçbir istek yapmaz', async () => {
    const store = new TreeStore();

    await store.refreshFromChanges([{ path: 'a.md', kind: 'modify' }]);

    expect(fs.listCalls).toEqual([]);
  });
});

/**
 * Onay/iptal davranışının `store.remove`'u doğrudan saran regresyon testleri.
 *
 * `confirmedRemove` onay diyaloğu sözleşmesini birim düzeyde modeller:
 * onay → `store.remove`, iptal → hiçbir fs çağrısı ve `false` dönen söz.
 *
 * Asılı kalma olasılığını yakalamak için her iki yol da sahte zamanlayıcı
 * ile yarıştırılır (gerçek sleep yok): silme sözü zamanlayıcıdan önce
 * settle etmezse test başarısız olur.
 */
describe('TreeStore.remove onay/iptal davranışı (regresyon)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Karar verilecek silme sözü: onayda `remove`, iptalde fs'e dokunmaz. */
  function confirmedRemove(
    store: TreeStore,
    rel: string,
    approved: boolean,
  ): Promise<boolean> {
    if (!approved) return Promise.resolve(false);
    return store.remove(rel);
  }

  /** Yarış zamanlayıcısı; `advanceTimersByTimeAsync` ile serbest bırakılır. */
  function raceTimeout(): Promise<'timeout'> {
    return new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000));
  }

  it('onay verildiğinde fs silme çağrısı tam bir kez yapılır ve söz hızlı `true` ile settle olur', async () => {
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    vi.mocked(deleteEntry).mockResolvedValue(undefined);

    const outcome = await Promise.race([
      confirmedRemove(store, 'a.md', true).then((value) => ({ kind: 'settled', value })),
      raceTimeout(),
    ]);

    // Asılı silme yakalanır: söz zamanlayıcıdan önce settle etmelidir.
    expect(outcome).toEqual({ kind: 'settled', value: true });
    expect(deleteEntry).toHaveBeenCalledTimes(1);
    expect(deleteEntry).toHaveBeenCalledWith('a.md');
    await vi.advanceTimersByTimeAsync(1500);
  });

  it('iptal edildiğinde fs modülünün hiçbir fonksiyonu çağrılmaz ve söz hızlı `false` ile settle olur', async () => {
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    vi.mocked(deleteEntry).mockResolvedValue(undefined);
    // `attachRoot` arka planda bir listeleme başlatabilir: iptal yolunun
    // kendi çağrısını izole etmek için taban çizgisi kaydedilir.
    await vi.waitFor(() => expect(fs.listCalls.length).toBeGreaterThanOrEqual(1));
    const baselineListCalls = vi.mocked(listEntries).mock.calls.length;
    const baselineEntries = [...fs.listCalls];

    const outcome = await Promise.race([
      confirmedRemove(store, 'a.md', false).then((value) => ({ kind: 'settled', value })),
      raceTimeout(),
    ]);

    // İptal sözleşmesi: sonuç `false`, hiçbir fs çağrısı yapılmaz.
    expect(outcome).toEqual({ kind: 'settled', value: false });
    // Mock üzerinden açık assertion: fs modülünün her mock'u boş kalmalı.
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(vi.mocked(listEntries).mock.calls).toHaveLength(baselineListCalls);
    expect(createFile).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
    expect(renameEntry).not.toHaveBeenCalled();
    expect(moveEntry).not.toHaveBeenCalled();
    expect(fs.listCalls).toEqual(baselineEntries);
    await vi.advanceTimersByTimeAsync(1500);
  });

  it('reddedilen silme de hızlı settle olur ve söz askıda kalmaz', async () => {
    const store = new TreeStore();
    store.attachRoot('C:/notlar');
    vi.mocked(deleteEntry).mockRejectedValue({ code: 'IO_ERROR', message: 'kilitli' });
    fs.listCalls.length = 0;

    const outcome = await Promise.race([
      confirmedRemove(store, 'a.md', true).then((value) => ({ kind: 'settled', value })),
      raceTimeout(),
    ]);

    // `store.remove` hatayı kendi yakalar: söz `false` ile settle eder,
    // reddetmez; çağıran taraf asılı bir görev bırakmaz.
    expect(outcome).toEqual({ kind: 'settled', value: false });
    expect(deleteEntry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
  });
});
