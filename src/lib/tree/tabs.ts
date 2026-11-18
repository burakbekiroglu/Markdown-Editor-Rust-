/**
 * Sekmelerin saf (state içermeyen) yardımcıları.
 *
 * Ağaçta yeniden adlandırma/silme olduğunda açık sekmelerin yolu bu fonksiyonlarla
 * güncellenir. Dirty durumu ve sekme kimliği korunur; içerik yeniden yüklenmez.
 */
import { isSameOrInside, replacePathPrefix } from './paths';
import type { NameValidation } from './nameValidation';

export interface Tab {
  id: string;
  path: string;
  title: string;
  dirty: boolean;
  missing: boolean;
  /**
   * Son okunan/kaydedilen disk içeriğinin hash'i. Kaydetmede `expectedHash`
   * olarak gönderilir; dış değişiklik veya yeniden konumlandırmada `null`'a
   * döner çünkü disk sürümü artık bilinmiyordur.
   */
  hash?: string | null;
}

export function tabTitle(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

/**
 * Ağaçta yeniden adlandırılan bir yolun açık sekmelere yansıtılması.
 * Klasör yeniden adlandırıldığında altındaki dosya sekmeleri de taşınır.
 */
export function renameTabPaths(tabs: readonly Tab[], oldPath: string, newPath: string): Tab[] {
  return tabs.map((tab) => {
    if (!isSameOrInside(tab.path, oldPath)) return tab;
    const path = replacePathPrefix(tab.path, oldPath, newPath);
    return { ...tab, path, title: tabTitle(path) };
  });
}

/**
 * Ağaçtan silinen bir öğeye ait sekmeler "eksik dosya" olarak işaretlenir;
 * kullanıcı içeriğini kaybetmez, sekme kapanmaz.
 */
export function markDeletedTabs(tabs: readonly Tab[], deletedPath: string): Tab[] {
  return tabs.map((tab) =>
    isSameOrInside(tab.path, deletedPath) ? { ...tab, missing: true } : tab,
  );
}

/**
 * Dışarıdan yeniden oluşturulan yol için "eksik dosya" işaretini kaldırır.
 * Dosya geri geldiğinde sekme yeniden normal duruma döner.
 */
export function markExistingTabs(tabs: readonly Tab[], path: string): Tab[] {
  return tabs.map((tab) =>
    tab.missing && isSameOrInside(tab.path, path) ? { ...tab, missing: false, hash: null } : tab,
  );
}

/** Editör içeriği değiştiğinde dirty işareti. */
export function markTabDirty(tabs: readonly Tab[], id: string, dirty: boolean): Tab[] {
  return tabs.map((tab) => (tab.id === id ? { ...tab, dirty } : tab));
}

/**
 * Başarılı kaydetmenin sonucunu sekmeye yazar. Dirty yalnızca yazma sürerken
 * içerik değişmediyse temizlenir; hash ise diskteki yeni sürümü gösterir.
 */
export function applySaveResult(
  tabs: readonly Tab[],
  id: string,
  hash: string | null,
  unchanged: boolean,
): Tab[] {
  return tabs.map((tab) =>
    tab.id === id ? { ...tab, hash, dirty: unchanged ? false : tab.dirty } : tab,
  );
}

export type TabRelocateResult =
  | { ok: true; tabs: Tab[] }
  | { ok: false; reason: string };

/**
 * "Eksik dosya" sekmesini yeni bir yola bağlar. Hedef başka bir açık sekmede
 * kullanılıyorsa işlem reddedilir; dirty durumu ve içerik korunur.
 */
export function relocateTab(
  tabs: readonly Tab[],
  id: string,
  newPath: string,
): TabRelocateResult {
  const target = tabs.find((tab) => tab.id === id);
  if (target === undefined) return { ok: false, reason: 'Sekme bulunamadı.' };
  if (newPath.length === 0) return { ok: false, reason: 'Dosya yolu boş olamaz.' };

  const clash = tabs.some((tab) => tab.id !== id && tab.path === newPath);
  if (clash) return { ok: false, reason: 'Bu dosya başka bir sekmede açık.' };

  return {
    ok: true,
    tabs: tabs.map((tab) =>
      tab.id === id
        ? { ...tab, path: newPath, title: tabTitle(newPath), missing: false, hash: null }
        : tab,
    ),
  };
}

export type TabRenameResult =
  | { ok: true; tabs: Tab[] }
  | { ok: false; code: 'ENTRY_EXISTS'; reason: string };

/**
 * Yeniden adlandırma sonucunu sekmelere uygular. Yeni yol başka bir açık sekmeyle
 * çakışıyorsa (ör. yalnızca büyük/küçük harf değişimi hariç) işlem reddedilir.
 */
export function applyRenameToTabs(
  tabs: readonly Tab[],
  oldPath: string,
  newPath: string,
): TabRenameResult {
  if (oldPath !== newPath) {
    const clash = tabs.some(
      (tab) =>
        tab.path === newPath &&
        tab.path !== oldPath &&
        !isSameOrInside(tab.path, oldPath),
    );
    if (clash) {
      return { ok: false, code: 'ENTRY_EXISTS', reason: 'Bu yol başka bir sekmede açık.' };
    }
  }
  return { ok: true, tabs: renameTabPaths(tabs, oldPath, newPath) };
}

export function preliminaryNameError(validation: NameValidation): string | null {
  return validation.ok ? null : validation.reason;
}

export interface TabCloseResult {
  tabs: readonly Tab[];
  activeId: string | null;
}

/**
 * Sekme kapatmanın saf çekirdeği. Sıra korunur; kalan sekmeler yeniden
 * sıralanmaz. Aktif sekme kapanırsa sıradaki sekme, yoksa bir önceki seçilir.
 */
export function closeTab(
  tabs: readonly Tab[],
  activeId: string | null,
  id: string,
): TabCloseResult {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return { tabs, activeId };

  const remaining = tabs.filter((tab) => tab.id !== id);
  if (activeId !== id) return { tabs: remaining, activeId };

  const next = remaining[index] ?? remaining[index - 1] ?? null;
  return { tabs: remaining, activeId: next?.id ?? null };
}

/** Ctrl+W (Windows/Linux) veya Cmd+W (macOS) sekme kapatma kısayolu. */
export function isCloseTabShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  if (event.altKey || event.shiftKey) return false;
  return event.key.toLowerCase() === 'w' && (event.ctrlKey || event.metaKey);
}
