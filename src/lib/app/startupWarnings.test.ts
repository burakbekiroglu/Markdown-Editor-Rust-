import { describe, expect, it, vi } from 'vitest';

import { reportStartupWarnings } from './startupWarnings';

describe('reportStartupWarnings', () => {
  it('her uyarıyı tipli hata olarak bildirir ve sayıyı döndürür', async () => {
    const report = vi.fn();
    const read = vi.fn(async () => [
      { code: 'SaveFailed', message: 'oturum dosyası taşınamadı' },
      { code: 'Internal', message: 'oturum dizini bulunamadı' },
    ]);

    await expect(reportStartupWarnings(read, report)).resolves.toBe(2);

    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenNthCalledWith(1, {
      code: 'SaveFailed',
      message: 'oturum dosyası taşınamadı',
    });
    expect(report).toHaveBeenNthCalledWith(2, {
      code: 'Internal',
      message: 'oturum dizini bulunamadı',
    });
  });

  it('uyarı yoksa hiçbir bildirim yapmaz', async () => {
    const report = vi.fn();

    await expect(reportStartupWarnings(async () => [], report)).resolves.toBe(0);

    expect(report).not.toHaveBeenCalled();
  });

  it('okuma hatasını yutmaz, bildirir', async () => {
    const report = vi.fn();
    const failure = { code: 'Internal', message: 'komut çalıştırılamadı' };

    const count = await reportStartupWarnings(async () => {
      throw failure;
    }, report);

    expect(count).toBe(0);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(failure);
  });
});
