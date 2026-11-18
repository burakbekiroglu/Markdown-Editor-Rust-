/**
 * Açma öncesi dosya boyutu kapısı.
 *
 * Üç karar vardır:
 * - `open`: dosya küçük, doğrudan açılır.
 * - `confirm`: 2 MiB üzeri; kullanıcı onaylamadan okunmaz.
 * - `reject`: 5 MiB üzeri; `read.rs::MAX_DOCUMENT_BYTES` ile aynı sınır,
 *   böylece devasa dosya hiç okunmaya çalışılmadan tipli hataya düşer.
 *
 * Eşikler Rust sınırıyla hizalıdır: buradaki `reject` kararı yalnızca erken
 * bir kısa yoldur; gerçek güvence `fs_read_document` komutundadır.
 */

/** 2 MiB: bu boyutun üzerindeki dosyalar onay ister. */
export const CONFIRM_OPEN_BYTES = 2 * 1024 * 1024;

/** 5 MiB: bu boyutun üzerindeki dosyalar reddedilir (Rust ile aynı). */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

export type OpenDecision = 'open' | 'confirm' | 'reject';

/**
 * Meta veriden okunan boyuta göre açma kararı. Bilinmeyen boyut (`NaN`,
 * sonsuz, negatif) engellemez: gerçek sınırı okuyan komut uygular.
 */
export function decideOpen(size: number): OpenDecision {
  if (!Number.isFinite(size) || size < 0) return 'open';
  if (size > MAX_DOCUMENT_BYTES) return 'reject';
  if (size > CONFIRM_OPEN_BYTES) return 'confirm';
  return 'open';
}

/** Kullanıcıya gösterilecek boyut metni; eşikler MiB üzerinden. */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
