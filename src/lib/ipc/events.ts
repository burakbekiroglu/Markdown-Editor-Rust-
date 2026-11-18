/**
 * Tipli Tauri olay aboneliği.
 *
 * Her olay yükü güvenilmeyen veridir: Rust tarafı doğru üretse bile sürüm
 * uyuşmazlığı veya bozuk bir yük dinleyicilere ham hâlde ulaşmamalıdır. Bu
 * yüzden abonelik, `parse` adımından geçen ve `null` dönen yükleri sessizce
 * düşüren tek bir yardımcıdan geçer.
 *
 * Dinleyici (`EventSubscriber`) dışarıdan verilebilir; testler Tauri
 * modülünü mock'lamak yerine sahte bir abone enjekte eder.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type { UnlistenFn };

/** Tauri `listen` ile aynı imza; enjeksiyon noktası. */
export type EventSubscriber = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<UnlistenFn>;

/** Ham yükü doğrular; tanınmayan biçimde `null` döner. */
export type PayloadParser<T> = (payload: unknown) => T | null;

const tauriSubscriber: EventSubscriber = (event, handler) => listen<unknown>(event, handler);

/**
 * Doğrulanmış yükleri `handler`'a ileten abonelik. Dönen fonksiyon dinleyiciyi
 * kaldırır; kök değişiminde veya bileşen yok olduğunda çağrılmalıdır.
 */
export function subscribeEvent<T>(
  event: string,
  parse: PayloadParser<T>,
  handler: (value: T) => void,
  subscriber: EventSubscriber = tauriSubscriber,
): Promise<UnlistenFn> {
  return subscriber(event, (incoming) => {
    const parsed = parse(incoming.payload);
    if (parsed !== null) handler(parsed);
  });
}
