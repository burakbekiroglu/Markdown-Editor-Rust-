// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  CommandRegistry,
  commands,
  installShortcuts,
  isTextEntryTarget,
  shortcutFor,
} from './shortcuts';

const base = {
  key: 's',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  target: null,
};

describe('shortcutFor', () => {
  it('Ctrl ve Cmd ile harfleri komutlara çevirir', () => {
    expect(shortcutFor({ ...base, ctrlKey: true })).toBe('save');
    expect(shortcutFor({ ...base, key: 'B', metaKey: true })).toBe('bold');
    expect(shortcutFor({ ...base, key: 'w', ctrlKey: true })).toBe('close-tab');
    expect(shortcutFor({ ...base, key: 'f', ctrlKey: true })).toBe('find');
    expect(shortcutFor({ ...base, key: 'p', ctrlKey: true })).toBe('quick-open');
  });

  it('modsuz, Shift/Alt ile birleşik ve zaten işlenmiş olayları yok sayar', () => {
    expect(shortcutFor(base)).toBeNull();
    expect(shortcutFor({ ...base, ctrlKey: true, shiftKey: true })).toBeNull();
    expect(shortcutFor({ ...base, ctrlKey: true, altKey: true })).toBeNull();
    expect(shortcutFor({ ...base, ctrlKey: true, defaultPrevented: true })).toBeNull();
    expect(shortcutFor({ ...base, ctrlKey: true, key: 'q' })).toBeNull();
  });

  it('metin alanında yalnızca bold/find bastırılır', () => {
    const input = document.createElement('input');
    expect(shortcutFor({ ...base, ctrlKey: true, key: 'b', target: input })).toBeNull();
    expect(shortcutFor({ ...base, ctrlKey: true, key: 'f', target: input })).toBeNull();
    expect(shortcutFor({ ...base, ctrlKey: true, key: 's', target: input })).toBe('save');
    expect(shortcutFor({ ...base, ctrlKey: true, key: 'p', target: input })).toBe('quick-open');
  });

  it('CodeMirror yüzeyini metin girişi saymaz', () => {
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const content = document.createElement('div');
    content.contentEditable = 'true';
    editor.append(content);

    expect(isTextEntryTarget(content)).toBe(false);
    expect(shortcutFor({ ...base, ctrlKey: true, key: 'b', target: content })).toBe('bold');
  });
});

describe('CommandRegistry', () => {
  it('kayıtlı işleyiciyi çalıştırır ve sahibinin kaydı silmesine izin verir', () => {
    const registry = new CommandRegistry();
    let calls = 0;
    const dispose = registry.register('save', () => {
      calls += 1;
      return true;
    });

    expect(registry.has('save')).toBe(true);
    expect(registry.run('save')).toBe(true);
    expect(calls).toBe(1);

    dispose();
    expect(registry.has('save')).toBe(false);
    expect(registry.run('save')).toBe(false);
  });

  it('yeni kayıt öncekini geçersiz kılar ve eski disposer yenisini silmez', () => {
    const registry = new CommandRegistry();
    const first = registry.register('find', () => false);
    const second = registry.register('find', () => true);

    expect(registry.run('find')).toBe(true);
    first();
    expect(registry.run('find')).toBe(true);
    second();
    expect(registry.has('find')).toBe(false);
  });
});

describe('installShortcuts', () => {
  const disposers: (() => void)[] = [];

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.();
    const unregister = (globalThis as { __unregister?: () => void }).__unregister;
    unregister?.();
  });

  it('eşleşen tuşta varsayılanı engeller ve işleyiciyi çağırır', () => {
    const seen: string[] = [];
    disposers.push(
      installShortcuts((id) => {
        seen.push(id);
        return true;
      }),
    );

    const event = new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);

    expect(seen).toEqual(['quick-open']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('işleyici yoksa da varsayılanı engeller', () => {
    disposers.push(installShortcuts(() => false));
    const event = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('kısayol olmayan tuşa dokunmaz', () => {
    disposers.push(installShortcuts(() => true));
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('global commands registry', () => {
  it('tek örnek üzerinden çalışır', () => {
    const dispose = commands.register('quick-open', () => true);
    expect(commands.run('quick-open')).toBe(true);
    dispose();
  });
});
