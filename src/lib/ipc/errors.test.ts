import { describe, expect, it } from 'vitest';

import {
  AppError,
  DEFAULT_ERROR_MESSAGE,
  ERROR_ACTION,
  ERROR_TEXT,
  describeAppError,
  errorAction,
  errorText,
  isAppError,
  isAppErrorCode,
  normalizeAppError,
  parseAppErrorPayload,
  toAppErrorCode,
} from './errors';
import { APP_ERROR_CODES } from './types';

describe('AppErrorCode kümesi', () => {
  it('Rust enum sırasıyla aynı 11 kanonik kodu taşır', () => {
    expect([...APP_ERROR_CODES]).toEqual([
      'InvalidPath',
      'PathEscape',
      'SymlinkEscape',
      'NotFound',
      'PermissionDenied',
      'BinaryFile',
      'OpenUnsupported',
      'TooLarge',
      'ConflictDetected',
      'SaveFailed',
      'WatcherFailed',
      'Internal',
    ]);
  });

  it('her kod için boş olmayan kullanıcı metni ve eylem önerisi vardır', () => {
    for (const code of APP_ERROR_CODES) {
      expect(errorText(code).length).toBeGreaterThan(0);
      expect(ERROR_TEXT[code]).toBe(errorText(code));
      expect(errorAction(code).length).toBeGreaterThan(0);
      expect(ERROR_ACTION[code]).toBe(errorAction(code));
      // Eylem önerisi Türkçe bir cümle olmalı; boşlukla ayrılmış sözcük taşır.
      expect(errorAction(code)).toMatch(/\s/);
    }
  });

  it('kanonik ve eski kodları tipli koda çevirir', () => {
    expect(toAppErrorCode('TooLarge')).toBe('TooLarge');
    expect(toAppErrorCode('INVALID_NAME')).toBe('InvalidPath');
    expect(toAppErrorCode('WORKSPACE_NOT_OPEN')).toBe('InvalidPath');
    expect(toAppErrorCode('ENTRY_EXISTS')).toBe('ConflictDetected');
    expect(toAppErrorCode('OverwriteBlocked')).toBe('ConflictDetected');
    expect(toAppErrorCode('PATH_OUTSIDE_WORKSPACE')).toBe('PathEscape');
    expect(toAppErrorCode('CROSS_DRIVE')).toBe('PathEscape');
    expect(toAppErrorCode('SaveFileLocked')).toBe('SaveFailed');
    expect(toAppErrorCode('SaveTempSyncFailed')).toBe('SaveFailed');
    expect(toAppErrorCode('IO_ERROR')).toBe('Internal');
    expect(toAppErrorCode('bilinmeyen')).toBeNull();
  });

  it('isAppErrorCode yalnızca kanonik kodları kabul eder', () => {
    expect(isAppErrorCode('BinaryFile')).toBe(true);
    expect(isAppErrorCode('INVALID_NAME')).toBe(false);
    expect(isAppErrorCode(42)).toBe(false);
    expect(isAppErrorCode(null)).toBe(false);
  });
});

describe('normalizeAppError', () => {
  it('Rust { code, message } reddini aynen tipli hataya çevirir', () => {
    const error = normalizeAppError({ code: 'PathEscape', message: 'kök dışına çıktı' });

    expect(error).toBeInstanceOf(AppError);
    expect(error.name).toBe('AppError');
    expect(error.code).toBe('PathEscape');
    expect(error.message).toBe('kök dışına çıktı');
    expect(error.toPayload()).toEqual({ code: 'PathEscape', message: 'kök dışına çıktı' });
  });

  it('eski modül kodlarını tipli koda eşler, mesajı korur', () => {
    const error = normalizeAppError({ code: 'ENTRY_EXISTS', message: 'bu adda bir öğe zaten var' });

    expect(error.code).toBe('ConflictDetected');
    expect(error.message).toBe('bu adda bir öğe zaten var');
  });

  it('mesaj yoksa kodun kullanıcı metnini kullanır', () => {
    expect(normalizeAppError({ code: 'NotFound' }).message).toBe(ERROR_TEXT.NotFound);
    expect(normalizeAppError({ code: 'TooLarge', message: '   ' }).message).toBe(
      ERROR_TEXT.TooLarge,
    );
  });

  it('tanınmayan kodu Internal yapar ve mesajı kaybetmez', () => {
    const error = normalizeAppError({ code: 'BozukKod', message: 'ham ayrıntı' });

    expect(error.code).toBe('Internal');
    expect(error.message).toBe('ham ayrıntı');
  });

  it('düz metin ve tanımsız redleri Internal altında toplar', () => {
    expect(normalizeAppError('disk dolu').toPayload()).toEqual({
      code: 'Internal',
      message: 'disk dolu',
    });
    expect(normalizeAppError(undefined).toPayload()).toEqual({
      code: 'Internal',
      message: DEFAULT_ERROR_MESSAGE,
    });
    expect(normalizeAppError(null).message).toBe(DEFAULT_ERROR_MESSAGE);
    expect(normalizeAppError(42).message).toBe(DEFAULT_ERROR_MESSAGE);
  });

  it('Error örneğinin mesajını korur', () => {
    const error = normalizeAppError(new Error('beklenmeyen çökme'));

    expect(error.code).toBe('Internal');
    expect(error.message).toBe('beklenmeyen çökme');
  });

  it('zaten AppError ise aynı nesneyi döndürür', () => {
    const original = new AppError('WatcherFailed', 'izleyici durdu');

    expect(normalizeAppError(original)).toBe(original);
    expect(isAppError(original)).toBe(true);
    expect(isAppError({ code: 'Internal', message: 'x' })).toBe(false);
  });

  it('normalizasyon öncesi ham değeri `cause` olarak korur', () => {
    const envelope = { code: 'SaveFailed', message: 'dosya kilitli' };

    expect(normalizeAppError(envelope).cause).toBe(envelope);
    expect(normalizeAppError('disk dolu').cause).toBe('disk dolu');
    // AppError zaten tipliyse yeniden sarmalanmaz.
    const typed = new AppError('NotFound', 'yok');
    expect(normalizeAppError(typed).cause).toBeUndefined();
  });
});

describe('parseAppErrorPayload', () => {
  it('Rust zarfını (code + message) doğrular', () => {
    expect(parseAppErrorPayload({ code: 'NotFound', message: 'öğe yok' })).toEqual({
      code: 'NotFound',
      message: 'öğe yok',
    });
    expect(parseAppErrorPayload({ code: 'ENTRY_EXISTS', message: 'zaten var' })).toEqual({
      code: 'ConflictDetected',
      message: 'zaten var',
    });
    // `message` yoksa kodun Türkçe varsayılan metni kullanılır.
    expect(parseAppErrorPayload({ code: 'TooLarge' })).toEqual({
      code: 'TooLarge',
      message: ERROR_TEXT.TooLarge,
    });
  });

  it('zarf olmayan değerleri reddeder', () => {
    expect(parseAppErrorPayload(null)).toBeNull();
    expect(parseAppErrorPayload(42)).toBeNull();
    expect(parseAppErrorPayload('disk dolu')).toBeNull();
    expect(parseAppErrorPayload([])).toBeNull();
    expect(parseAppErrorPayload({})).toBeNull();
  });

  it('tanınmayan veya yanlış tipli kodu Internal yapar, metni kaybetmez', () => {
    expect(parseAppErrorPayload({ code: 'BozukKod', message: 'ham ayrıntı' })).toEqual({
      code: 'Internal',
      message: 'ham ayrıntı',
    });
    expect(parseAppErrorPayload({ code: 42, message: 'ham ayrıntı' })).toEqual({
      code: 'Internal',
      message: 'ham ayrıntı',
    });
    expect(parseAppErrorPayload({ code: 'NotFound', message: { nested: true } })).toEqual({
      code: 'NotFound',
      message: ERROR_TEXT.NotFound,
    });
  });
});

describe('describeAppError', () => {
  it('kısa başlık, ayrıntı ve eylem önerisini tek satırda birleştirir', () => {
    expect(describeAppError({ code: 'PathEscape', message: 'kök dışına çıktı' })).toBe(
      `Çalışma klasörü dışına erişim engellendi: kök dışına çıktı — ${ERROR_ACTION.PathEscape}`,
    );
  });

  it('her kod için çıktı eylem önerisiyle biter', () => {
    for (const code of APP_ERROR_CODES) {
      const message = describeAppError({ code, message: 'ayrıntı' });
      expect(message.endsWith(errorAction(code))).toBe(true);
    }
  });

  it('tanınmayan reddi de kullanıcı metnine çevirir', () => {
    expect(describeAppError('disk dolu')).toBe(
      `${ERROR_TEXT.Internal}: disk dolu — ${ERROR_ACTION.Internal}`,
    );
    // Varsayılan ayrıntı başlıkla aynı olduğu için yinelenmez.
    expect(describeAppError(undefined)).toBe(
      `${ERROR_TEXT.Internal} — ${ERROR_ACTION.Internal}`,
    );
  });
});
