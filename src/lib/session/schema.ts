/**
 * Versioned `session.json` şeması.
 *
 * Oturum dosyası güvenilmeyen girdidir: elle düzenlenmiş, yarıda kesilmiş
 * veya eski bir sürümden kalmış olabilir. [`parseSession`] bu yüzden her alanı
 * tek tek doğrular, tanınmayan alanları düşürür ve en kötü durumda `null`
 * döner; hiçbir değer doğrudan DOM'a yazılmaz.
 *
 * Şema saf tutulur (I/O yok): yazma/kontrol katmanı `persist.ts` ve Rust
 * komutlarındadır.
 */
import {
  DEFAULT_SPLIT_RATIO,
  DEFAULT_VIEW_MODE,
  clampSplitRatio,
  parseViewMode,
  type ViewMode,
} from '../app/viewMode.svelte';

/** Yazılan şemanın tek desteklenen sürümü. */
export const SESSION_VERSION = 1;

/** Rust tarafındaki `MAX_SESSION_BYTES` ile aynı sınır. */
export const MAX_SESSION_BYTES = 1_048_576;

/** Bir oturumda geri yüklenecek en fazla sekme; bozuk dosya şişmesini keser. */
export const MAX_SESSION_TABS = 200;
export const MAX_PATH_LENGTH = 4_096;
export const MAX_ROOT_LENGTH = 32_768;

/** Kenar çubuğu genişliği; `App.svelte` bu sabitleri kullanır. */
export const DEFAULT_SIDEBAR_WIDTH = 250;
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 520;

export interface SessionCursor {
  anchor: number;
  head: number;
}

export interface SessionScroll {
  top: number;
  left: number;
}

export interface SessionTab {
  /** Çalışma köküne göreli, `/` ayırıcılı yol. */
  path: string;
  cursor: SessionCursor | null;
  scroll: SessionScroll | null;
}

export interface SessionData {
  version: typeof SESSION_VERSION;
  /** Son açık çalışma kökü (mutlak yol); yoksa boş dize. */
  root: string;
  tabs: SessionTab[];
  /** Açık sekmelerden birinin yolu; eşleşme yoksa `null`. */
  activePath: string | null;
  viewMode: ViewMode;
  splitRatio: number;
  sidebarWidth: number;
}

export interface SessionDefaults {
  root?: string;
  tabs?: SessionTab[];
  activePath?: string | null;
  viewMode?: ViewMode;
  splitRatio?: number;
  sidebarWidth?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Negatif olmayan sonlu tam sayı; aksi halde `null`. */
function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Çalışma köküne göreli, normalleştirilmiş yol mu?
 *
 * Mutlak yollar, sürücü harfleri, `..` parçaları ve ters bölü ayırıcıları
 * reddedilir; Rust tarafı da aynı yolları köke göre çözer.
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
  if (/[\0\\]/.test(value)) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '..' && segment !== '.');
}

export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

function parseCursor(value: unknown): SessionCursor | null {
  if (!isRecord(value)) return null;
  const anchor = nonNegativeInt(value.anchor);
  const head = nonNegativeInt(value.head);
  if (anchor === null || head === null) return null;
  return { anchor, head };
}

function parseScroll(value: unknown): SessionScroll | null {
  if (!isRecord(value)) return null;
  const top = finiteNumber(value.top);
  const left = finiteNumber(value.left);
  if (top === null || left === null || top < 0 || left < 0) return null;
  return { top, left };
}

function parseTab(value: unknown): SessionTab | null {
  if (!isRecord(value)) return null;
  if (!isSafeRelativePath(value.path)) return null;
  return {
    path: value.path,
    cursor: parseCursor(value.cursor),
    scroll: parseScroll(value.scroll),
  };
}

/**
 * Ham JSON metnini doğrulanmış oturuma çevirir.
 *
 * `null` dönüşü "oturum yok sayılmalı" demektir: bozuk JSON, bilinmeyen sürüm
 * veya dizi/nesne olmayan kök. Eksik alanlar güvenli varsayılana düşer.
 */
export function parseSession(raw: string): SessionData | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SESSION_BYTES) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  // Bilinmeyen ya da eksik sürüm: dosya başka bir şemaya ait olabilir.
  if (parsed.version !== SESSION_VERSION) return null;

  const root =
    typeof parsed.root === 'string' && parsed.root.length <= MAX_ROOT_LENGTH
      ? parsed.root
      : '';

  const tabs: SessionTab[] = [];
  if (Array.isArray(parsed.tabs)) {
    const seen = new Set<string>();
    for (const entry of parsed.tabs) {
      if (tabs.length >= MAX_SESSION_TABS) break;
      const tab = parseTab(entry);
      if (tab === null || seen.has(tab.path)) continue;
      seen.add(tab.path);
      tabs.push(tab);
    }
  }

  const activePath =
    typeof parsed.activePath === 'string' && tabs.some((tab) => tab.path === parsed.activePath)
      ? parsed.activePath
      : null;

  const viewMode = parseViewMode(typeof parsed.viewMode === 'string' ? parsed.viewMode : null);
  const splitRatio = finiteNumber(parsed.splitRatio);
  const sidebarWidth = finiteNumber(parsed.sidebarWidth);

  return {
    version: SESSION_VERSION,
    root,
    tabs,
    activePath,
    viewMode: viewMode ?? DEFAULT_VIEW_MODE,
    splitRatio: splitRatio === null ? DEFAULT_SPLIT_RATIO : clampSplitRatio(splitRatio),
    sidebarWidth:
      sidebarWidth === null ? DEFAULT_SIDEBAR_WIDTH : clampSidebarWidth(sidebarWidth),
  };
}

/** Bellekteki oturumun dosyaya yazılacak biçimi. */
export function serializeSession(data: SessionData): string {
  return JSON.stringify({
    version: SESSION_VERSION,
    root: data.root,
    tabs: data.tabs.map((tab) => ({
      path: tab.path,
      cursor: tab.cursor,
      scroll: tab.scroll,
    })),
    activePath: data.activePath,
    viewMode: data.viewMode,
    splitRatio: data.splitRatio,
    sidebarWidth: data.sidebarWidth,
  });
}

/** Geçerli bir varsayılan oturum; `parse` edilemeyen dosyanın yerini alır. */
export function createSessionData(partial: SessionDefaults = {}): SessionData {
  const tabs = (partial.tabs ?? []).filter((tab) => isSafeRelativePath(tab.path));
  return {
    version: SESSION_VERSION,
    root: partial.root ?? '',
    tabs,
    activePath:
      partial.activePath !== null &&
      partial.activePath !== undefined &&
      tabs.some((tab) => tab.path === partial.activePath)
        ? partial.activePath
        : null,
    viewMode: partial.viewMode ?? DEFAULT_VIEW_MODE,
    splitRatio: clampSplitRatio(partial.splitRatio ?? DEFAULT_SPLIT_RATIO),
    sidebarWidth: clampSidebarWidth(partial.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH),
  };
}
