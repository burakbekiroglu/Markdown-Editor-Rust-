/**
 * Son kullanılan dosyaların kalıcı listesi (Ctrl+P önceliği).
 *
 * Yollar `localStorage`'da JSON dizi olarak tutulur. Saklanan değer
 * güvenilmeyen veridir: yalnızca boş olmayan dizeler kabul edilir, liste
 * [`RECENT_LIMIT`] ile sınırlanır. Depolama yoksa/engelliyse özellik yalnızca
 * bu oturum için çalışır.
 */

export const RECENT_STORAGE_KEY = 'md-editor:recent-files';
export const RECENT_LIMIT = 20;

/** Ham depolama değerini güvenli bir yol listesine çözer. */
export function parseRecent(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class RecentFilesStore {
  list = $state<string[]>([]);
  #hydrated = false;
  #storageBound = false;
  #storage: Storage | null = null;

  /** Kayıtlı listeyi bir kez okur; sonraki çağrılar yok sayılır. */
  hydrate(storage: Storage | null = safeStorage()): void {
    if (this.#hydrated) return;
    this.#hydrated = true;
    this.#storageBound = true;
    this.#storage = storage;
    if (storage === null) return;
    let raw: string | null = null;
    try {
      raw = storage.getItem(RECENT_STORAGE_KEY);
    } catch {
      return;
    }
    this.list = parseRecent(raw);
  }

  /** Dosyayı listenin başına taşır; aynı yol tekrar etmez. */
  record(path: string): void {
    if (path.length === 0) return;
    const next = [path, ...this.list.filter((item) => item !== path)].slice(0, RECENT_LIMIT);
    this.list = next;
    try {
      this.#target()?.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Kotalı/kapalı depolama: sıralama bu oturumda geçerli kalır.
    }
  }

  #target(): Storage | null {
    return this.#storageBound ? this.#storage : safeStorage();
  }
}

export const recentFiles = new RecentFilesStore();
