/**
 * Açık sekmelerin Svelte 5 runes tabanlı deposu.
 * Ağaçtaki yeniden adlandırma/silme işlemleri buradaki yolları günceller.
 */
import {
  applyRenameToTabs,
  applySaveResult,
  closeTab,
  markDeletedTabs,
  markExistingTabs,
  markTabDirty,
  relocateTab,
  tabTitle,
  type Tab,
} from './tabs';

class TabsStore {
  tabs = $state<Tab[]>([]);
  activeId = $state<string | null>(null);
  #nextId = 1;

  get active(): Tab | null {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null;
  }

  open(path: string, dirty = false): Tab {
    const existing = this.tabs.find((tab) => tab.path === path);
    if (existing) {
      // Dosya ağaçta yeniden göründüyse "eksik" işareti kalkar.
      if (existing.missing) this.markPresent(path);
      this.activeId = existing.id;
      return existing;
    }
    const tab: Tab = {
      id: `tab-${this.#nextId++}`,
      path,
      title: tabTitle(path),
      dirty,
      missing: false,
      hash: null,
    };
    this.tabs = [...this.tabs, tab];
    this.activeId = tab.id;
    return tab;
  }

  activate(id: string): void {
    if (this.tabs.some((tab) => tab.id === id)) this.activeId = id;
  }

  close(id: string): void {
    const result = closeTab(this.tabs, this.activeId, id);
    this.tabs = [...result.tabs];
    this.activeId = result.activeId;
  }

  setDirty(id: string, dirty: boolean): void {
    this.tabs = markTabDirty(this.tabs, id, dirty);
  }

  /**
   * Başarılı kaydetme sonucunu işler. `unchanged` yazma sürerken editör
   * içeriğinin değişmediğini gösterir; yalnızca bu durumda dirty temizlenir.
   */
  recordSave(id: string, hash: string | null, unchanged: boolean): void {
    this.tabs = applySaveResult(this.tabs, id, hash, unchanged);
  }

  /** Disk sürümünün hash'ini kaydeder; dirty durumuna dokunmaz. */
  setHash(id: string, hash: string | null): void {
    this.tabs = applySaveResult(this.tabs, id, hash, false);
  }

  /** Ağaçta yeniden adlandırma; dirty durumu ve içerik korunur. */
  renamePath(oldPath: string, newPath: string): { ok: boolean; reason?: string } {
    const result = applyRenameToTabs(this.tabs, oldPath, newPath);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.tabs = result.tabs;
    return { ok: true };
  }

  /** Ağaçtan silinen öğe: sekmeler kapanmaz, "eksik" işaretlenir. */
  markDeleted(path: string): void {
    this.tabs = markDeletedTabs(this.tabs, path);
  }

  /**
   * Oturumdan gelen sekmeleri kurar. Sıra ve "eksik" işaretleri korunur;
   * kimlikler yeniden üretilir, çünkü kimlikler oturumlar arasında kalıcı
   * değildir. Etkin sekme yol eşleşmesiyle seçilir, yoksa ilk sekme olur.
   */
  restore(entries: readonly { path: string; missing: boolean }[], activePath: string | null): void {
    const seen = new Set<string>();
    const next: Tab[] = [];
    for (const entry of entries) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      next.push({
        id: `tab-${this.#nextId++}`,
        path: entry.path,
        title: tabTitle(entry.path),
        dirty: false,
        missing: entry.missing,
        hash: null,
      });
    }
    this.tabs = next;
    this.activeId =
      next.find((tab) => tab.path === activePath)?.id ?? next[0]?.id ?? null;
  }

  /** Dışarıdan yeniden oluşturulan yol: "eksik" işareti kalkar. */
  markPresent(path: string): void {
    this.tabs = markExistingTabs(this.tabs, path);
  }

  /** Eksik dosya sekmesini kullanıcının verdiği yeni yola bağlar. */
  relocate(id: string, newPath: string): { ok: boolean; reason?: string } {
    const result = relocateTab(this.tabs, id, newPath);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.tabs = result.tabs;
    return { ok: true };
  }
}

export const tabs = new TabsStore();
