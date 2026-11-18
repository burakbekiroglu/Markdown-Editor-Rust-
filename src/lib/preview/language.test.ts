import { describe, expect, it } from 'vitest';

import {
  HIGHLIGHT_LANGUAGE_IDS,
  languageFromClassName,
  normalizeLanguage,
} from './language';

describe('highlight language mapping', () => {
  it('maps the promised language aliases', () => {
    expect(normalizeLanguage('js')).toBe('javascript');
    expect(normalizeLanguage('TS')).toBe('typescript');
    expect(normalizeLanguage('json')).toBe('json');
    expect(normalizeLanguage('sh')).toBe('bash');
    expect(normalizeLanguage('rs')).toBe('rust');
    expect(normalizeLanguage('py')).toBe('python');
    expect(normalizeLanguage('html')).toBe('xml');
    expect(normalizeLanguage('css')).toBe('css');
    expect(normalizeLanguage('md')).toBe('markdown');
  });

  it('ignores extra fence attributes and surrounding whitespace', () => {
    expect(normalizeLanguage('  js title="x"  ')).toBe('javascript');
  });

  it('refuses languages outside the subset', () => {
    expect(normalizeLanguage('go')).toBeNull();
    expect(normalizeLanguage('')).toBeNull();
    expect(normalizeLanguage(null)).toBeNull();
    expect(normalizeLanguage(undefined)).toBeNull();
  });

  it('extracts the language from a class list', () => {
    expect(languageFromClassName('hljs language-ts extra')).toBe('typescript');
    expect(languageFromClassName('language-go')).toBeNull();
    expect(languageFromClassName('hljs')).toBeNull();
  });

  it('promises exactly the nine documented highlight ids', () => {
    expect([...HIGHLIGHT_LANGUAGE_IDS]).toEqual([
      'javascript',
      'typescript',
      'json',
      'bash',
      'rust',
      'python',
      'xml',
      'css',
      'markdown',
    ]);
  });
});
