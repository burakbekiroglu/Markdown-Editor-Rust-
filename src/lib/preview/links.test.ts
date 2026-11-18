import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openUrl } from '@tauri-apps/plugin-opener';

import { isExternalUrl, openExternalUrl } from './links';

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.mocked(openUrl).mockClear();
});

describe('isExternalUrl', () => {
  it('kabul edilen şemaları tanır', () => {
    expect(isExternalUrl('https://example.com/yol')).toBe(true);
    expect(isExternalUrl('http://example.com')).toBe(true);
  });

  it('mailto ve diğer şemaları dışa aktarmaz', () => {
    expect(isExternalUrl('mailto:ornek@example.com')).toBe(false);
  });

  it('göreli ve tehlikeli hedefleri reddeder', () => {
    expect(isExternalUrl('goreli/yol.md')).toBe(false);
    expect(isExternalUrl('/mutlak/yol')).toBe(false);
    expect(isExternalUrl('file:///C:/gizli.txt')).toBe(false);
    expect(isExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isExternalUrl('')).toBe(false);
  });
});

describe('openExternalUrl', () => {
  it('dış adresi opener eklentisine iletir', async () => {
    await expect(openExternalUrl('https://example.com/yol')).resolves.toBe(true);
    expect(openUrl).toHaveBeenCalledWith('https://example.com/yol');
  });

  it('uygun olmayan adres için eklentiyi çağırmaz', async () => {
    await expect(openExternalUrl('goreli/yol.md')).resolves.toBe(false);
    await expect(openExternalUrl('javascript:alert(1)')).resolves.toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  });
});
