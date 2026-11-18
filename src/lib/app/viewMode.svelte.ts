/**
 * Görünüm modunun **sekme üstü global** durumu.
 *
 * Mod ve bölünmüş moddaki ayırıcı oranı tek bir yerde tutulur; sekmeler arası
 * geçişte değişmez. Tercihler `localStorage`'a yazılır ve açılışta geri
 * yüklenir. Saf yardımcılar (`parseViewMode`, `clampSplitRatio`) DOM'dan
 * bağımsızdır; depo sınıfı testlerde sahte bir `Storage` ile beslenebilir.
 */

export type ViewMode = 'editor' | 'split' | 'preview';

/** Segmented kontrolün sırası; klavye gezinmesi bu diziyi izler. */
export const VIEW_MODES: readonly ViewMode[] = ['editor', 'split', 'preview'];

export const DEFAULT_VIEW_MODE: ViewMode = 'split';

/** Ayırıcı oranı: her iki panel de en az %20 görünür kalır. */
export const SPLIT_RATIO_MIN = 0.2;
export const SPLIT_RATIO_MAX = 0.8;
export const DEFAULT_SPLIT_RATIO = 0.5;

export const VIEW_MODE_STORAGE_KEY = 'md-editor:view-mode';
export const SPLIT_RATIO_STORAGE_KEY = 'md-editor:split-ratio';

/** Depodan gelen değer güvenilmeyen veridir; tanınmayan mod yok sayılır. */
export function parseViewMode(value: string | null | undefined): ViewMode | null {
  return value === 'editor' || value === 'split' || value === 'preview' ? value : null;
}

/** Oranı geçerli aralığa sıkıştırır; sonsuz/NaN varsayılana döner. */
export function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_RATIO;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, value));
}

/** Metin olarak saklanan oranı çözer; geçersizse `null`. */
export function parseSplitRatio(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampSplitRatio(parsed) : null;
}

/** `localStorage` yoksa veya erişim engelliyse `null`. */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function writeItem(storage: Storage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Kotası dolu veya depolama kapalı: tercih yalnızca bu oturum için geçerli.
  }
}

export class ViewModeStore {
  mode = $state<ViewMode>(DEFAULT_VIEW_MODE);
  ratio = $state<number>(DEFAULT_SPLIT_RATIO);
  #hydrated = false;
  #storageBound = false;
  #storage: Storage | null = null;

  /** Kayıtlı tercihleri bir kez okur; sonraki çağrılar yok sayılır. */
  hydrate(storage: Storage | null = safeStorage()): void {
    if (this.#hydrated) return;
    this.#hydrated = true;
    this.#storageBound = true;
    this.#storage = storage;
    if (storage === null) return;
    let storedMode: string | null = null;
    let storedRatio: string | null = null;
    try {
      storedMode = storage.getItem(VIEW_MODE_STORAGE_KEY);
      storedRatio = storage.getItem(SPLIT_RATIO_STORAGE_KEY);
    } catch {
      return;
    }
    const mode = parseViewMode(storedMode);
    if (mode !== null) this.mode = mode;
    const ratio = parseSplitRatio(storedRatio);
    if (ratio !== null) this.ratio = ratio;
  }

  setMode(next: ViewMode): void {
    if (next === this.mode) return;
    this.mode = next;
    writeItem(this.#target(), VIEW_MODE_STORAGE_KEY, next);
  }

  /** Ayırıcı sürüklemesi her karede çağırır; yazma yalnızca değer değişince. */
  setRatio(next: number): void {
    const clamped = clampSplitRatio(next);
    if (clamped === this.ratio) return;
    this.ratio = clamped;
    writeItem(this.#target(), SPLIT_RATIO_STORAGE_KEY, String(clamped));
  }

  #target(): Storage | null {
    return this.#storageBound ? this.#storage : safeStorage();
  }
}

export const viewMode = new ViewModeStore();
