import { describe, expect, it } from 'vitest';

import {
  CONFIRM_OPEN_BYTES,
  MAX_DOCUMENT_BYTES,
  decideOpen,
  formatMegabytes,
} from './openGuard';

describe('decideOpen', () => {
  it('2 MB altındaki ve tam sınırdaki dosyayı onaysız açar', () => {
    expect(decideOpen(0)).toBe('open');
    expect(decideOpen(1024)).toBe('open');
    expect(decideOpen(CONFIRM_OPEN_BYTES)).toBe('open');
  });

  it('2 MB üzeri, 5 MB altındaki dosya için onay ister', () => {
    expect(decideOpen(CONFIRM_OPEN_BYTES + 1)).toBe('confirm');
    expect(decideOpen(MAX_DOCUMENT_BYTES - 1)).toBe('confirm');
  });

  it('5 MB üzerindeki dosyayı reddeder, tam sınırı onaya bırakır', () => {
    expect(decideOpen(MAX_DOCUMENT_BYTES)).toBe('confirm');
    expect(decideOpen(MAX_DOCUMENT_BYTES + 1)).toBe('reject');
  });

  it('bilinmeyen boyutu engellemez; sınırı okuyan komut uygular', () => {
    expect(decideOpen(Number.NaN)).toBe('open');
    expect(decideOpen(Number.POSITIVE_INFINITY)).toBe('open');
    expect(decideOpen(-1)).toBe('open');
  });
});

describe('formatMegabytes', () => {
  it('baytı tek ondalıklı MB metnine çevirir', () => {
    expect(formatMegabytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatMegabytes(5.5 * 1024 * 1024)).toBe('5.5 MB');
  });
});
