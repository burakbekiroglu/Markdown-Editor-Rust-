import { describe, expect, it } from 'vitest';
import { decideExternalChange, type ConflictTab, type PendingConflict } from './conflict';
import { toLines, lineDiff } from './diff';

const tab = (overrides: Partial<ConflictTab> = {}): ConflictTab => ({
  id: 'tab-1',
  path: 'notlar.md',
  dirty: false,
  ...overrides,
});

const pendingConflict = (overrides: Partial<PendingConflict> = {}): PendingConflict => ({
  tabId: 'tab-1',
  path: 'notlar.md',
  editorContents: 'yerel sürüm',
  diskContents: 'ilk disk sürümü',
  detectedAt: 1_000,
  ...overrides,
});

describe('decideExternalChange', () => {
  it('temiz sekmede diski sessizce yükler', () => {
    const decision = decideExternalChange({
      tab: tab({ dirty: false }),
      editorContents: 'eski',
      diskContents: 'yeni disk',
      pending: null,
      now: 5,
    });

    expect(decision).toEqual({ action: 'reload', contents: 'yeni disk' });
  });

  it('dirty sekmede editör içeriğini korur ve bant açar', () => {
    const decision = decideExternalChange({
      tab: tab({ dirty: true }),
      editorContents: 'kaydedilmemiş',
      diskContents: 'dış değişiklik',
      pending: null,
      now: 5,
    });

    expect(decision).toEqual({
      action: 'conflict',
      conflict: {
        tabId: 'tab-1',
        path: 'notlar.md',
        editorContents: 'kaydedilmemiş',
        diskContents: 'dış değişiklik',
        detectedAt: 5,
      },
    });
  });

  it('bant açıkken gelen yeni olay editör içeriğine dokunmaz, yalnızca disk anlık görüntüsünü tazeler', () => {
    const existing = pendingConflict();

    const decision = decideExternalChange({
      tab: tab({ dirty: true }),
      editorContents: 'kullanıcı yazmaya devam etti',
      diskContents: 'ikinci dış değişiklik',
      pending: existing,
    });

    expect(decision.action).toBe('conflict');
    if (decision.action !== 'conflict') throw new Error('beklenmeyen karar');
    expect(decision.conflict.editorContents).toBe('kullanıcı yazmaya devam etti');
    expect(decision.conflict.diskContents).toBe('ikinci dış değişiklik');
    expect(decision.conflict.detectedAt).toBe(existing.detectedAt);
  });

  it('içerikler aynıysa (kendi kaydetmenin yankısı) karar gereksizdir', () => {
    const decision = decideExternalChange({
      tab: tab({ dirty: true }),
      editorContents: 'aynı',
      diskContents: 'aynı',
      pending: pendingConflict({ editorContents: 'aynı', diskContents: 'aynı' }),
    });

    expect(decision).toEqual({ action: 'unchanged' });
  });
});

describe('lineDiff', () => {
  it('disk ve editör içeriğini satır satır karşılaştırır', () => {
    const lines = lineDiff('bir\niki\nüç', 'bir\niki değişti\nüç');

    expect(lines).toEqual([
      { kind: 'equal', text: 'bir', oldLine: 1, newLine: 1 },
      { kind: 'removed', text: 'iki', oldLine: 2, newLine: null },
      { kind: 'added', text: 'iki değişti', oldLine: null, newLine: 2 },
      { kind: 'equal', text: 'üç', oldLine: 3, newLine: 3 },
    ]);
  });

  it('CRLF ve sondaki satır sonunu normalize eder', () => {
    expect(lineDiff('a\r\nb\r\n', 'a\nb')).toEqual([
      { kind: 'equal', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'equal', text: 'b', oldLine: 2, newLine: 2 },
    ]);
    expect(toLines('')).toEqual([]);
  });

  it('yalnızca ekleme ve yalnızca silmeyi doğru işaretler', () => {
    const added = lineDiff('a', 'a\nb');
    expect(added[1]).toEqual({ kind: 'added', text: 'b', oldLine: null, newLine: 2 });

    const removed = lineDiff('a\nb', 'a');
    expect(removed[1]).toEqual({ kind: 'removed', text: 'b', oldLine: 2, newLine: null });
  });

  it('bellek sınırı aşıldığında da doğru (kaba) fark üretir', () => {
    const lines = lineDiff('a\nb', 'a\nc', { maxCells: 0 });
    expect(lines.map((line) => line.kind)).toEqual(['equal', 'removed', 'added']);
  });
});
