// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import CloseConfirmDialog from './CloseConfirmDialog.svelte';

let cleanup: (() => void) | null = null;

/** Bileşenin beklediği işleyici imzası; mock'lar bu imzayla tiplenir. */
type Handler = () => Promise<void> | void;

interface Handlers {
  onSaveAndClose: Mock<Handler>;
  onCloseWithoutSaving: Mock<Handler>;
  onCancel: Mock<Handler>;
}

/**
 * Diyaloğu açar. Üç karar yolu da enjekte edilir: bileşen kendi başına hiçbir
 * yazma/kapama yapmaz, yalnızca seçimi çağırana iletir.
 */
function render(titles: string[], busy = false): Handlers {
  const handlers: Handlers = {
    onSaveAndClose: vi.fn(),
    onCloseWithoutSaving: vi.fn(),
    onCancel: vi.fn(),
  };
  const target = document.createElement('div');
  document.body.append(target);

  const component = mount(CloseConfirmDialog, {
    target,
    props: { titles, busy, ...handlers },
  });
  flushSync();

  cleanup = () => {
    unmount(component);
    target.remove();
  };

  return handlers;
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

function pressEscape(): void {
  const dialog = document.querySelector('[role="alertdialog"]');
  if (!dialog) throw new Error('diyalog bulunamadı');
  flushSync(() => {
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = '';
});

describe('CloseConfirmDialog', () => {
  it('üç seçeneği de sunar ve kirli dosyayı adıyla anar', () => {
    render(['notlar.md']);

    expect(button('Kaydet ve Kapat')).toBeInstanceOf(HTMLButtonElement);
    expect(button('Kaydetmeden Kapat')).toBeInstanceOf(HTMLButtonElement);
    expect(button('Vazgeç')).toBeInstanceOf(HTMLButtonElement);
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain('notlar.md');
  });

  it('birden çok kirli sekmede sayıyı ve listeyi gösterir', () => {
    render(['a.md', 'b.md']);

    expect(document.body.textContent).toContain('2 dosyada');
    const listed = Array.from(document.querySelectorAll('li')).map((li) => li.textContent);
    expect(listed).toEqual(['a.md', 'b.md']);
  });

  it('Vazgeç yalnızca iptali bildirir; kaydetme ve kapatma çağrılmaz', () => {
    const { onSaveAndClose, onCloseWithoutSaving, onCancel } = render(['notlar.md']);

    click(button('Vazgeç'));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSaveAndClose).not.toHaveBeenCalled();
    expect(onCloseWithoutSaving).not.toHaveBeenCalled();
  });

  it('Escape kapatma isteğini iptal eder', () => {
    const { onSaveAndClose, onCloseWithoutSaving, onCancel } = render(['notlar.md']);

    pressEscape();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSaveAndClose).not.toHaveBeenCalled();
    expect(onCloseWithoutSaving).not.toHaveBeenCalled();
  });

  it('Kaydet ve Kapat seçildiğinde kaydetme yolunu çağırır', () => {
    const { onSaveAndClose, onCloseWithoutSaving, onCancel } = render(['notlar.md']);

    click(button('Kaydet ve Kapat'));

    expect(onSaveAndClose).toHaveBeenCalledTimes(1);
    expect(onCloseWithoutSaving).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Kaydetmeden Kapat yalnızca açık tıklamayla çalışır', () => {
    const { onSaveAndClose, onCloseWithoutSaving, onCancel } = render(['notlar.md']);

    // Diyalog açık olmak tek başına veri kaybına yol açmaz.
    expect(onCloseWithoutSaving).not.toHaveBeenCalled();

    click(button('Kaydetmeden Kapat'));

    expect(onCloseWithoutSaving).toHaveBeenCalledTimes(1);
    expect(onSaveAndClose).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('işlem sürerken tüm düğmeleri kilitler ve Escape iptalini yutar', () => {
    const { onSaveAndClose, onCloseWithoutSaving, onCancel } = render(['notlar.md'], true);

    // Devre dışı düğmeler tarayıcıda tıklama almaz; çift yazma/kapama imkânsız.
    expect(button('Kaydediliyor…').disabled).toBe(true);
    expect(button('Kaydetmeden Kapat').disabled).toBe(true);
    expect(button('Vazgeç').disabled).toBe(true);

    pressEscape();

    expect(onCancel).not.toHaveBeenCalled();
    expect(onCloseWithoutSaving).not.toHaveBeenCalled();
    expect(onSaveAndClose).not.toHaveBeenCalled();
  });
});
