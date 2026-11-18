/**
 * `fs:changed` / `fs:watcher-error` Tauri olaylarına abonelik.
 *
 * Abonelik tek bir yerde toplanır; ağaç, sekmeler ve editör aynı olayı
 * dinleyebilir. Dinleyiciler olay işleyicisinde ağır iş yapmamalıdır: Rust
 * tarafı 150 ms penceresinde topladığı için iş yükü partiler hâlindedir.
 */

import type { UnlistenFn } from '@tauri-apps/api/event';

import { normalizeAppError, type AppError } from '../ipc/errors';
import { subscribeEvent, type EventSubscriber } from '../ipc/events';
import {
  FS_CHANGED_EVENT,
  WATCHER_ERROR_EVENT,
  parseFsChanged,
  type FsChange,
} from './events';

export interface WatchHandlers {
  /** Doğrulanmış, yolu birleştirilmiş değişiklik partisi. */
  onChange(changes: FsChange[]): void;
  /** İzleyici başlatılamadı veya çalışırken durdu. */
  onError(error: AppError): void;
}

/**
 * Boş yük `null` ile aynı sonucu verir: dinleyici hiç çağrılmaz. Rust
 * tarafının tekilleştirme sonrası boş parti göndermesi durumu boşa iş
 * yaptırmaz.
 */
function parseNonEmptyFsChanged(payload: unknown): FsChange[] | null {
  const changes = parseFsChanged(payload);
  return changes !== null && changes.length > 0 ? changes : null;
}

/**
 * Çalışma kökü izleyicisine abone olur. Dönen fonksiyon iki dinleyiciyi de
 * kaldırır; `root` değiştiğinde veya bileşen yok olduğunda çağrılmalıdır.
 */
export async function subscribeWorkspaceWatch(
  handlers: WatchHandlers,
  subscriber?: EventSubscriber,
): Promise<UnlistenFn> {
  const unlistenChange = await subscribeEvent(
    FS_CHANGED_EVENT,
    parseNonEmptyFsChanged,
    handlers.onChange,
    subscriber,
  );
  const unlistenError = await subscribeEvent(
    WATCHER_ERROR_EVENT,
    normalizeAppError,
    handlers.onError,
    subscriber,
  );

  return () => {
    unlistenChange();
    unlistenError();
  };
}
