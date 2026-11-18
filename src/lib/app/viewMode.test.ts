import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SPLIT_RATIO,
  DEFAULT_VIEW_MODE,
  SPLIT_RATIO_STORAGE_KEY,
  VIEW_MODE_STORAGE_KEY,
  ViewModeStore,
  clampSplitRatio,
  parseSplitRatio,
  parseViewMode,
} from './viewMode.svelte';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('görünüm modu yardımcıları', () => {
  it('yalnızca bilinen modları kabul eder', () => {
    expect(parseViewMode('editor')).toBe('editor');
    expect(parseViewMode('split')).toBe('split');
    expect(parseViewMode('preview')).toBe('preview');
    expect(parseViewMode('grid')).toBeNull();
    expect(parseViewMode('')).toBeNull();
    expect(parseViewMode(null)).toBeNull();
  });

  it('ayırıcı oranını sınırlar arasında tutar', () => {
    expect(clampSplitRatio(0.5)).toBe(0.5);
    expect(clampSplitRatio(0.05)).toBe(0.2);
    expect(clampSplitRatio(0.95)).toBe(0.8);
    expect(clampSplitRatio(Number.NaN)).toBe(DEFAULT_SPLIT_RATIO);
    expect(clampSplitRatio(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SPLIT_RATIO);
  });

  it('saklanan oranı çözer ve aralığa sıkıştırır', () => {
    expect(parseSplitRatio('0.35')).toBe(0.35);
    expect(parseSplitRatio('0.9')).toBe(0.8);
    expect(parseSplitRatio('abc')).toBeNull();
    expect(parseSplitRatio('')).toBeNull();
    expect(parseSplitRatio(null)).toBeNull();
  });
});

describe('ViewModeStore', () => {
  it('varsayılan olarak bölünmüş modda ve ortada başlar', () => {
    const store = new ViewModeStore();
    expect(store.mode).toBe(DEFAULT_VIEW_MODE);
    expect(store.ratio).toBe(DEFAULT_SPLIT_RATIO);
  });

  it('kayıtlı tercihleri bir kez yükler', () => {
    const store = new ViewModeStore();
    const storage = fakeStorage({
      [VIEW_MODE_STORAGE_KEY]: 'preview',
      [SPLIT_RATIO_STORAGE_KEY]: '0.65',
    });
    store.hydrate(storage);
    expect(store.mode).toBe('preview');
    expect(store.ratio).toBe(0.65);

    // Sonraki hydrate çağrısı yeni değerleri ezmez.
    store.hydrate(fakeStorage({ [VIEW_MODE_STORAGE_KEY]: 'editor' }));
    expect(store.mode).toBe('preview');
  });

  it('bozuk kayıtları yok sayar', () => {
    const store = new ViewModeStore();
    const storage = fakeStorage({
      [VIEW_MODE_STORAGE_KEY]: 'yanlış',
      [SPLIT_RATIO_STORAGE_KEY]: 'NaN',
    });
    store.hydrate(storage);
    expect(store.mode).toBe(DEFAULT_VIEW_MODE);
    expect(store.ratio).toBe(DEFAULT_SPLIT_RATIO);
  });

  it('mod ve oran değişimini depoya yazar', () => {
    const store = new ViewModeStore();
    const storage = fakeStorage();
    store.hydrate(storage);

    store.setMode('editor');
    expect(storage.getItem(VIEW_MODE_STORAGE_KEY)).toBe('editor');

    store.setRatio(0.7);
    expect(storage.getItem(SPLIT_RATIO_STORAGE_KEY)).toBe('0.7');

    // Sınır dışı değer sıkıştırılmış hâliyle saklanır.
    store.setRatio(0.99);
    expect(store.ratio).toBe(0.8);
    expect(storage.getItem(SPLIT_RATIO_STORAGE_KEY)).toBe('0.8');
  });

  it('depo erişimi engelliyse çalışmaya devam eder', () => {
    const store = new ViewModeStore();
    const throwing = fakeStorage();
    throwing.getItem = () => {
      throw new Error('kapalı');
    };
    expect(() => store.hydrate(throwing)).not.toThrow();

    const failingWrite = fakeStorage();
    failingWrite.setItem = () => {
      throw new Error('kota');
    };
    store.hydrate(failingWrite);
    expect(() => store.setMode('preview')).not.toThrow();
    expect(store.mode).toBe('preview');
  });
});
