/**
 * "Kaydet ve Kapat" çekirdeği.
 *
 * Kapanış onayı verildiğinde kirli sekmeler **sırayla** yazılır: her sekme
 * `saveTab` üzerinden atomik olarak kaydedilir ve bir sonraki yazma ancak
 * önceki başarılı olduktan sonra başlar. İlk hatada kalan sekmeler yazılmaz,
 * kapanma iptal edilir ve hata tek kanaldan (`notifyError`) bildirilir.
 *
 * `saveTab` sözleşmesi korunur: dirty işareti yalnızca başarılı yazmadan
 * sonra temizlenir, hata durumunda sekme dirty kalır.
 */

import {
  saveTab,
  type SaveDeps,
  type SaveFailure,
  type SaveableTab,
} from '../save/saveTab';

/** Sıralı yazımın bağımlılıkları. */
export interface SaveAllDeps {
  /** Sekmenin güncel metni (arka plan sekmeler dahil). */
  readContents(tabId: string): string | null;
  /** `fs_write_file_atomic` sarmalayıcısı. */
  writeFile: SaveDeps['writeFile'];
  /** Başarılı yazmadan sonra store'u günceller; `unchanged` yazma sürerken
   * içeriğin değişmediğini gösterir (değiştiyse sekme dirty kalır). */
  markSaved(id: string, hash: string | null, unchanged: boolean): void;
  /** Yazma hatasını kullanıcıya bildirir. */
  notifyError(failure: SaveFailure): void;
  /** Çakışma bandına iletim (isteğe bağlı). */
  onConflict?: SaveDeps['onConflict'];
}

export type SaveAllOutcome =
  | { status: 'idle' }
  | { status: 'saved'; saved: number }
  | { status: 'failed'; tabId: string; error: SaveFailure };

/**
 * Kirli sekmeleri listedeki sırayla kaydeder.
 *
 * - Dirty sekme yoksa hiç yazmaz (`idle`).
 * - Her yazma başarılıysa `saved` ve yazılan sekme sayısı döner.
 * - Herhangi bir yazma başarısızsa döngü kesilir (`failed`); sonraki sekmeler
 *   yazılmaz ve kapanma çağıran tarafından iptal edilir.
 */
export async function saveDirtyTabs(
  tabs: readonly SaveableTab[],
  deps: SaveAllDeps,
): Promise<SaveAllOutcome> {
  const dirty = tabs.filter((tab) => tab.dirty);
  if (dirty.length === 0) return { status: 'idle' };

  for (const tab of dirty) {
    const contents = deps.readContents(tab.id);
    if (contents === null) {
      // İçerik yoksa yazma denenmez: editörsüz bir sekme sessizce atlanmaz.
      const error: SaveFailure = {
        code: 'Internal',
        message: `"${tab.path}" sekmesinin içeriği bulunamadı; kapatma iptal edildi.`,
      };
      deps.notifyError(error);
      return { status: 'failed', tabId: tab.id, error };
    }

    const outcome = await saveTab(tab, contents, {
      writeFile: deps.writeFile,
      notifyError: deps.notifyError,
      onConflict: deps.onConflict,
      markSaved: (id, hash) => {
        // Yazma sürerken kullanıcı yazmaya devam ettiyse dirty kalır.
        deps.markSaved(id, hash ?? null, deps.readContents(id) === contents);
      },
    });

    if (outcome.status === 'failed') {
      return { status: 'failed', tabId: tab.id, error: outcome.error };
    }
    if (outcome.status === 'locked') {
      // Aynı sekme için başka bir yazma sürüyor; veri kaybını önlemek için iptal.
      const error: SaveFailure = {
        code: 'Internal',
        message: `"${tab.path}" şu anda kaydediliyor; kapatma iptal edildi.`,
      };
      deps.notifyError(error);
      return { status: 'failed', tabId: tab.id, error };
    }
  }

  return { status: 'saved', saved: dirty.length };
}
