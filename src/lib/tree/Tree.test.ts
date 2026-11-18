// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import Tree, { type TreeDragHandlers } from './Tree.svelte';
import type { EntryInfo } from './ipc';

function entry(name: string, isDir = false, parent = ''): EntryInfo {
  return {
    name,
    relativePath: parent.length === 0 ? name : `${parent}/${name}`,
    isDir,
    isSymlink: false,
  };
}

const entries = [entry('kutu', true), entry('a.md')];

function mountTree(activePath: string | null = null, drag: TreeDragHandlers | null = null) {
  const target = document.createElement('div');
  target.setAttribute('role', 'tree');
  document.body.append(target);

  const onSelect = vi.fn();
  const onToggle = vi.fn();
  const onOpenFile = vi.fn();

  const instance = mount(Tree, {
    target,
    props: {
      entries,
      expanded: {},
      selectedPath: null,
      activePath,
      renamingPath: null,
      getChildren: () => [],
      getEntry: (rel: string) => entries.find((item) => item.relativePath === rel) ?? null,
      onOpenFile,
      onToggle,
      onSelect,
      onContextMenu: () => {},
      onRenameSubmit: async () => null,
      onRenameCancel: () => {},
      onRenameStart: () => {},
      onDeleteRequest: () => {},
      drag,
    },
  });
  flushSync();

  const rows = Array.from(target.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  return { target, instance, rows, onSelect, onToggle, onOpenFile };
}

function press(row: HTMLElement, key: string): void {
  row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  flushSync();
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Tree keyboard navigation', () => {
  it('roving tabindex: yalnız ilk satır Tab durağıdır', () => {
    const { rows, instance } = mountTree();

    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('tabindex')).toBe('0');
    expect(rows[1].getAttribute('tabindex')).toBe('-1');

    unmount(instance);
  });

  it('ArrowDown/ArrowUp odak ve seçimi görünür satırlar arasında taşır', () => {
    const { rows, instance, onSelect } = mountTree();

    press(rows[0], 'ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
    expect(onSelect).toHaveBeenLastCalledWith(entries[1]);

    press(rows[1], 'ArrowUp');
    expect(document.activeElement).toBe(rows[0]);
    expect(onSelect).toHaveBeenLastCalledWith(entries[0]);

    unmount(instance);
  });

  it('Home/End ilk ve son satıra gider, Enter dosyayı açar', () => {
    const { rows, instance, onOpenFile } = mountTree();

    press(rows[0], 'End');
    expect(document.activeElement).toBe(rows[1]);

    press(rows[1], 'Home');
    expect(document.activeElement).toBe(rows[0]);

    press(rows[1], 'Enter');
    expect(onOpenFile).toHaveBeenCalledWith(entries[1]);

    unmount(instance);
  });

  it('ArrowRight kapalı klasörü açar, ArrowLeft açık klasörü kapatır', () => {
    const { rows, instance, onToggle } = mountTree();

    press(rows[0], 'ArrowRight');
    expect(onToggle).toHaveBeenCalledWith(entries[0]);

    unmount(instance);
  });
});

describe('Tree drag and drop', () => {
  it('satırlar sürükleme olaylarını hedefe iletir ve hedef klasörü vurgular', () => {
    const onDragStart = vi.fn();
    const onDragOver = vi.fn();
    const onDrop = vi.fn();
    const drag: TreeDragHandlers = {
      dropTargetPath: 'kutu',
      onDragStart,
      onDragOver,
      onDragLeave: () => {},
      onDragEnd: () => {},
      onDrop,
    };
    const { rows, instance } = mountTree(null, drag);

    const start = new Event('dragstart', { bubbles: true, cancelable: true });
    rows[1].dispatchEvent(start);
    expect(onDragStart).toHaveBeenCalledWith(start, entries[1]);
    expect(rows[1].getAttribute('draggable')).toBe('true');

    const over = new Event('dragover', { bubbles: true, cancelable: true });
    rows[0].dispatchEvent(over);
    expect(onDragOver).toHaveBeenCalledWith(over, entries[0]);

    const drop = new Event('drop', { bubbles: true, cancelable: true });
    rows[0].dispatchEvent(drop);
    expect(onDrop).toHaveBeenCalledWith(drop, entries[0]);

    // Sürükleme hedefi olan klasör satırı işaretlenir.
    expect(rows[0].classList.contains('drop-target')).toBe(true);
    expect(rows[1].classList.contains('drop-target')).toBe(false);

    unmount(instance);
  });
});

describe('Tree active highlight', () => {
  it('açık sekmenin dosyasını seçimden bağımsız vurgular', () => {
    const { rows, instance } = mountTree('a.md');

    expect(rows[1].classList.contains('active')).toBe(true);
    expect(rows[1].getAttribute('aria-current')).toBe('true');
    expect(rows[0].classList.contains('active')).toBe(false);

    unmount(instance);
  });
});
