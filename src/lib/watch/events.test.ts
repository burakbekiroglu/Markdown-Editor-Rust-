import { describe, expect, it } from 'vitest';

import {
  affectedDirectories,
  isSafeRelativePath,
  parseFsChanged,
  refreshedPaths,
  removedPaths,
  type FsChange,
} from './events';

describe('parseFsChanged', () => {
  it('accepts a well-formed batch and drops unsafe or unknown entries', () => {
    const payload = {
      changes: [
        { path: 'notlar.md', kind: 'modify' },
        { path: 'kutu/yeni.md', kind: 'create' },
        { path: 'kutu/eski.md', kind: 'remove' },
        { path: '../kacis.md', kind: 'modify' },
        { path: 'C:/Windows/x.md', kind: 'modify' },
        { path: 'a\\b.md', kind: 'modify' },
        { path: '/mutlak.md', kind: 'modify' },
        { path: '', kind: 'modify' },
        { path: 'bilinmeyen.md', kind: 'rename' },
        'bozuk',
        null,
      ],
    };

    expect(parseFsChanged(payload)).toEqual<FsChange[]>([
      { path: 'notlar.md', kind: 'modify' },
      { path: 'kutu/yeni.md', kind: 'create' },
      { path: 'kutu/eski.md', kind: 'remove' },
    ]);
  });

  it('rejects payloads without a changes array', () => {
    expect(parseFsChanged(null)).toBeNull();
    expect(parseFsChanged({})).toBeNull();
    expect(parseFsChanged({ changes: 'x' })).toBeNull();
    expect(parseFsChanged([])).toBeNull();
  });
});

describe('isSafeRelativePath', () => {
  it('accepts nested relative paths only', () => {
    expect(isSafeRelativePath('a.md')).toBe(true);
    expect(isSafeRelativePath('kutu/alt/a.md')).toBe(true);
    expect(isSafeRelativePath('kutu//a.md')).toBe(false);
    expect(isSafeRelativePath('kutu/../a.md')).toBe(false);
    expect(isSafeRelativePath('./a.md')).toBe(false);
    expect(isSafeRelativePath(42)).toBe(false);
  });
});

describe('change projection', () => {
  const changes: FsChange[] = [
    { path: 'a.md', kind: 'modify' },
    { path: 'kutu/b.md', kind: 'create' },
    { path: 'kutu/alt/c.md', kind: 'remove' },
    { path: 'kutu/alt/c.md', kind: 'remove' },
  ];

  it('lists unique affected parent directories', () => {
    expect(affectedDirectories(changes)).toEqual(['', 'kutu', 'kutu/alt']);
  });

  it('separates removals from content refreshes', () => {
    expect(removedPaths(changes)).toEqual(['kutu/alt/c.md', 'kutu/alt/c.md']);
    expect(refreshedPaths(changes)).toEqual(['a.md', 'kutu/b.md']);
  });
});
