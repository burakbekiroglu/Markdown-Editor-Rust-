/**
 * Ağaç komutlarının IPC yüzeyi.
 *
 * Tip tanımları ve hata normalizasyonu `src/lib/ipc` altındaki tek kaynaktan
 * gelir; bu modül yalnızca ağaca özgü fonksiyon adlarını sunar. Geriye dönük
 * uyumluluk için `FsError` adı `AppError`'ın takma adıdır.
 */

import { invokeCommand } from '../ipc/client';
import { AppError, ERROR_TEXT, describeAppError, normalizeAppError } from '../ipc/errors';
import type { AppErrorCode, EntryInfo, IndexResult, WorkspaceInfo } from '../ipc/types';

export type { AppErrorCode, EntryInfo, WorkspaceInfo } from '../ipc/types';
export { ERROR_TEXT };

/** @deprecated Yeni kod `AppError` kullanmalı. */
export { AppError as FsError };
export type FsErrorCode = AppErrorCode;

/** Tauri komut reddini tipli hataya çevirir (tek kaynak: `ipc/errors`). */
export function normalizeFsError(error: unknown): AppError {
  return normalizeAppError(error);
}

/** Kullanıcı metni tek kaynaktan (`ipc/errors`) gelir; burada tekrar yok. */
export function describeFsError(error: unknown): string {
  return describeAppError(error);
}

/** Oturumdaki çalışma kökü; hiç klasör açılmadıysa `null`. */
export function currentWorkspace(): Promise<WorkspaceInfo | null> {
  return invokeCommand('current_workspace', {});
}

/** Yerel klasör seçici; kullanıcı iptal ederse `null`. */
export function openWorkspace(): Promise<WorkspaceInfo | null> {
  return invokeCommand('open_workspace', {});
}

/**
 * Oturum kökünü kapatır ve kapanan kökü döndürür.
 *
 * Rust tarafı watcher'ı durdurup kökü temizler; frontend `root` değerini
 * boşaltınca ağaç önbelleği de sıfırlanır. Açık klasör yoksa `null`.
 */
export function closeWorkspace(): Promise<WorkspaceInfo | null> {
  return invokeCommand('close_workspace', {});
}

/**
 * Bir klasörün doğrudan alt öğeleri.
 *
 * Rust `fs::list::fs_list_dir` meta veri zengin listeyi döndürür ve sıralamayı
 * kendisi yapar (klasörler önce, sonra büyük/küçük harf duyarsız ad sırası);
 * frontend yanıtı olduğu gibi render eder.
 */
export function listEntries(path = ''): Promise<EntryInfo[]> {
  return invokeCommand('fs_list_dir', { path });
}

/** Özyinelemeli çalışma alanı indeksi; Ctrl+P hızlı geçiş paneli kullanır. */
export function indexWorkspace(path = ''): Promise<IndexResult> {
  return invokeCommand('fs_index', { path });
}

export function createFile(parentRel: string, name: string): Promise<EntryInfo> {
  return invokeCommand('fs_create_file', { parentRel, name });
}

export function createFolder(parentRel: string, name: string): Promise<EntryInfo> {
  return invokeCommand('fs_create_folder', { parentRel, name });
}

export function renameEntry(rel: string, newName: string): Promise<EntryInfo> {
  return invokeCommand('fs_rename_entry', { rel, newName });
}

export function moveEntry(rel: string, targetDirRel: string): Promise<EntryInfo> {
  return invokeCommand('fs_move', { rel, targetDirRel });
}

export function deleteEntry(rel: string): Promise<void> {
  return invokeCommand('fs_delete_entry', { rel });
}
