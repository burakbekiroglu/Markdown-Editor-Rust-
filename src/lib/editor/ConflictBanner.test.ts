// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import ConflictBanner from './ConflictBanner.svelte';
import type { PendingConflict } from './conflict';

const conflict: PendingConflict = {
  tabId: 'tab-1',
  path: 'notlar.md',
  editorContents: 'satır bir\nbenim satırım',
  diskContents: 'satır bir\ndisk satırı',
  detectedAt: 1_000,
};

let cleanup: (() => void) | null = null;

function render(overrides: {
  onLoadDisk?: () => Promise<void> | void;
  onWriteMine?: () => Promise<void> | void;
  readEditorContents?: () => string | null;
} = {}): {
  onLoadDisk: ReturnType<typeof vi.fn>;
  onWriteMine: ReturnType<typeof vi.fn>;
} {
  const onLoadDisk = vi.fn(overrides.onLoadDisk ?? (() => undefined));
  const onWriteMine = vi.fn(overrides.onWriteMine ?? (() => undefined));
  const target = document.createElement('div');
  document.body.append(target);

  const component = mount(ConflictBanner, {
    target,
    props: {
      conflict,
      onLoadDisk,
      onWriteMine,
      ...(overrides.readEditorContents
        ? { readEditorContents: overrides.readEditorContents }
        : {}),
    },
  });

  cleanup = () => {
    unmount(component);
    target.remove();
  };

  return { onLoadDisk, onWriteMine };
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (element) => element.textContent?.trim() === label,
  );
  if (!match) throw new Error(`buton bulunamadı: ${label}`);
  return match;
}

function click(element: Element): void {
  flushSync(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Asenkron tıklama işleyicilerinin (yazma) tamamlanmasını bekler. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

const diffPanel = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.diff-panel');

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = '';
});

describe('ConflictBanner', () => {
  it('Diski Yükle, Benimkini Yaz ve Farkı Gör butonlarını gösterir', () => {
    render();

    expect(button('Diski Yükle')).toBeInstanceOf(HTMLButtonElement);
    expect(button('Benimkini Yaz')).toBeInstanceOf(HTMLButtonElement);
    expect(button('Farkı Gör')).toBeInstanceOf(HTMLButtonElement);
    // Bant açıkken disk içeriği editöre uygulanmaz.
    expect(document.querySelector('.conflict')).not.toBeNull();
  });

  it('Diski Yükle önce açık onay ister ve vazgeçilince hiçbir şey yapmaz', () => {
    const { onLoadDisk } = render();

    click(button('Diski Yükle'));

    expect(onLoadDisk).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.querySelector('.conflict')).not.toBeNull();

    click(button('Vazgeç'));

    expect(onLoadDisk).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector('.conflict')).not.toBeNull();
  });

  it('onay verilince Diski Yükle çağrılır', async () => {
    const { onLoadDisk } = render();

    click(button('Diski Yükle'));
    click(button('Değişiklikleri kaybet ve yükle'));
    await settle();

    expect(onLoadDisk).toHaveBeenCalledTimes(1);
  });

  it('Farkı Gör disk içeriği ile güncel editör içeriğini salt okunur karşılaştırır', () => {
    const readEditorContents = vi.fn(() => 'satır bir\neditördeki güncel satır');
    render({ readEditorContents });

    click(button('Farkı Gör'));

    expect(readEditorContents).toHaveBeenCalled();
    const panel = diffPanel();
    expect(panel).not.toBeNull();
    // Panel salt okunur: içinde form denetimi veya düzenlenebilir alan yok.
    expect(panel?.querySelector('input, textarea, select, [contenteditable="true"]')).toBeNull();
    expect(panel?.getAttribute('aria-readonly')).toBe('true');

    const removed = Array.from(panel?.querySelectorAll('.diff-line.removed') ?? []).map(
      (line) => line.textContent,
    );
    const added = Array.from(panel?.querySelectorAll('.diff-line.added') ?? []).map(
      (line) => line.textContent,
    );
    expect(removed.join(' ')).toContain('disk satırı');
    expect(added.join(' ')).toContain('editördeki güncel satır');

    click(button('Farkı Gör'));
    expect(diffPanel()).toBeNull();
  });

  it('Benimkini Yaz ek onay istemeden geri çağrımı tetikler, bandı kapatmaz', async () => {
    const { onWriteMine, onLoadDisk } = render({ onWriteMine: () => Promise.resolve() });

    click(button('Benimkini Yaz'));
    await settle();

    expect(onWriteMine).toHaveBeenCalledTimes(1);
    expect(onLoadDisk).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    // Bant yalnızca yazma başarılı olduğunda üst katman tarafından kaldırılır.
    expect(document.querySelector('.conflict')).not.toBeNull();
  });

  it('yazma sürerken ikinci bir yazma isteği üretmez', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { onWriteMine } = render({ onWriteMine: () => pending });

    click(button('Benimkini Yaz'));
    expect(button('Benimkini Yaz').disabled).toBe(true);
    click(button('Benimkini Yaz'));

    expect(onWriteMine).toHaveBeenCalledTimes(1);

    release();
    await settle();
    expect(button('Benimkini Yaz').disabled).toBe(false);
  });
});
