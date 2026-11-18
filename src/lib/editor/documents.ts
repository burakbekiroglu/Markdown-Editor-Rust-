/**
 * Açık sekmelerin editör içeriğine bileşen dışından erişim.
 *
 * İçerik `EditorSession` içinde sekme kimliği başına tutulur (arka plan
 * sekmeler dahil). Editör yüzeyi bu erişimi `registerDocumentReader` ile
 * yayınlar; kapanış akışı gibi editör ağacının dışındaki tüketiciler
 * `readTabContents` ile okur.
 *
 * Kayıt tek sahiplidir: son kaydeden okuyucu geçerlidir, bırakma yalnızca
 * kendi okuyucusunu temizler (bileşen yeniden bağlanırsa eski kayıt yenisini
 * ezmez).
 */

/** Sekmenin güncel metni; state yoksa `null`. */
export type DocumentReader = (tabId: string) => string | null;

let reader: DocumentReader | null = null;

/** Okuyucuyu yayınlar; dönen fonksiyon kaydı bırakır. */
export function registerDocumentReader(next: DocumentReader): () => void {
  reader = next;
  return () => {
    if (reader === next) reader = null;
  };
}

/** Sekmenin güncel metni; bağlı editör yoksa `null`. */
export function readTabContents(tabId: string): string | null {
  return reader?.(tabId) ?? null;
}
