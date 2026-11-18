// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import MissingFileBanner from './MissingFileBanner.svelte';

let cleanup: (() => void) | null = null;

function render(overrides: {
  dirty?: boolean;
  onRelocate?: (newPath: string) => Promise<string | null>;
  onSave?: () => Promise<string | null>;
} = {}): {
  onRelocate: ReturnType<typeof vi.fn>;
  onSave: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const onRelocate = vi.fn(overrides.onRelocate ?? (() => Promise.resolve(null)));
  const onSave = vi.fn(overrides.onSave ?? (() => Promise.resolve(null)));
  const onClose = vi.fn();
  const target = document.createElement('div');
  document.body.append(target);

  const component = mount(MissingFileBanner, {
    target,
    props: {
      title: 'notlar.md',
      path: 'kutu/notlar.md',
      dirty: overrides.dirty ?? false,
      onRelocate,
      onSave,
      onClose,
    },
  });

  cleanup = () => {
    unmount(component);
    target.remove();
  };

  return { onRelocate, onSave, onClose };
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

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = '';
});

describe('MissingFileBanner', () => {
  it('Kaydet ve Sekmeyi Kapat seçeneklerini sunar', () => {
    render();

    expect(button('Kaydet')).toBeInstanceOf(HTMLButtonElement);
    expect(button('Sekmeyi Kapat')).toBeInstanceOf(HTMLButtonElement);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('Kaydet aynı yolda yeniden oluşturmayı tetikler ve bandı kapatmaz', async () => {
    const { onSave, onClose } = render();

    click(button('Kaydet'));
    await settle();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('yeniden oluşturma hata dönerse hata mesajını gösterir', async () => {
    render({ onSave: () => Promise.resolve('Yazma izni yok.') });

    click(button('Kaydet'));
    await settle();

    const error = document.querySelector('#missing-error');
    expect(error?.textContent).toBe('Yazma izni yok.');
  });

  it('temiz sekmede Sekmeyi Kapat onay istemeden kapatır', () => {
    const { onClose } = render();

    click(button('Sekmeyi Kapat'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('kirli sekmede Sekmeyi Kapat önce onay ister, içerik korunur', () => {
    const { onClose } = render({ dirty: true });

    click(button('Sekmeyi Kapat'));

    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();

    click(button('Vazgeç'));

    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
});
