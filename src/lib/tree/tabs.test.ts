import { describe, expect, it } from 'vitest';
import {
  applyRenameToTabs,
  applySaveResult,
  closeTab,
  isCloseTabShortcut,
  markDeletedTabs,
  markExistingTabs,
  markTabDirty,
  relocateTab,
  renameTabPaths,
  tabTitle,
  type Tab,
} from './tabs';

function tab(overrides: Partial<Tab> & Pick<Tab, 'id' | 'path'>): Tab {
  return {
    title: tabTitle(overrides.path),
    dirty: false,
    missing: false,
    ...overrides,
  };
}

describe('renameTabPaths', () => {
  it('updates the matching tab path and title, keeping dirty state and id', () => {
    const tabs = [
      tab({ id: 'a', path: 'notlar.md', dirty: true }),
      tab({ id: 'b', path: 'diger.md' }),
    ];

    const renamed = renameTabPaths(tabs, 'notlar.md', 'gunluk.md');

    expect(renamed[0]).toEqual({
      id: 'a',
      path: 'gunluk.md',
      title: 'gunluk.md',
      dirty: true,
      missing: false,
    });
    expect(renamed[1]).toBe(tabs[1]);
  });

  it('keeps content untouched for tabs outside the renamed subtree', () => {
    const tabs = [tab({ id: 'a', path: 'kutu/ic.md', dirty: false })];
    const renamed = renameTabPaths(tabs, 'baska', 'yeni');
    expect(renamed[0].path).toBe('kutu/ic.md');
  });

  it('moves every open tab below a renamed folder', () => {
    const tabs = [
      tab({ id: 'a', path: 'kutu/ic.md', dirty: true }),
      tab({ id: 'b', path: 'kutu/alt/derin.md' }),
      tab({ id: 'c', path: 'kutu.md' }),
    ];

    const renamed = renameTabPaths(tabs, 'kutu', 'arsiv');

    expect(renamed.map((item) => item.path)).toEqual([
      'arsiv/ic.md',
      'arsiv/alt/derin.md',
      'kutu.md',
    ]);
    expect(renamed[0].dirty).toBe(true);
    expect(renamed[1].dirty).toBe(false);
  });
});

describe('applyRenameToTabs', () => {
  it('refuses a rename that collides with another open tab', () => {
    const tabs = [
      tab({ id: 'a', path: 'a.md' }),
      tab({ id: 'b', path: 'b.md', dirty: true }),
    ];

    const result = applyRenameToTabs(tabs, 'a.md', 'b.md');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ENTRY_EXISTS');
  });

  it('allows a case-only rename of the same tab', () => {
    const tabs = [tab({ id: 'a', path: 'not.md', dirty: true })];
    const result = applyRenameToTabs(tabs, 'not.md', 'NOT.md');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tabs[0].path).toBe('NOT.md');
  });
});

describe('markDeletedTabs', () => {
  it('marks only tabs inside the deleted subtree and never closes them', () => {
    const tabs = [
      tab({ id: 'a', path: 'kutu/ic.md', dirty: true }),
      tab({ id: 'b', path: 'kutu2/ic.md' }),
    ];

    const marked = markDeletedTabs(tabs, 'kutu');

    expect(marked).toHaveLength(2);
    expect(marked[0].missing).toBe(true);
    expect(marked[0].dirty).toBe(true);
    expect(marked[1].missing).toBe(false);
  });
});

describe('markTabDirty', () => {
  it('toggles the dirty flag only for the target tab', () => {
    const tabs = [tab({ id: 'a', path: 'a.md' }), tab({ id: 'b', path: 'b.md' })];
    const updated = markTabDirty(tabs, 'b', true);
    expect(updated[0].dirty).toBe(false);
    expect(updated[1].dirty).toBe(true);
  });
});

describe('markExistingTabs', () => {
  it('clears the missing flag when a file reappears and keeps dirty state', () => {
    const tabs = [
      tab({ id: 'a', path: 'kutu/ic.md', dirty: true, missing: true }),
      tab({ id: 'b', path: 'diger.md', missing: true }),
    ];

    const restored = markExistingTabs(tabs, 'kutu');

    expect(restored[0]).toMatchObject({ path: 'kutu/ic.md', missing: false, dirty: true });
    expect(restored[1].missing).toBe(true);
  });
});

describe('applySaveResult', () => {
  it('clears dirty and stores the hash when content is unchanged', () => {
    const tabs = [tab({ id: 'a', path: 'a.md', dirty: true })];
    const saved = applySaveResult(tabs, 'a', 'hash-1', true);
    expect(saved[0]).toMatchObject({ dirty: false, hash: 'hash-1' });
  });

  it('keeps dirty when the editor changed during the write but records the hash', () => {
    const tabs = [tab({ id: 'a', path: 'a.md', dirty: true })];
    const saved = applySaveResult(tabs, 'a', 'hash-1', false);
    expect(saved[0]).toMatchObject({ dirty: true, hash: 'hash-1' });
  });
});

describe('relocateTab', () => {
  it('rebinds a missing tab to a new path and clears the missing flag', () => {
    const tabs = [
      tab({ id: 'a', path: 'eski.md', dirty: true, missing: true }),
      tab({ id: 'b', path: 'diger.md' }),
    ];

    const result = relocateTab(tabs, 'a', 'yeni/konum.md');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tabs[0]).toMatchObject({
        id: 'a',
        path: 'yeni/konum.md',
        title: 'konum.md',
        dirty: true,
        missing: false,
        hash: null,
      });
      expect(result.tabs[1]).toBe(tabs[1]);
    }
  });

  it('refuses a path already open in another tab', () => {
    const tabs = [
      tab({ id: 'a', path: 'eski.md', missing: true }),
      tab({ id: 'b', path: 'b.md' }),
    ];
    const result = relocateTab(tabs, 'a', 'b.md');
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown tab or an empty path', () => {
    const tabs = [tab({ id: 'a', path: 'eski.md', missing: true })];
    expect(relocateTab(tabs, 'yok', 'x.md').ok).toBe(false);
    expect(relocateTab(tabs, 'a', '').ok).toBe(false);
  });
});

describe('closeTab', () => {
  const tabs = [
    tab({ id: 'a', path: 'a.md' }),
    tab({ id: 'b', path: 'b.md', dirty: true }),
    tab({ id: 'c', path: 'c.md' }),
  ];

  it('keeps the remaining order and activates the next tab', () => {
    const result = closeTab(tabs, 'b', 'b');
    expect(result.tabs.map((item) => item.id)).toEqual(['a', 'c']);
    expect(result.activeId).toBe('c');
  });

  it('falls back to the previous tab when the last active tab closes', () => {
    const result = closeTab(tabs, 'c', 'c');
    expect(result.tabs.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.activeId).toBe('b');
  });

  it('keeps the active tab when another tab closes', () => {
    const result = closeTab(tabs, 'c', 'a');
    expect(result.tabs.map((item) => item.id)).toEqual(['b', 'c']);
    expect(result.activeId).toBe('c');
  });

  it('clears the active tab when the only tab closes', () => {
    const only = [tab({ id: 'a', path: 'a.md' })];
    expect(closeTab(only, 'a', 'a')).toEqual({ tabs: [], activeId: null });
  });

  it('ignores an unknown tab id without touching the list', () => {
    const result = closeTab(tabs, 'a', 'yok');
    expect(result.tabs).toBe(tabs);
    expect(result.activeId).toBe('a');
  });
});

describe('isCloseTabShortcut', () => {
  const base = { key: 'w', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };

  it('accepts Ctrl+W', () => {
    expect(isCloseTabShortcut({ ...base, ctrlKey: true })).toBe(true);
  });

  it('accepts Cmd+W', () => {
    expect(isCloseTabShortcut({ ...base, metaKey: true })).toBe(true);
  });

  it('is case insensitive for the key', () => {
    expect(isCloseTabShortcut({ ...base, key: 'W', ctrlKey: true })).toBe(true);
  });

  it('rejects plain w and modifier combinations', () => {
    expect(isCloseTabShortcut(base)).toBe(false);
    expect(isCloseTabShortcut({ ...base, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isCloseTabShortcut({ ...base, ctrlKey: true, altKey: true })).toBe(false);
    expect(isCloseTabShortcut({ ...base, ctrlKey: true, key: 'q' })).toBe(false);
  });
});
