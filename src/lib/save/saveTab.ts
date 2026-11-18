/**
 * Kaydetme akışının saf çekirdeği.
 *
 * Kural: sekme durumu yalnızca yazma **başarılı olduktan sonra** temizlenir.
 * `saveTab` hatada `tab.dirty` alanına dokunmaz; hata tek kanaldan bildirilir.
 * Böylece başarısız kaydetmede kullanıcı verisi kaybolmaz ve sekme dirty kalır.
 */

import { normalizeAppError } from "../ipc/errors";
import type { AppErrorPayload, SaveResult } from "../ipc/types";

export interface SaveableTab {
  id: string;
  path: string;
  dirty: boolean;
  /** Disk sürümünün hash'i; verilirse yazma iyimser çakışma kontrolünden geçer. */
  hash?: string | null;
}

/** Frontend'e dönen tipli hata: Rust `AppError` serde temsili ile aynı şekil. */
export type SaveFailure = AppErrorPayload;

export interface SaveDeps {
  /** `fs_write_file_atomic` komutunu çağırır; disk hash'ini döner. */
  writeFile(
    path: string,
    contents: string,
    expectedHash?: string | null,
  ): Promise<SaveResult | void>;
  /** Yalnızca başarılı yazmadan sonra çağrılır; store dirty'yi burada temizler. */
  markSaved(id: string, hash?: string | null): void;
  /** Hata bildirimi (toast). Hata sonrası sekme dirty kalır. */
  notifyError(failure: SaveFailure): void;
  /**
   * Yazma `ConflictDetected` ile reddedildiğinde çağrılır. Çağıran, disk
   * sürümü ile editör içeriğini karşılaştırıp çakışma bandını açar; sekme
   * dirty kalır ve kullanıcı kararı olmadan diske yazılmaz.
   */
  onConflict?(tab: SaveableTab, contents: string): void;
}

/** Aynı sekme için yazma sürmekteyken ikinci istek `locked` döner. */
export type SaveOutcome =
  | { status: "saved" }
  | { status: "skipped" }
  | { status: "locked" }
  | { status: "failed"; error: SaveFailure };

/**
 * Yazması süren sekmeler. Kilit **sekme kimliği** başına tutulur: `Ctrl+S`
 * iki kez hızlıca basıldığında ikinci istek ikinci bir yazma üretmez.
 */
const inFlight = new Set<string>();

/**
 * Bilinmeyen bir reddi `{ code, message }` şekline getirir. Normalizasyonun
 * tek kaynağı `ipc/errors.ts`'teki `normalizeAppError`'dır; tanınmayan biçimler
 * `Internal` altında mesajlarını korur.
 */
export function normalizeSaveFailure(error: unknown): SaveFailure {
  return normalizeAppError(error).toPayload();
}

/**
 * Dirty bir sekmeyi kaydeder.
 *
 * - Dirty değilse hiç yazmaz (`skipped`).
 * - Aynı sekme için yazma zaten sürüyorsa ikinci bir yazma üretmez (`locked`).
 * - Yazma başarılıysa `markSaved` çağrılır; dirty'yi store temizler.
 * - Yazma başarısızsa `notifyError` çağrılır ve sekme **dirty kalır**;
 *   `ConflictDetected` ayrıca `onConflict` ile çakışma bandına iletilir.
 */
export async function saveTab(
  tab: SaveableTab,
  contents: string,
  deps: SaveDeps,
): Promise<SaveOutcome> {
  if (!tab.dirty) {
    return { status: "skipped" };
  }

  if (inFlight.has(tab.id)) {
    return { status: "locked" };
  }

  inFlight.add(tab.id);
  try {
    const result = await deps.writeFile(tab.path, contents, tab.hash ?? undefined);
    deps.markSaved(tab.id, result?.hash ?? null);
  } catch (error) {
    const failure = normalizeSaveFailure(error);
    deps.notifyError(failure);
    if (failure.code === "ConflictDetected") {
      deps.onConflict?.(tab, contents);
    }
    return { status: "failed", error: failure };
  } finally {
    inFlight.delete(tab.id);
  }

  return { status: "saved" };
}
