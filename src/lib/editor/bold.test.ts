import { describe, expect, it } from 'vitest';

import { computeBoldEdit, expandWord } from './bold';

/** Düzenlemeyi metne uygular ve yeni seçimi döner (round-trip testleri için). */
function apply(text: string, from: number, to: number): { text: string; from: number; to: number } {
  const edit = computeBoldEdit(text, from, to);
  const next = text.slice(0, edit.changes.from) + edit.changes.insert + text.slice(edit.changes.to);
  return { text: next, from: edit.anchor, to: edit.head };
}

describe('expandWord', () => {
  it('imlecin içinde bulunduğu kelimeyi genişletir', () => {
    expect(expandWord('merhaba dünya', 3)).toEqual({ start: 0, end: 7 });
  });

  it('yol ayırıcılarını kelime sınırı sayar', () => {
    expect(expandWord('kutu/ic.md', 6)).toEqual({ start: 5, end: 7 });
  });

  it('kelime yoksa boş aralık döner', () => {
    expect(expandWord('  ', 1)).toEqual({ start: 1, end: 1 });
  });
});

describe('computeBoldEdit', () => {
  it('seçimi ** ile sarar ve iç metni seçili bırakır', () => {
    expect(computeBoldEdit('hello world', 0, 5)).toEqual({
      changes: { from: 0, to: 5, insert: '**hello**' },
      anchor: 2,
      head: 7,
    });
  });

  it('dışarıdan sarılı seçimi çözer', () => {
    expect(computeBoldEdit('**hello**', 2, 7)).toEqual({
      changes: { from: 0, to: 9, insert: 'hello' },
      anchor: 0,
      head: 5,
    });
  });

  it('seçim işaretleri kendisi içeriyorsa çözer', () => {
    expect(computeBoldEdit('**hello**', 0, 9)).toEqual({
      changes: { from: 0, to: 9, insert: 'hello' },
      anchor: 0,
      head: 5,
    });
  });

  it('seçim yokken kelimeyi genişletip sarar', () => {
    expect(computeBoldEdit('merhaba dünya', 2, 2)).toEqual({
      changes: { from: 0, to: 7, insert: '**merhaba**' },
      anchor: 2,
      head: 9,
    });
  });

  it('kelime yoksa imleci **** ortasına yerleştirir', () => {
    expect(computeBoldEdit('  ', 1, 1)).toEqual({
      changes: { from: 1, to: 1, insert: '****' },
      anchor: 3,
      head: 3,
    });
  });

  it('ikinci uygulama ilkini geri alır (seçim round-trip)', () => {
    const wrapped = apply('hello world', 0, 5);
    expect(wrapped.text).toBe('**hello** world');
    expect(wrapped.text.slice(wrapped.from, wrapped.to)).toBe('hello');

    const unwrapped = apply(wrapped.text, wrapped.from, wrapped.to);
    expect(unwrapped.text).toBe('hello world');
    expect(unwrapped.text.slice(unwrapped.from, unwrapped.to)).toBe('hello');
  });

  it('kelime genişletmede de round-trip çalışır', () => {
    const wrapped = apply('merhaba', 2, 2);
    expect(wrapped.text).toBe('**merhaba**');
    const unwrapped = apply(wrapped.text, wrapped.from, wrapped.to);
    expect(unwrapped.text).toBe('merhaba');
  });

  it('boş belgede imleç **** ortasına yerleşir', () => {
    expect(computeBoldEdit('', 0, 0)).toEqual({
      changes: { from: 0, to: 0, insert: '****' },
      anchor: 2,
      head: 2,
    });
  });

  it('boşluk kenarında kelimeyi sarar, boşluğu içine almaz', () => {
    const edit = computeBoldEdit('  kelime  ', 3, 3);
    expect(edit.changes).toEqual({ from: 2, to: 8, insert: '**kelime**' });
  });

  it('çok satırlı seçimi tek çiftle sarar', () => {
    const text = 'bir\niki';
    const edit = computeBoldEdit(text, 0, text.length);
    expect(edit.changes).toEqual({ from: 0, to: 7, insert: '**bir\niki**' });
    expect(edit.anchor).toBe(2);
    expect(edit.head).toBe(9);
  });
});
