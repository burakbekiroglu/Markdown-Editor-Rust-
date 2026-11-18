// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import { openUrl } from '@tauri-apps/plugin-opener';

import { PREVIEW_DEBOUNCE_MS } from './markdown';
import PreviewPane from './PreviewPane.svelte';

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.mocked(openUrl).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('PreviewPane', () => {
  it('renders the supplied source only after the debounce window', () => {
    vi.useFakeTimers();
    const target = document.createElement('div');
    document.body.append(target);

    const component = mount(PreviewPane, {
      target,
      props: { source: '# Başlık', documentPath: 'notlar/a.md' },
    });
    flushSync();

    // Debounce süresi dolmadan önizleme üretilmez.
    expect(target.querySelector('h1')).toBeNull();
    expect(target.textContent).toContain('Önizleme için yazmaya başlayın.');

    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    flushSync();
    expect(target.querySelector('h1')).toBeNull();

    vi.advanceTimersByTime(1);
    flushSync();
    expect(target.querySelector('h1')?.textContent).toBe('Başlık');

    unmount(component);
  });

  it('renders sanitised GFM content and never raw HTML', () => {
    vi.useFakeTimers();
    const target = document.createElement('div');
    document.body.append(target);

    const component = mount(PreviewPane, {
      target,
      props: {
        source: '| a |\n| - |\n| 1 |\n\n<script>alert(1)</script>',
        documentPath: 'a.md',
      },
    });
    flushSync();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    flushSync();

    expect(target.querySelector('table')).not.toBeNull();
    expect(target.querySelector('script')).toBeNull();
    expect(target.textContent).toContain('<script>alert(1)</script>');

    unmount(component);
  });

  it('opens external links through the opener and blocks navigation', async () => {
    vi.useFakeTimers();
    const target = document.createElement('div');
    document.body.append(target);

    const component = mount(PreviewPane, {
      target,
      props: { source: '[örnek](https://example.com/yol)', documentPath: 'a.md' },
    });
    flushSync();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    flushSync();

    const anchor = target.querySelector('a');
    expect(anchor).not.toBeNull();
    vi.useRealTimers();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const reachedTarget = anchor?.dispatchEvent(event) ?? true;

    await vi.waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith('https://example.com/yol');
    });
    // preventDefault çağrıldı: WebView içinde navigasyon denenmez.
    expect(reachedTarget).toBe(false);

    unmount(component);
  });

  it('leaves relative links inert', async () => {
    vi.useFakeTimers();
    const target = document.createElement('div');
    document.body.append(target);

    const component = mount(PreviewPane, {
      target,
      props: { source: '[yerel](notlar/b.md)', documentPath: 'a.md' },
    });
    flushSync();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    flushSync();

    const anchor = target.querySelector('a');
    expect(anchor).not.toBeNull();
    vi.useRealTimers();
    anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(openUrl).not.toHaveBeenCalled();
    unmount(component);
  });
});
