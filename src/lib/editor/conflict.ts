/**
 * Dış değişiklik / kaydedilmemiş içerik çakışmasının saf çekirdeği.
 *
 * Kural: **dirty** bir sekmenin editör içeriği dış değişiklikle asla ezilmez.
 * Diskteki içerik yalnızca `PendingConflict` içinde saklanır; kullanıcı bandı
 * kapatana kadar editörün içeriği ve sekmenin dirty işareti dokunulmadan kalır.
 *
 * Temiz (dirty olmayan) sekme sessizce yeniden yüklenebilir; bu karar da
 * buradaki saf fonksiyondan çıkar, böylece "hangi durumda ezilir" tek yerde
 * tanımlıdır.
 */

/** Çakışma kararında kullanılan sekme görünümü. */
export interface ConflictTab {
  id: string;
  path: string;
  dirty: boolean;
}

/** Kullanıcı kararı bekleyen çakışma; sarı bant bu nesneyi gösterir. */
export interface PendingConflict {
  /** Çakışmanın ait olduğu sekme kimliği. */
  tabId: string;
  /** Çakışma anındaki dosya yolu (yeniden adlandırma ile güncellenebilir). */
  path: string;
  /** Kullanıcının korunacak editör içeriği; çakışma boyunca değişmez. */
  editorContents: string;
  /** Diskteki güncel içerik; bant açıkken gelen yeni olaylarla tazelenir. */
  diskContents: string;
  /** İlk algılama zamanı (ms). */
  detectedAt: number;
}

/** `decideExternalChange` sonucu: sessiz yükleme, bant veya değişiklik yok. */
export type ExternalChangeDecision =
  | { action: 'reload'; contents: string }
  | { action: 'conflict'; conflict: PendingConflict }
  | { action: 'unchanged' };

export interface ExternalChangeInput {
  tab: ConflictTab;
  /** Editörün o anki içeriği; çağıran taraf editörün sahibidir. */
  editorContents: string;
  /** Diskte okunan içerik. */
  diskContents: string;
  /** Aynı sekme için zaten açık bir bant varsa. */
  pending: PendingConflict | null;
  /** Algılama zamanı; varsayılan `Date.now()`. */
  now?: number;
}

/**
 * Dış değişikliğin nasıl ele alınacağını belirler.
 *
 * 1. Editör ve disk içeriği aynıysa karar gereksizdir (`unchanged`); bu,
 *    editörün kendi kaydetmesinin yankısını da kapsar.
 * 2. Bant zaten açıksa yalnızca disk anlık görüntüsü tazelenir; kullanıcının
 *    editör içeriği ve bekleyen kararı korunur.
 * 3. Sekme temizse içerik sessizce yeniden yüklenir.
 * 4. Aksi halde (dirty sekme) çakışma bandı açılır.
 */
export function decideExternalChange(input: ExternalChangeInput): ExternalChangeDecision {
  const { tab, editorContents, diskContents } = input;

  if (editorContents === diskContents) {
    return { action: 'unchanged' };
  }

  if (input.pending) {
    return {
      action: 'conflict',
      conflict: {
        ...input.pending,
        path: tab.path,
        editorContents,
        diskContents,
      },
    };
  }

  if (!tab.dirty) {
    return { action: 'reload', contents: diskContents };
  }

  return {
    action: 'conflict',
    conflict: {
      tabId: tab.id,
      path: tab.path,
      editorContents,
      diskContents,
      detectedAt: input.now ?? Date.now(),
    },
  };
}

/** Yeniden yükleme sonucu; hiçbiri sessiz veri kaybı üretmez. */
export type ReloadOutcome =
  | 'applied'
  | 'confirmation-required'
  | 'not-found'
  | 'editor-unavailable';

/**
 * "Diski Yükle" için onay kapısı. Onaysız istek hiçbir şeyi değiştirmez,
 * bu yüzden `reload` çağrısı `confirmed === true` olmadan uygulanamaz.
 */
export function canReload(request: { confirmed: boolean }): boolean {
  return request.confirmed === true;
}
