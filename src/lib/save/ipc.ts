import { invokeCommand } from "../ipc/client";
import type { SaveResult } from "../ipc/types";
import type { SaveFailure } from "./saveTab";

/**
 * Rust tarafındaki atomik kaydetme komutu. Hedef dosya ya tamamen eski ya
 * tamamen yeni içeriktir; hata durumunda dosya değişmez ve `{ code, message }`
 * reddi döner.
 *
 * `expectedHash` verilirse diskteki içerik bu hash ile eşleşmezse yazma
 * reddedilir (`ConflictDetected`). Başarılı yazma yeni içerik hash'ini döner;
 * bu değer bir sonraki kaydetmenin `expectedHash`'i olarak kullanılır.
 *
 * BOM ve CRLF/LF biçimi Rust tarafında diskteki dosyadan tespit edilip aynen
 * yeniden uygulanır; çağıranın satır sonlarını dönüştürmesi gerekmez.
 */
export async function writeWorkspaceFile(
  path: string,
  contents: string,
  expectedHash?: string,
): Promise<SaveResult> {
  return invokeCommand("fs_write_file_atomic", { path, contents, expectedHash });
}

/** Toast metni: tipli hata kodları kullanıcıya anlaşılır cümleye çevrilir. */
export function saveFailureMessage(failure: SaveFailure): string {
  switch (failure.code) {
    case "SaveFailed":
      return `${failure.message} Dosya bir antivirüs veya dizin oluşturucu tarafından kilitlenmiş olabilir; birkaç saniye sonra tekrar deneyin.`;
    case "NotFound":
      return "Klasör artık mevcut değil. Dosyayı farklı bir konuma kaydedin.";
    case "PermissionDenied":
      return "Dosyaya yazma izni yok. Farklı bir konum seçin.";
    case "InvalidPath":
      return `Geçersiz dosya yolu: ${failure.message}`;
    case "PathEscape":
      return "Dosya yolunu çalışma klasörünün dışına kaydetme izni yok.";
    case "SymlinkEscape":
      return "Bağlantı çalışma klasörünün dışına işaret ediyor; kaydetme reddedildi.";
    case "ConflictDetected":
      return `Çakışma: ${failure.message}`;
    case "BinaryFile":
      return "İkili dosya metin olarak kaydedilemez.";
    case "OpenUnsupported":
      return "Dosya UTF-8 metin değil; dönüştürmeden kaydedilemez.";
    case "TooLarge":
      return "Dosya düzenleyicinin boyut sınırını aşıyor.";
    case "WatcherFailed":
      return `Dosya izleyici hatası: ${failure.message}`;
    case "Internal":
      return `Kaydetme başarısız: ${failure.message}`;
  }
}
