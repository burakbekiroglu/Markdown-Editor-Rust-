/**
 * "Benimkini Yaz" akışının çekirdeği: kullanıcı kararı verdiğinde editör
 * içeriğini diske yazar.
 *
 * Kurallar:
 * - Yazma **yalnızca açık kullanıcı kararıyla** (bant üzerindeki buton) çağrılır;
 *   bu fonksiyon kendi başına hiçbir olaydan tetiklenmez.
 * - Hash verilmeden yazılır: diskteki sürüm bilinçli olarak ezilir, çünkü
 *   kullanıcı "benimkini yaz" dedi. Yazma Rust tarafında atomiktir; hata
 *   durumunda disk değişmez, bant açık kalır ve sekme dirty kalır.
 * - Yazma sürerken kullanıcı yazmaya devam edebilir. Bu durumda diske yazılan
 *   metin ile editördeki metin ayrışır; sekme dirty bırakılır ki yeni
 *   tuş vuruşları "kaydedildi" sanılmasın.
 */
import type { ConflictStore } from './conflictStore.svelte';

/** Yazma denemesinin sonucu. */
export type WriteMineOutcome = 'written' | 'not-found' | 'failed';

export interface WriteMineDeps {
  /** Açık bantların ve editör bağlantılarının tek kaynağı. */
  conflicts: ConflictStore;
  /** Diske yazar; `expectedHash` verilmez, yani bilinçli ezme. */
  write(path: string, contents: string): Promise<{ hash: string }>;
  /** Başarılı yazmadan sonra sekme durumunu günceller (dirty/hash). */
  recordSaved(tabId: string, hash: string | null, unchanged: boolean): void;
  /** Yazma hatası; bant açık kalır. */
  onError(error: unknown): void;
}

/**
 * Banttaki sekmenin editör içeriğini diske yazar.
 *
 * Bant yoksa hiçbir şey yapılmaz (`not-found`): kullanıcı kararı olmadan
 * yazma yolunun çağrılamayacağının ikinci güvencesidir.
 */
export async function writeMine(
  tabId: string,
  deps: WriteMineDeps,
): Promise<WriteMineOutcome> {
  const conflict = deps.conflicts.for(tabId);
  if (conflict === null) return 'not-found';

  // Editör bağlıysa güncel metin, değilse çakışma anındaki anlık görüntü yazılır.
  const contents = deps.conflicts.editorContents(tabId) ?? conflict.editorContents;

  let hash: string;
  try {
    hash = (await deps.write(conflict.path, contents)).hash;
  } catch (error) {
    deps.onError(error);
    return 'failed';
  }

  // Yazma sürerken sekme kapanmış olabilir; bu durumda editör içeriği okunamaz
  // ve sekme "değişmedi" sayılmaz (dirty kalır).
  const unchanged = deps.conflicts.editorContents(tabId) === contents;
  deps.conflicts.keepMine(tabId);
  deps.recordSaved(tabId, hash, unchanged);
  return 'written';
}
