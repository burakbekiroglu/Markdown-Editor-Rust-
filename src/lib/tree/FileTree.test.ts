// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import type { EntryInfo } from './ipc';
import { ERROR_ACTION } from '../ipc/errors';

/** Sahte dosya sistemi + IPC çağrı kayıtları (`vi.mock` hoist edildiği için `vi.hoisted`). */
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

vi.mock('../watch/watcher', () => ({
  subscribeWorkspaceWatch: vi.fn(async () => () => {}),
}));

import FileTree from './FileTree.svelte';
import { deleteEntry, moveEntry, renameEntry } from './ipc';
import { tabs } from './tabsStore.svelte';
import { toast } from './toast.svelte';

function entry(name: string, parent = '', isDir = false): EntryInfo {
  const relativePath = parent.length === 0 ? name : `${parent}/${name}`;
  return { name, relativePath, isDir, isSymlink: false };
}

function mountTree(root = 'C:/notlar') {
  const target = document.createElement('div');
  document.body.append(target);
  const instance = mount(FileTree, { target, props: { root } });
  flushSync();
  return { target, instance };
}

function rowOf(target: HTMLElement, path: string): HTMLElement {
  const row = target.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`);
  if (row === null) throw new Error(`satır bulunamadı: ${path}`);
  return row;
}

beforeEach(() => {
  fs.entries.clear();
  fs.listCalls.length = 0;
  tabs.tabs = [];
  tabs.activeId = null;
  fs.entries.set('', [entry('kutu', '', true), entry('a.md'), entry('b.md')]);
  fs.entries.set('kutu', [entry('alt.md', 'kutu')]);
});

afterEach(() => {
  document.body.innerHTML = '';
  toast.clear();
  vi.mocked(moveEntry).mockReset();
  vi.mocked(renameEntry).mockReset();
  vi.mocked(deleteEntry).mockReset();
});

function openRowMenu(target: HTMLElement, path: string): void {
  rowOf(target, path).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
  );
  flushSync();
}

function menuItem(target: HTMLElement, label: string): HTMLButtonElement {
  const item = Array.from(
    target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ).find((button) => button.textContent?.includes(label));
  if (item === undefined) throw new Error(`menü öğesi bulunamadı: ${label}`);
  return item;
}

describe('FileTree selection sync', () => {
  it('aktif sekme değişince ağaçtaki ilgili satır seçili olur', async () => {
    const { target, instance } = mountTree();
    await vi.waitFor(() => expect(rowOf(target, 'a.md')).toBeTruthy());

    tabs.open('b.md');
    flushSync();
    expect(rowOf(target, 'b.md').classList.contains('selected')).toBe(true);
    expect(rowOf(target, 'b.md').getAttribute('aria-current')).toBe('true');
    expect(rowOf(target, 'a.md').classList.contains('selected')).toBe(false);

    tabs.open('a.md');
    flushSync();
    expect(rowOf(target, 'a.md').classList.contains('selected')).toBe(true);
    expect(rowOf(target, 'b.md').classList.contains('selected')).toBe(false);

    unmount(instance);
  });
});

describe('FileTree drag & drop', () => {
  it('kendi içine bırakılan klasörü tipli InvalidPath hatasıyla reddeder', async () => {
    const { target, instance } = mountTree();
    await vi.waitFor(() => expect(rowOf(target, 'kutu')).toBeTruthy());

    const row = rowOf(target, 'kutu');
    row.dispatchEvent(new Event('dragstart', { bubbles: true }));
    row.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    flushSync();

    expect(moveEntry).not.toHaveBeenCalled();
    expect(
      toast.items.some(
        (item) =>
          item.kind === 'error' &&
          item.message.startsWith('Geçersiz yol') &&
          item.message.includes('Bir öğe kendi alt klasörüne taşınamaz.') &&
          item.message.includes(ERROR_ACTION.InvalidPath),
      ),
    ).toBe(true);

    unmount(instance);
  });
});

describe('FileTree context menu', () => {
  it('sağ tık menüsünden yeni dosya diyaloğu açılır', async () => {
    const { target, instance } = mountTree();
    await vi.waitFor(() => expect(rowOf(target, 'a.md')).toBeTruthy());

    openRowMenu(target, 'a.md');
    expect(target.querySelector('[role="menu"]')).not.toBeNull();

    menuItem(target, 'Yeni dosya').click();
    flushSync();

    const dialog = target.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Yeni dosya');

    unmount(instance);
  });

  it('silme onay modalından önce silme çağrısı yapılmaz', async () => {
    const { target, instance } = mountTree();
    await vi.waitFor(() => expect(rowOf(target, 'a.md')).toBeTruthy());
    vi.mocked(deleteEntry).mockResolvedValue(undefined);
    fs.entries.set('', [entry('kutu', '', true), entry('b.md')]);

    openRowMenu(target, 'a.md');
    menuItem(target, 'Sil').click();
    flushSync();

    expect(deleteEntry).not.toHaveBeenCalled();
    const confirmDialog = target.querySelector('[role="alertdialog"]');
    expect(confirmDialog?.textContent).toContain("Geri Dönüşüm Kutusu'na taşınacak");
    expect(
      target.querySelector('.actions button.danger')?.textContent ?? '',
    ).toContain('Sil');

    unmount(instance);
  });

  it('onay diyaloğu iptal edilirse hiçbir dosya sistemi işlemi yapılmaz', async () => {
    const { target, instance } = mountTree();
    await vi.waitFor(() => expect(rowOf(target, 'a.md')).toBeTruthy());
    vi.mocked(deleteEntry).mockResolvedValue(undefined);

    openRowMenu(target, 'a.md');
    menuItem(target, 'Sil').click();
    flushSync();

    const cancelButton = Array.from(
      target.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ).find((button) => button.textContent?.includes('Vazgeç'));
    expect(cancelButton).not.toBeUndefined();
    cancelButton?.click();
    flushSync();

    expect(deleteEntry).not.toHaveBeenCalled();
    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    expect(fs.listCalls).toEqual(['']);
    // İptal sonrası öğe ağaçta yerinde kalır: yeniden listeleme de yapılmaz.
    expect(rowOf(target, 'a.md')).toBeTruthy();
    // İptal durumu kullanıcıya bildirilir.
    expect(
      toast.items.some(
        (item) => item.kind === 'info' && item.message.includes('Silme iptal edildi'),
      ),
    ).toBe(true);

    unmount(instance);
  });

  it('Del tuşuyla istenen silme de onay ister ve iptalde fs işlemi yapılmaz', async () => {
    const { target, instance } = mountTree();
    await vi.waitFor(() => expect(rowOf(target, 'a.md')).toBeTruthy());
    vi.mocked(deleteEntry).mockResolvedValue(undefined);

    rowOf(target, 'a.md').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
    );
    flushSync();

    // Klavye yolu da doğrudan silmez: önce onay diyaloğu açılır.
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(target.querySelector('[role="alertdialog"]')?.textContent).toContain('a.md');

    const cancelButton = Array.from(
      target.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ).find((button) => button.textContent?.includes('Vazgeç'));
    expect(cancelButton).not.toBeUndefined();
    cancelButton?.click();
    flushSync();

    expect(deleteEntry).not.toHaveBeenCalled();
    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    expect(fs.listCalls).toEqual(['']);

    unmount(instance);
  });

  it('onaylanan silme öğeyi tek çağrıyla Geri Dönüşüm Kutusu yoluna verir', async () => {
    const { target, instance } = mountTree();
    await vi.waitFor(() => expect(rowOf(target, 'a.md')).toBeTruthy());
    vi.mocked(deleteEntry).mockResolvedValue(undefined);
    fs.entries.set('', [entry('kutu', '', true), entry('b.md')]);

    openRowMenu(target, 'a.md');
    menuItem(target, 'Sil').click();
    flushSync();

    target.querySelector<HTMLButtonElement>('[role="alertdialog"] button.danger')?.click();

    await vi.waitFor(() => expect(deleteEntry).toHaveBeenCalledTimes(1));
    expect(deleteEntry).toHaveBeenCalledWith('a.md');
    await vi.waitFor(() => expect(target.querySelector('[role="alertdialog"]')).toBeNull());
    expect(
      toast.items.some(
        (item) => item.kind === 'success' && item.message.includes("Geri Dönüşüm Kutusu'na taşındı"),
      ),
    ).toBe(true);

    unmount(instance);
  });

  it('silmeyi işlerken diyalog kilitlenir ve promise çözülünce durum netleşir', async () => {
    const { target, instance } = mountTree();
    await vi.waitFor(() => expect(rowOf(target, 'a.md')).toBeTruthy());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(deleteEntry).mockImplementation(() => gate);
    fs.entries.set('', [entry('b.md')]);

    openRowMenu(target, 'a.md');
    menuItem(target, 'Sil').click();
    flushSync();
    target.querySelector<HTMLButtonElement>('[role="alertdialog"] button.danger')?.click();
    await vi.waitFor(() => expect(deleteEntry).toHaveBeenCalledTimes(1));
    flushSync();

    // Söz beklerken diyalog açık kalır ve düğme işleniyor durumunda kilitli.
    const confirmButton = target.querySelector<HTMLButtonElement>(
      '[role="alertdialog"] button.danger',
    );
    expect(confirmButton?.disabled).toBe(true);
    expect(confirmButton?.textContent).toContain('İşleniyor');
    expect(target.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(
      toast.items.some((item) => item.kind === 'error'),
    ).toBe(false);

    // Söz çözülünce diyalog kapanır, başarı bildirilir; askıda görev kalmaz.
    release();
    await vi.waitFor(() => expect(target.querySelector('[role="alertdialog"]')).toBeNull());
    expect(
      toast.items.some(
        (item) => item.kind === 'success' && item.message.includes("Geri Dönüşüm Kutusu'na taşındı"),
      ),
    ).toBe(true);

    unmount(instance);
  });

  it('silme reddedilirse hata bildirilir ve diyalog işleniyor durumunda kilitlenmez', async () => {
    const { target, instance } = mountTree();
    await vi.waitFor(() => expect(rowOf(target, 'a.md')).toBeTruthy());
    vi.mocked(deleteEntry).mockRejectedValue(new Error('dosya kilitli'));

    openRowMenu(target, 'a.md');
    menuItem(target, 'Sil').click();
    flushSync();

    target.querySelector<HTMLButtonElement>('[role="alertdialog"] button.danger')?.click();

    await vi.waitFor(() =>
      expect(toast.items.some((item) => item.kind === 'error' && item.message === 'dosya hatası')).toBe(
        true,
      ),
    );
    const confirmButton = target.querySelector<HTMLButtonElement>(
      '[role="alertdialog"] button.danger',
    );
    expect(confirmButton?.disabled).toBe(false);
    expect(confirmButton?.textContent).toContain('Sil');
    expect(confirmButton?.textContent).not.toContain('İşleniyor');

    unmount(instance);
  });
});

describe('FileTree inline rename', () => {
  it('menüden yeniden adlandırma satır içi giriş açar ve yeni adı uygular', async () => {
    const { target, instance } = mountTree();
    await vi.waitFor(() => expect(rowOf(target, 'a.md')).toBeTruthy());

    vi.mocked(renameEntry).mockResolvedValue(entry('b.md'));
    fs.entries.set('', [entry('kutu', '', true), entry('b.md')]);

    openRowMenu(target, 'a.md');
    menuItem(target, 'Yeniden adlandır').click();
    flushSync();

    try {
      const input = target.querySelector<HTMLInputElement>('input[aria-label="Yeni ad"]');
      expect(input).not.toBeNull();
      if (input === null) return;
      expect(input.value).toBe('a.md');

      input.value = 'b.md';
      input.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(rowOf(target, 'b.md')).toBeTruthy());
      await vi.waitFor(() =>
        expect(target.querySelector('input[aria-label="Yeni ad"]')).toBeNull(),
      );

      expect(renameEntry).toHaveBeenCalledWith('a.md', 'b.md');
    } finally {
      unmount(instance);
    }
  });
});

describe('FileTree refresh', () => {
  it('yenile düğmesi kökü diskten yeniden okur', async () => {
    const { target, instance } = mountTree();
    await vi.waitFor(() => expect(rowOf(target, 'a.md')).toBeTruthy());
    expect(fs.listCalls).toEqual(['']);

    fs.entries.set('', [entry('yeni.md')]);
    target.querySelector<HTMLButtonElement>('button[aria-label="Ağacı yenile"]')?.click();
    await vi.waitFor(() => expect(rowOf(target, 'yeni.md')).toBeTruthy());
    expect(fs.listCalls).toEqual(['', '']);

    unmount(instance);
  });

  it('F5 ağacı diskten tazeler ve tarayıcı yeniden yüklemesini engeller', async () => {
    const { target, instance } = mountTree();
    await vi.waitFor(() => expect(rowOf(target, 'a.md')).toBeTruthy());

    const event = new KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    await vi.waitFor(() => expect(fs.listCalls).toEqual(['', '']));
    expect(event.defaultPrevented).toBe(true);

    unmount(instance);
  });

  it('çalışma alanı yokken F5 istek yapmaz', async () => {
    const { instance } = mountTree('');
    flushSync();

    const event = new KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(fs.listCalls).toEqual([]);
    expect(event.defaultPrevented).toBe(false);

    unmount(instance);
  });
});
