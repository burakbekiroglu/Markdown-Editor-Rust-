/**
 * `fs:changed` olaylarını açık sekmelerle eşleştiren çakışma koordinatörü.
 *
 * Tek kural: **bağlı editörü olmayan sekmenin içeriğine dokunulmaz.** Disk
 * okuması başarısız olursa da hiçbir içerik değişmez. Dirty sekmede karar
 * `ConflictStore` üzerinden sarı banda gider; bant kullanıcı kararı verene
 * kadar editör içeriği ve dirty işareti olduğu gibi kalır.
 *
 * Sekme/e1itör arayüzü ayrı görevlerde bağlanır; bu modül yalnızca olaydan
 * karara giden yolu tanımlar ve enjekte edilen bağımlılıklarla test edilir.
 */

import { refreshedPaths, type FsChange } from '../watch/events';
import type { ConflictTab } from './conflict';
import type { ConflictStore } from './conflictStore.svelte';

export interface ExternalChangeContext {
  /**
   * Açık sekmelerin **o anki** görünümü. Okuma asenkron olduğu için bir
   * fonksiyonla alınır: kullanıcı okuma sürerken yazmaya başladıysa karar
   * güncel dirty durumuyla verilir ve içerik ezilmez.
   */
  tabs(): readonly ConflictTab[];
  /** Çakışma deposu; editör bağlantılarının tek kaynağıdır. */
  conflicts: ConflictStore;
  /** Diskteki içeriği okur; hata durumunda çağıran hiçbir şeyi ezmez. */
  readFile(path: string): Promise<string>;
  /** Temiz sekme sessizce yenilendiğinde dirty işaretini temizler. */
  markClean(tabId: string): void;
  /** Okuma hatası gibi ölümcül olmayan sorunları bildirir. */
  onError?(error: unknown): void;
}

/**
 * Değişiklik partisini işler. Yalnızca `modify`/`create` olayları içerik
 * tazelemesi gerektirir; `remove` yolunda içerik okunmaz.
 */
export async function handleExternalChanges(
  changes: readonly FsChange[],
  context: ExternalChangeContext,
): Promise<void> {
  const paths = new Set(refreshedPaths(changes));
  if (paths.size === 0) return;

  for (const candidate of context.tabs()) {
    if (!paths.has(candidate.path)) continue;

    let diskContents: string;
    try {
      diskContents = await context.readFile(candidate.path);
    } catch (error) {
      context.onError?.(error);
      continue;
    }

    // Okuma sürerken sekme kapanmış/yeniden adlandırılmış veya dirty hale
    // gelmiş olabilir; karar daima güncel görünümle verilir.
    const tab = context.tabs().find((item) => item.id === candidate.id);
    if (!tab || tab.path !== candidate.path) continue;

    // Editör bağlı değilse o sekmenin içeriği bilinmiyor demektir; karşılaştırma
    // yapılamaz ve hiçbir içerik yazılmaz.
    const editorContents = context.conflicts.editorContents(tab.id);
    if (editorContents === null) continue;

    const decision = context.conflicts.observe({
      tab,
      editorContents,
      diskContents,
    });

    if (decision.action === 'reload') {
      if (context.conflicts.applyReload(tab.id, decision.contents)) {
        context.markClean(tab.id);
      }
    }
  }
}
