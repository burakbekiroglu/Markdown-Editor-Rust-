/**
 * Tipli hata modelinin istemci tarafı: Rust `AppError` ile aynı kod kümesi,
 * normalizasyon ve kullanıcı metinleri.
 *
 * Normalizasyonun sözleşmesi: `normalizeAppError` **daima** kanonik
 * `AppErrorCode` taşıyan bir `AppError` döndürür. Rust olmayan/eski biçimler
 * (düz metin, eski modül kodları, tanınmayan kodlar) sessizce kaybolmaz;
 * `Internal` altında mesajları korunur.
 */

import {
  APP_ERROR_CODE_SET,
  type AppErrorCode,
  type AppErrorPayload,
} from './types';

/** Bilinmeyen bir reddin kullanıcıya gösterilecek son çare metni. */
export const DEFAULT_ERROR_MESSAGE = 'Beklenmeyen bir hata oluştu.';

/** Her kod için kısa başlık; toast başlığı olarak kullanılır. */
export const ERROR_TEXT: Record<AppErrorCode, string> = {
  InvalidPath: 'Geçersiz yol',
  PathEscape: 'Çalışma klasörü dışına erişim engellendi',
  SymlinkEscape: 'Çalışma klasörü dışına işaret eden bağlantı engellendi',
  NotFound: 'Öğe bulunamadı',
  PermissionDenied: 'Erişim reddedildi',
  BinaryFile: 'İkili dosya düzenlenemez',
  OpenUnsupported: 'Dosya UTF-8 olarak açılamıyor',
  TooLarge: 'Dosya çok büyük',
  ConflictDetected: 'Bu adda bir öğe zaten var',
  SaveFailed: 'Kaydetme başarısız',
  WatcherFailed: 'Dosya izleyici çalışmıyor',
  Internal: 'Beklenmeyen bir hata oluştu',
};

/**
 * Her kod için eylem önerisi: kullanıcıya hatadan sonra **ne yapacağını**
 * söyleyen tek cümle. `ERROR_TEXT` başlığı durumu adlandırır, bu tablo ise
 * çıkış yolunu verir; ikisi birlikte gösterilir.
 */
export const ERROR_ACTION: Record<AppErrorCode, string> = {
  InvalidPath: 'Geçerli bir dosya veya klasör seçip yeniden deneyin.',
  PathEscape: 'Çalışma klasörünün içindeki bir dosyayı seçip yeniden deneyin.',
  SymlinkEscape: 'Bağlantı yerine gerçek dosyayı çalışma klasörüne kopyalayıp açın.',
  NotFound: 'Dosyayı yeniden oluşturun veya çalışma klasörünü yeniden açın.',
  PermissionDenied: 'Dosyanın izinlerini kontrol edip yeniden deneyin.',
  BinaryFile: 'Metin tabanlı bir dosya seçip yeniden deneyin.',
  OpenUnsupported:
    'Dosyayı UTF-8 biçimine dönüştürüp yeniden deneyin; düzenleyici yalnızca UTF-8 metin açar.',
  TooLarge: 'Daha küçük bir dosya açın veya dosyayı birkaç parçaya bölün.',
  ConflictDetected: 'Diskteki sürümü yeniden yükleyin ya da farklı bir ad seçin; değişikliğiniz kaydedilmedi.',
  SaveFailed: 'Belgeyi farklı bir konuma kaydedip yeniden deneyin.',
  WatcherFailed: 'Klasörü yeniden açın; değişiklikleri elle yenileyebilirsiniz.',
  Internal: 'İşlemi yeniden deneyin; sorun sürerse uygulamayı yeniden başlatın.',
};

/**
 * Eski modül kodlarının tipli modele eşlemesi. Rust tarafındaki
 * `AppErrorCode::from_legacy` ile aynı tablodur; geçiş tamamlanınca
 * kaldırılabilir.
 */
const LEGACY_CODE_MAP: Readonly<Record<string, AppErrorCode>> = {
  INVALID_NAME: 'InvalidPath',
  INVALID_PATH: 'InvalidPath',
  INVALID_WORKSPACE: 'InvalidPath',
  WORKSPACE_NOT_OPEN: 'InvalidPath',
  NOT_A_DIRECTORY: 'InvalidPath',
  ENTRY_EXISTS: 'ConflictDetected',
  OverwriteBlocked: 'ConflictDetected',
  OVERWRITE_BLOCKED: 'ConflictDetected',
  NOT_FOUND: 'NotFound',
  INVALID_TARGET: 'InvalidPath',
  PATH_OUTSIDE_WORKSPACE: 'PathEscape',
  CROSS_DRIVE: 'PathEscape',
  PERMISSION_DENIED: 'PermissionDenied',
  IO_ERROR: 'Internal',
  OPEN_UNSUPPORTED: 'OpenUnsupported',
  SaveParentMissing: 'SaveFailed',
  SaveTempCreateFailed: 'SaveFailed',
  SaveTempWriteFailed: 'SaveFailed',
  SaveTempFlushFailed: 'SaveFailed',
  SaveTempSyncFailed: 'SaveFailed',
  SaveFileLocked: 'SaveFailed',
};

/** Kanonik ada veya bilinen eski koda karşılık gelen tip; aksi halde `null`. */
export function toAppErrorCode(code: string): AppErrorCode | null {
  if (isAppErrorCode(code)) return code;
  return LEGACY_CODE_MAP[code] ?? null;
}

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === 'string' && APP_ERROR_CODE_SET.has(value);
}

/**
 * IPC hatalarının taşındığı Error alt sınıfı. `code` üzerinde switch edilebilir;
 * `message` kullanıcıya gösterilebilir. `cause` (Error tabanından) normalizasyon
 * öncesi ham değeri taşır: loglama ve hata ayıklama için korunur, kullanıcıya
 * gösterilmez.
 */
export class AppError extends Error implements AppErrorPayload {
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.code = code;
  }

  toPayload(): AppErrorPayload {
    return { code: this.code, message: this.message };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Kodun kısa kullanıcı metni. */
export function errorText(code: AppErrorCode): string {
  return ERROR_TEXT[code];
}

/** Kodun eylem önerisi. */
export function errorAction(code: AppErrorCode): string {
  return ERROR_ACTION[code];
}

/**
 * Bir reddin kullanıcıya gösterilecek tek satırlık metni: kısa başlık +
 * ayrıntı + eylem önerisi. Toast ve satır içi hata yüzeyleri bu eşlemeyi
 * paylaşır; böylece aynı hata her yerde aynı cümleyle görünür ve kullanıcı
 * her zaman bir sonraki adımı görür.
 *
 * Ayrıntı başlıkla aynıysa (ör. `Internal` için varsayılan metin) tekrar
 * edilmez.
 */
export function describeAppError(error: unknown): string {
  const appError = normalizeAppError(error);
  const heading = errorText(appError.code);
  const detail = appError.message.trim();
  // Varsayılan ayrıntı yalnızca sondaki noktayla başlıktan ayrılır; aynı
  // cümleyi iki kez göstermemek için nokta yok sayılarak karşılaştırılır.
  const summary =
    detail.replace(/\.+$/, '') === heading || detail.length === 0
      ? heading
      : `${heading}: ${detail}`;
  return `${summary} — ${errorAction(appError.code)}`;
}

function messageOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Düz nesne daraltması. Tip yüklemi kullanır; `as` daraltması yoktur. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rust tarafından dönen hata zarfını (`{ code, message }`) doğrular.
 *
 * Sözleşme (`src-tauri/src/error.rs`): `code` kanonik `AppErrorCode` adı,
 * `message` serbest metindir. Buradaki doğrulama savunmacıdır — sürüm
 * uyuşmazlığı veya bozuk bir yük sessizce kaybolmaz:
 *
 * - `code` tanınmıyorsa ya da eksikse `Internal`'a indirgenir,
 * - `message` string değilse/boşsa kodun Türkçe varsayılan metni kullanılır,
 * - ne `code` ne `message` taşıyan bir nesne zarf sayılmaz (`null`).
 *
 * Hiçbir aşamada `any` veya `as` daraltması yoktur; alanlar `unknown` olarak
 * okunup tip yüklemleriyle daraltılır.
 */
export function parseAppErrorPayload(value: unknown): AppErrorPayload | null {
  if (!isRecord(value)) return null;

  const rawCode = value['code'];
  const rawMessage = value['message'];
  if (rawCode === undefined && rawMessage === undefined) return null;

  const code = typeof rawCode === 'string' ? (toAppErrorCode(rawCode) ?? 'Internal') : 'Internal';
  return { code, message: messageOf(rawMessage) ?? ERROR_TEXT[code] };
}

/**
 * Tauri komut reddini (veya herhangi bir `unknown` hatayı) tipli `AppError`'a
 * çevirir. Kendisi `AppError` ise aynen döner; diğer her durumda ham değer
 * `cause` olarak korunur. Döndürülen hata **daima** kanonik bir kod taşır.
 */
export function normalizeAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  const payload = parseAppErrorPayload(error);
  if (payload !== null) return new AppError(payload.code, payload.message, error);

  return new AppError('Internal', messageOf(error) ?? DEFAULT_ERROR_MESSAGE, error);
}
