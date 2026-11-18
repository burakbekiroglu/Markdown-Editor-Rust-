import { describe, expect, it } from 'vitest';

import { rankFiles, RECENT_BONUS, type RankableFile } from './rank';

function file(relativePath: string, isDir = false): RankableFile {
  const parts = relativePath.split('/');
  return { name: parts[parts.length - 1] ?? relativePath, relativePath, isDir };
}

const files: RankableFile[] = [
  file('notlar/gunluk.md'),
  file('notlar/ic.md'),
  file('readme.md'),
  file('arsiv', true),
];

describe('rankFiles', () => {
  it('klasörleri sonuç kümesinden çıkarır', () => {
    const results = rankFiles(files, '');
    expect(results.some((item) => item.entry.isDir)).toBe(false);
    expect(results).toHaveLength(3);
  });

  it('sorguya uymayan dosyaları eler', () => {
    const results = rankFiles(files, 'gnlk');
    expect(results.map((item) => item.entry.relativePath)).toEqual(['notlar/gunluk.md']);
    expect(results[0].indices.length).toBeGreaterThan(0);
  });

  it('son kullanılan dosyayı boş sorguda başa alır', () => {
    const results = rankFiles(files, '', ['readme.md']);
    expect(results[0].entry.relativePath).toBe('readme.md');
    expect(results[0].score).toBe(RECENT_BONUS);
  });

  it('son kullanılanlar kendi aralarında sıra korur', () => {
    const results = rankFiles(files, '', ['notlar/ic.md', 'readme.md']);
    expect(results.slice(0, 2).map((item) => item.entry.relativePath)).toEqual([
      'notlar/ic.md',
      'readme.md',
    ]);
  });

  it('skor eşitse alfabetik sıralar', () => {
    const results = rankFiles([file('b.md'), file('a.md')], '');
    expect(results.map((item) => item.entry.relativePath)).toEqual(['a.md', 'b.md']);
  });

  it('sonuç sayısını sınırlar', () => {
    const many = Array.from({ length: 10 }, (_, index) => file(`dosya-${index}.md`));
    expect(rankFiles(many, '', [], 3)).toHaveLength(3);
    expect(rankFiles(many, '', [], 0)).toHaveLength(10);
  });

  it('son kullanılan dosya sorguya uymuyorsa listelenmez', () => {
    const results = rankFiles(files, 'readme', ['notlar/ic.md']);
    expect(results).toHaveLength(1);
    expect(results[0].entry.relativePath).toBe('readme.md');
  });

  it('tam indeks boyutunda 5 karakterlik sorguyu 100 ms altında sıralar', () => {
    // Rust indeksi en fazla 10.000 girdi döndürür; bu üst sınırda beş
    // karakterlik bir sorgunun sonuç güncellemesi kabul kriterine uymalı.
    const many = Array.from({ length: 10_000 }, (_, index) =>
      file(`notlar/proje-${index}/gunluk-${index}.md`),
    );
    const query = 'proje';

    const started = performance.now();
    const results = rankFiles(many, query, [], 50);
    const elapsed = performance.now() - started;

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(50);
    expect(elapsed).toBeLessThan(100);
  });
});
