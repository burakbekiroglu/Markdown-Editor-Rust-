import { describe, expect, it } from 'vitest';
import {
  normalizeEntryName,
  normalizeFileName,
  validateName,
} from './nameValidation';

describe('validateName', () => {
  it.each(['a<b.md', 'a>b', 'a:b', 'a"b', 'a/b.md', 'a\\b', 'a|b', 'a?b', 'a*b'])(
    'rejects forbidden character in %s',
    (name) => {
      const result = validateName(name);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_NAME');
    },
  );

  it.each(['CON', 'con', 'nul.txt', 'COM1', 'lpt9.md', 'CON.md', 'aux'])(
    'rejects reserved device name %s',
    (name) => {
      expect(validateName(name).ok).toBe(false);
    },
  );

  it.each(['rapor.', 'rapor ', ' ', '', '.', '..', ' rapor'])(
    'rejects unusable name %j',
    (name) => {
      expect(validateName(name).ok).toBe(false);
    },
  );

  it('rejects control characters and overlong names', () => {
    expect(validateName('a\u0001b').ok).toBe(false);
    expect(validateName('a'.repeat(256)).ok).toBe(false);
    expect(validateName('a'.repeat(255)).ok).toBe(true);
  });

  it('accepts normal Turkish and unicode names', () => {
    expect(validateName('günlük notlar')).toEqual({ ok: true, name: 'günlük notlar' });
    expect(validateName('Çok Önemli.md').ok).toBe(true);
  });
});

describe('normalizeFileName', () => {
  it('appends .md only when the name has no extension', () => {
    expect(normalizeFileName('notlar')).toEqual({ ok: true, name: 'notlar.md' });
    expect(normalizeFileName('notlar.md')).toEqual({ ok: true, name: 'notlar.md' });
    expect(normalizeFileName('notlar.txt')).toEqual({ ok: true, name: 'notlar.txt' });
  });

  it('propagates validation failures', () => {
    const result = normalizeFileName('kötü:ad');
    expect(result.ok).toBe(false);
  });
});

describe('normalizeEntryName', () => {
  it('leaves folder names untouched', () => {
    expect(normalizeEntryName('arsiv', true)).toEqual({ ok: true, name: 'arsiv' });
  });

  it('applies the markdown rule to file names', () => {
    expect(normalizeEntryName('arsiv', false)).toEqual({ ok: true, name: 'arsiv.md' });
  });
});
