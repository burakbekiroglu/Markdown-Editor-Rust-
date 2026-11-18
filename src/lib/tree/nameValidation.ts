/**
 * Windows dosya adı doğrulaması.
 *
 * Rust tarafındaki `src-tauri/src/fs_ops.rs` ile aynı kuralları uygular; asıl
 * otorite backend'dir. Buradaki kopya yalnızca kullanıcıya göndermeden önce
 * anında geri bildirim vermek için kullanılır.
 */

export const FORBIDDEN_NAME_CHARS = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'] as const;

const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CONIN$',
  'CONOUT$',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

export const MAX_NAME_LENGTH = 255;
export const MD_EXTENSION = '.md';

export type NameErrorCode = 'INVALID_NAME';

export type NameValidation =
  | { ok: true; name: string }
  | { ok: false; code: NameErrorCode; reason: string };

function invalid(reason: string): NameValidation {
  return { ok: false, code: 'INVALID_NAME', reason };
}

function controlChar(value: string): string | null {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return char;
  }
  return null;
}

/**
 * Kullanıcının girdiği tek bir dosya/klasör adını doğrular.
 * Geçerliyse baştaki/sondaki boşlukları kırpılmış adı döndürür.
 */
export function validateName(raw: string): NameValidation {
  if (raw.length === 0) return invalid('Ad boş olamaz.');
  if (raw.trim().length === 0) return invalid('Ad yalnızca boşluktan oluşamaz.');
  if (raw !== raw.trim()) {
    return invalid('Ad başında veya sonunda boşluk olamaz.');
  }
  if (raw.endsWith('.')) return invalid('Ad nokta ile bitemez.');
  if (raw === '.' || raw === '..') return invalid('"." ve ".." ad olarak kullanılamaz.');
  if (raw.length > MAX_NAME_LENGTH) {
    return invalid(`Ad en fazla ${MAX_NAME_LENGTH} karakter olabilir.`);
  }

  for (const forbidden of FORBIDDEN_NAME_CHARS) {
    if (raw.includes(forbidden)) {
      return invalid(`Ad içinde "${forbidden}" karakteri kullanılamaz.`);
    }
  }

  const control = controlChar(raw);
  if (control !== null) {
    return invalid('Ad kontrol karakteri içeremez.');
  }

  const base = raw.split('.')[0]?.toUpperCase() ?? '';
  if (RESERVED_NAMES.has(base)) {
    return invalid(`"${base}" Windows tarafından ayrılmış bir addır.`);
  }

  return { ok: true, name: raw };
}

/**
 * Yeni dosya adı: uzantı yoksa `.md` eklenir.
 */
export function normalizeFileName(raw: string): NameValidation {
  const validated = validateName(raw);
  if (!validated.ok) return validated;

  const dot = validated.name.lastIndexOf('.');
  if (dot <= 0) {
    return { ok: true, name: `${validated.name}${MD_EXTENSION}` };
  }
  return validated;
}

/** Yeni klasör veya yeniden adlandırma: uzantı eklenmez. */
export function normalizeEntryName(raw: string, isDir: boolean): NameValidation {
  return isDir ? validateName(raw) : normalizeFileName(raw);
}
