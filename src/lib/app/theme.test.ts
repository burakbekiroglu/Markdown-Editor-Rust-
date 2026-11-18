import { describe, expect, it } from 'vitest';
import { applySystemTheme, applyTheme, themeFromMedia, themeFromTauri } from './theme';

describe('tema çözümleme', () => {
  it('medya sorgusu sonucunu temaya çevirir', () => {
    expect(themeFromMedia(true)).toBe('light');
    expect(themeFromMedia(false)).toBe('dark');
  });

  it('Tauri yükünde yalnızca bilinen temaları kabul eder', () => {
    expect(themeFromTauri('light')).toBe('light');
    expect(themeFromTauri('dark')).toBe('dark');
    expect(themeFromTauri('system')).toBeNull();
    expect(themeFromTauri(undefined)).toBeNull();
    expect(themeFromTauri(1)).toBeNull();
  });

  it('sistem tercihini montajdan önce uygular', () => {
    const root = { dataset: {} as { theme?: string } };
    applySystemTheme(root, () => ({ matches: true }));
    expect(root.dataset.theme).toBe('light');
    applySystemTheme(root, () => ({ matches: false }));
    expect(root.dataset.theme).toBe('dark');
  });

  it('temayı kök elemanın data-theme özniteliğine yazar', () => {
    const root = { dataset: {} as { theme?: string } };
    applyTheme('light', root);
    expect(root.dataset.theme).toBe('light');
    applyTheme('dark', root);
    expect(root.dataset.theme).toBe('dark');
  });
});
