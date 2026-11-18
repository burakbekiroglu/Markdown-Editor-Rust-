/**
 * Çakışma algılama için disk okuma yüzeyi.
 *
 * Okuma, kaydetmeyle aynı çalışma kökü sınırlamasından geçer; ikili veya
 * boyut sınırını aşan dosyalar tipli hatayla reddedilir. Çağıranlar hatayı
 * "içeriği değiştirme" olarak yorumlamalıdır.
 *
 * `readDocument` ayrıca ham baytların içerik hash'ini döner. Bu değer
 * `writeWorkspaceFile`'a `expectedHash` olarak verildiğinde, arada diskte
 * oluşan bir değişiklik yazmayı `ConflictDetected` ile reddeder.
 */

import { invokeCommand } from '../ipc/client';
import type { DocumentText, FileMetadata } from '../ipc/types';

/** Çalışma köküne göreli yolu UTF-8 metin olarak okur. */
export function readWorkspaceFile(path: string): Promise<string> {
  return invokeCommand('fs_read_file', { path });
}

/**
 * Açmadan önce boyut kapısı için meta veri. İçerik okunmaz; yalnızca `size`
 * alanı kullanılır, böylece büyük dosya onaylanmadan belleğe alınmaz.
 */
export function fileMetadata(path: string): Promise<FileMetadata> {
  return invokeCommand('fs_metadata', { path });
}

/** Metin ve içerik hash'ini birlikte okur (kaydetme çakışma kontrolü). */
export function readDocument(path: string): Promise<DocumentText> {
  return invokeCommand('fs_read_document', { path });
}
