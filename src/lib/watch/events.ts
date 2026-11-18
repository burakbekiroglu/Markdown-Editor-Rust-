/**
 * `fs:changed` olay sözleşmesi.
 *
 * Rust tarafındaki `src-tauri/src/watcher.rs` 150 ms penceresinde yolu
 * birleştirip tek bir olay yayınlar. Bu modül yükü doğrular ve ağaç/sekme
 * katmanının ihtiyaç duyduğu saf yardımcıları sunar.
 */

/** Rust `watcher::FS_CHANGED_EVENT`. */
export const FS_CHANGED_EVENT = 'fs:changed';
/** Rust `watcher::WATCHER_ERROR_EVENT` (AppError gövdesi taşır). */
export const WATCHER_ERROR_EVENT = 'fs:watcher-error';

/** Rust `watcher::FsChangeKind` (serde camelCase). */
export type FsChangeKind = 'create' | 'modify' | 'remove';

/** Rust `watcher::FsChange`. */
export interface FsChange {
  /** Çalışma köküne göreli yol; `/` ayırıcısı, kök asla boş dize değildir. */
  path: string;
  kind: FsChangeKind;
}

/** Rust `watcher::FsChanged`. */
export interface FsChangedPayload {
  changes: FsChange[];
}

const CHANGE_KINDS: ReadonlySet<string> = new Set<FsChangeKind>([
  'create',
  'modify',
  'remove',
]);

/**
 * Göreli bir yolu doğrular.
 *
 * Rust tarafı kök dışı olayları zaten filtreler; bu kontrol savunma katmanıdır
 * ve bozuk bir yükün ağaç deposuna mutlak yol veya `..` sokmasını engeller.
 */
export function isSafeRelativePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.startsWith('/') || path.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  return path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/**
 * Olay yükünü doğrular. Tanınmayan biçimlerde `null` döner; tek bozuk öğe
 * bütün partiyi düşürmez, yalnızca o öğe atlanır.
 */
export function parseFsChanged(payload: unknown): FsChange[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const changes = (payload as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return null;

  const parsed: FsChange[] = [];
  for (const entry of changes) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { path, kind } = entry as { path?: unknown; kind?: unknown };
    if (!isSafeRelativePath(path)) continue;
    if (typeof kind !== 'string' || !CHANGE_KINDS.has(kind)) continue;
    parsed.push({ path, kind: kind as FsChangeKind });
  }
  return parsed;
}

/** Değişen her yolun üst klasörü (kök `''`). Yinelenenler tekilleştirilir. */
export function affectedDirectories(changes: readonly FsChange[]): string[] {
  const directories = new Set<string>();
  for (const change of changes) {
    const parts = change.path.split('/');
    parts.pop();
    directories.add(parts.join('/'));
  }
  return [...directories];
}

/** Silinen yollar; ağaç ve sekme önbellekleri bu alt ağaçları bırakır. */
export function removedPaths(changes: readonly FsChange[]): string[] {
  return changes.filter((change) => change.kind === 'remove').map((change) => change.path);
}

/**
 * İçeriği yeniden okunması gereken yollar: yalnızca `modify` ve `create`.
 * `remove` yolları "eksik dosya" durumuna gider, içerik okunmaz.
 */
export function refreshedPaths(changes: readonly FsChange[]): string[] {
  const unique = new Set<string>();
  for (const change of changes) {
    if (change.kind === 'modify' || change.kind === 'create') unique.add(change.path);
  }
  return [...unique];
}
