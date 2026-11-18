import { describe, expect, it } from 'vitest';
import { ConflictStore } from './conflictStore.svelte';

function setup(initialEditorContents = 'yerel') {
  const store = new ConflictStore();
  const applied: string[] = [];
  let current = initialEditorContents;
  store.bindEditor('tab-1', {
    contents: () => current,
    applyContents: (contents) => {
      current = contents;
      applied.push(contents);
    },
  });
  return { store, applied };
}

const dirtyTab = { id: 'tab-1', path: 'notlar.md', dirty: true };

describe('ConflictStore', () => {
  it('dirty sekmede bant açar ve editör içeriğini değiştirmez', () => {
    const { store, applied } = setup();

    const decision = store.observe({
      tab: dirtyTab,
      editorContents: 'yerel',
      diskContents: 'disk',
      now: 7,
    });

    expect(decision.action).toBe('conflict');
    expect(store.pending).toHaveLength(1);
    expect(store.pending[0].editorContents).toBe('yerel');
    expect(applied).toEqual([]);
  });

  it('onaysız Diski Yükle hiçbir içerik uygulamaz ve bandı kapatmaz', () => {
    const { store, applied } = setup();
    store.observe({ tab: dirtyTab, editorContents: 'yerel', diskContents: 'disk' });

    expect(store.reload('tab-1', { confirmed: false })).toBe('confirmation-required');
    expect(applied).toEqual([]);
    expect(store.pending).toHaveLength(1);
  });

  it('onaylı Diski Yükle disk içeriğini uygular ve bandı kapatır', () => {
    const { store, applied } = setup();
    store.observe({ tab: dirtyTab, editorContents: 'yerel', diskContents: 'disk' });

    expect(store.reload('tab-1', { confirmed: true })).toBe('applied');
    expect(applied).toEqual(['disk']);
    expect(store.pending).toHaveLength(0);
  });

  it('editör bağlı değilse Diski Yükle içeriği değiştirmez, bandı açık bırakır', () => {
    const store = new ConflictStore();
    store.observe({ tab: dirtyTab, editorContents: 'yerel', diskContents: 'disk' });

    expect(store.reload('tab-1', { confirmed: true })).toBe('editor-unavailable');
    expect(store.pending).toHaveLength(1);
  });

  it('Benimkini Yaz sonrası bant kapanır, editör içeriğine ve diske dokunmaz', () => {
    const { store, applied } = setup();
    store.observe({ tab: dirtyTab, editorContents: 'yerel', diskContents: 'disk' });

    const closed = store.keepMine('tab-1');

    expect(closed?.editorContents).toBe('yerel');
    expect(applied).toEqual([]);
    expect(store.pending).toHaveLength(0);
  });

  it('bant açıkken gelen yeni disk olayında editör içeriği korunur', () => {
    const { store, applied } = setup();
    store.observe({ tab: dirtyTab, editorContents: 'yerel', diskContents: 'ilk' });

    store.observe({ tab: dirtyTab, editorContents: 'yerel + yeni', diskContents: 'ikinci' });

    expect(store.pending[0].diskContents).toBe('ikinci');
    expect(store.pending[0].editorContents).toBe('yerel + yeni');
    expect(applied).toEqual([]);
  });

  it('kapanan sekmenin bekleyen çakışmasını ve tam belge kopyalarını bırakır', () => {
    const { store } = setup();
    store.observe({ tab: dirtyTab, editorContents: 'yerel', diskContents: 'disk' });
    store.observe({
      tab: { id: 'tab-2', path: 'diger.md', dirty: true },
      editorContents: 'ikinci yerel',
      diskContents: 'ikinci disk',
    });

    store.prune(new Set(['tab-2']));

    expect(store.pending.map((conflict) => conflict.tabId)).toEqual(['tab-2']);
  });

  it('temiz sekmede bant açmaz; içerik uygulaması çağıranın sorumluluğundadır', () => {
    const { store, applied } = setup();

    const decision = store.observe({
      tab: { ...dirtyTab, dirty: false },
      editorContents: 'eski',
      diskContents: 'yeni',
    });

    expect(decision).toEqual({ action: 'reload', contents: 'yeni' });
    expect(applied).toEqual([]);
    expect(store.pending).toHaveLength(0);
  });
});
