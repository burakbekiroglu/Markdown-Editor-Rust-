/**
 * Pencere kapanış isteği aboneliği.
 *
 * Rust tarafı (`src-tauri/src/lib.rs`) her `CloseRequested` olayını
 * `api.prevent_close()` ile durdurur ve frontend'e `app:close-requested`
 * olayını yayınlar. Karar frontend'e aittir: kirli sekme yoksa pencere hemen
 * yok edilir, varsa onay akışı açılır.
 *
 * Abonelik enjekte edilebilir: testler Tauri penceresini mock'lamak yerine
 * sahte bir abone verir ve iletimi doğrular.
 */

import type { UnlistenFn } from '@tauri-apps/api/event';

import { subscribeEvent } from '../ipc/events';

export type { UnlistenFn };

/** Rust `lib.rs::CLOSE_REQUESTED_EVENT`. */
export const CLOSE_REQUESTED_EVENT = 'app:close-requested';

/** Kapanış isteği geldiğinde çağrılır; yük taşımaz. */
export type CloseRequestHandler = () => void;

/** Tauri olay aboneliğiyle aynı imza; enjeksiyon noktası. */
export type CloseRequestSubscriber = (handler: CloseRequestHandler) => Promise<UnlistenFn>;

const tauriCloseRequests: CloseRequestSubscriber = (handler) =>
  // Yük anlamsızdır: olayın varlığı isteğin kendisidir.
  subscribeEvent(CLOSE_REQUESTED_EVENT, () => true, handler);

/**
 * Kapanış isteklerine abone olur. Dönen fonksiyon dinleyiciyi kaldırır.
 *
 * İşleyici senkron olmalıdır: kirli sekme kontrolü ve modal kararı önceden
 * bilinen duruma göre verilir; kaydetme işi karardan sonra yürütülür.
 */
export function subscribeAppCloseRequested(
  handler: CloseRequestHandler,
  subscriber: CloseRequestSubscriber = tauriCloseRequests,
): Promise<UnlistenFn> {
  return subscriber(handler);
}
