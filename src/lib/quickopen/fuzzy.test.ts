import { describe, expect, it } from 'vitest';

import { fuzzyMatch, highlightSegments } from './fuzzy';

describe('fuzzyMatch', () => {
  it('harf sırasını koruyan alt diziyi bulur', () => {
    expect(fuzzyMatch('icmd', 'ic.md')).toEqual({
      score: expect.any(Number),
      indices: [0, 1, 3, 4],
    });
  });

  it('büyük/küçük harf duyarsızdır', () => {
    const match = fuzzyMatch('README', 'readme.md');
    expect(match?.indices).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('eşleşmeyen sorguda null döner', () => {
    expect(fuzzyMatch('xyz', 'notlar.md')).toBeNull();
  });

  it('boş sorgu nötr skorla tüm dosyaları eşler', () => {
    expect(fuzzyMatch('   ', 'notlar.md')).toEqual({ score: 0, indices: [] });
  });

  it('segment başındaki eşleşmeyi kelime ortasındakine göre üst sıralar', () => {
    const start = fuzzyMatch('n', 'notlar.md');
    const middle = fuzzyMatch('n', 'banana.md');
    expect(start).not.toBeNull();
    expect(middle).not.toBeNull();
    expect(start!.score).toBeGreaterThan(middle!.score);
  });

  it('bitişik alt dizi eşleşmesini dağınık eşleşmeye göre üst sıralar', () => {
    const contiguous = fuzzyMatch('md', 'readme.md');
    const scattered = fuzzyMatch('md', 'm_x_d.txt');
    expect(contiguous!.score).toBeGreaterThan(scattered!.score);
  });
});

describe('highlightSegments', () => {
  it('eşleşen konumları ayrı parçalara böler', () => {
    expect(highlightSegments('abcd', [1, 2])).toEqual([
      { text: 'a', matched: false },
      { text: 'bc', matched: true },
      { text: 'd', matched: false },
    ]);
  });

  it('eşleşme yoksa tek parça döner', () => {
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc', matched: false }]);
  });

  it('tüm metin eşleşirse tek parça döner', () => {
    expect(highlightSegments('ab', [0, 1])).toEqual([{ text: 'ab', matched: true }]);
  });
});
