import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearHydratedViews,
  editorState,
  stageHydratedViews,
  takeHydratedView,
} from './editorState.svelte';
import { createSessionData } from './schema';

beforeEach(() => {
  clearHydratedViews();
  editorState.clear();
});

describe('hidrasyon görünümleri', () => {
  it('oturumdan gelen imleç/scroll değerini bir kez verir', () => {
    stageHydratedViews(
      createSessionData({
        tabs: [
          { path: 'a.md', cursor: { anchor: 4, head: 4 }, scroll: { top: 10, left: 0 } },
          { path: 'b.md', cursor: null, scroll: null },
        ],
      }),
    );

    expect(takeHydratedView('a.md')).toEqual({
      cursor: { anchor: 4, head: 4 },
      scroll: { top: 10, left: 0 },
    });
    // Tüketildi: ikinci açılışta eski konum geri gelmez.
    expect(takeHydratedView('a.md')).toBeNull();
    expect(takeHydratedView('b.md')).toBeNull();
  });
});

describe('EditorStateRegistry', () => {
  it('değer değişince sürümü artırır, aynı değerde artırmaz', () => {
    const snapshot = { cursor: { anchor: 1, head: 1 }, scroll: { top: 0, left: 0 } };
    const before = editorState.revision;

    editorState.set('a.md', snapshot);
    expect(editorState.revision).toBe(before + 1);

    editorState.set('a.md', { ...snapshot, cursor: { anchor: 1, head: 1 } });
    expect(editorState.revision).toBe(before + 1);

    editorState.set('a.md', { ...snapshot, cursor: { anchor: 2, head: 2 } });
    expect(editorState.revision).toBe(before + 2);
  });

  it('kapanan sekmelerin kayıtlarını bırakır', () => {
    editorState.set('a.md', { cursor: null, scroll: null });
    editorState.set('b.md', { cursor: null, scroll: null });

    editorState.prune(new Set(['b.md']));

    expect(editorState.get('a.md')).toBeNull();
    expect(editorState.get('b.md')).not.toBeNull();
  });
});
