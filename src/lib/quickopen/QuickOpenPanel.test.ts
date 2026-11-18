// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import type { IndexEntry } from '../ipc/types';

/** Sahte `fs_index` sonucu; testler yalnızca bu diziyi değiştirir. */
const fs = vi.hoisted(() => ({
  entries: [] as IndexEntry[],
  truncated: false,
}));

const openTab = vi.hoisted(() => vi.fn());

vi.mock('../tree/ipc', () => ({
  indexWorkspace: vi.fn(async () => ({
    root: 'C:/notlar',
    entries: fs.entries,
    truncated: fs.truncated,
    skippedHidden: 0,
    skippedLarge: 0,
    skippedSymlinks: 0,
    skippedUnreadable: 0,
  })),
  describeFsError: vi.fn(() => 'dosya hatası'),
}));

vi.mock('../tree/tabsStore.svelte', () => ({ tabs: { open: openTab } }));
vi.mock('../tree/toast.svelte', () => ({ toast: { error: vi.fn() } }));

import QuickOpenPanel from './QuickOpenPanel.svelte';

function entry(relativePath: string): IndexEntry {
  const name = relativePath.split('/').pop() ?? relativePath;
  return { name, relativePath, isDir: false, size: 10, modifiedMs: null };
}

let cleanup: (() => void) | null = null;

/** Paneli açar; indeks yüklemesi çözülene kadar bekler. */
async function mountPanel(truncated = false): Promise<() => void> {
  fs.truncated = truncated;
  const onClose = vi.fn();
  const target = document.createElement('div');
  document.body.append(target);
  const instance = mount(QuickOpenPanel, { target, props: { open: true, onClose } });
  flushSync();

  cleanup = () => {
    unmount(instance);
    target.remove();
  };
  await vi.waitFor(() => expect(searchInput()).not.toBeNull());
  await vi.waitFor(() => expect(document.querySelectorAll('.option').length).toBeGreaterThan(0));
  return onClose;
}

function searchInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input.search');
  if (input === null) throw new Error('arama girişi bulunamadı');
  return input;
}

function options(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.option'));
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function press(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  flushSync();
}

beforeEach(() => {
  // jsdom `scrollIntoView` uygulamaz; etkin satırı görünür tutan efekt patlamasın.
  Element.prototype.scrollIntoView = vi.fn();
  fs.entries = [
    entry('notlar/gunluk.md'),
    entry('notlar/proje-plani.md'),
    entry('arsiv/eski-gunluk.md'),
  ];
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = '';
  openTab.mockClear();
});

describe('QuickOpenPanel', () => {
  it('açılınca girişe odaklanır ve dosyaları listeler', async () => {
    await mountPanel();
    expect(document.activeElement).toBe(searchInput());
    expect(options()).toHaveLength(3);
  });

  it('sorguyu bulanık eşleştirir ve eşleşen parçaları vurgular', async () => {
    await mountPanel();
    type(searchInput(), 'gnlk');

    expect(options()).toHaveLength(2);
    const first = options()[0];
    const highlighted = Array.from(first?.querySelectorAll('.match') ?? [])
      .map((element) => element.textContent)
      .join('');
    expect(highlighted.toLowerCase()).toBe('gnlk');
  });

  it('ok tuşlarıyla seçer, Enter seçili dosyayı açar', async () => {
    await mountPanel();
    const input = searchInput();

    // Boş sorguda sıra alfabetiktir: arsiv/… , notlar/gunluk.md, notlar/proje-plani.md
    press(input, 'ArrowDown');
    expect(options()[1]?.classList.contains('active')).toBe(true);

    press(input, 'Enter');
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(openTab.mock.calls[0]?.[0]).toBe('notlar/gunluk.md');
  });

  it('5 karakter yazıldıktan sonra sonuçlar 100 ms içinde güncellenir', async () => {
    await mountPanel();
    const input = searchInput();

    const started = performance.now();
    type(input, 'plani');
    const elapsed = performance.now() - started;

    // `plani` yalnızca `notlar/proje-plani.md` ile eşleşir.
    expect(options().map((option) => option.textContent)).toHaveLength(1);
    expect(options()[0]?.textContent).toContain('proje-plani.md');
    expect(elapsed).toBeLessThan(100);
  });

  it('Escape kapatma geri çağrısını tetikler', async () => {
    const onClose = await mountPanel();
    press(searchInput(), 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('indeks sınıra takıldıysa kullanıcıyı uyarır', async () => {
    await mountPanel(true);
    expect(document.body.textContent).toContain('Dizin taraması sınıra takıldı');
  });

  it('indeks eksiksizse uyarı göstermez', async () => {
    await mountPanel(false);
    expect(document.body.textContent).not.toContain('Dizin taraması sınıra takıldı');
  });
});
