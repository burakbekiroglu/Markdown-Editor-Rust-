/**
 * Son savunma hattı: hiçbir hata sessizce kaybolmaz.
 *
 * Yerel `catch` blokları bilinen hata yollarını kullanıcıya zaten bildirir
 * (`describeAppError` + toast). Bu modül yalnızca **sahipsiz** kalanları
 * yakalar:
 *
 * - `unhandledrejection`: hiç `catch` edilmemiş bir `Promise` reddi.
 * - `error`: dinleyicisi olmayan bir olay işleyicisinden kaçan istisna.
 *
 * Taşıyıcı (`GlobalErrorTarget`) ve bildirim (`report`) dışarıdan verilir;
 * üretimde `window` ve toast, testlerde sahte nesneler. Böylece DOM veya
 * Svelte çalışma zamanı olmadan davranış doğrudan sınanır — `saveTab` ve
 * `createInvokeCommand` ile aynı enjeksiyon deseni.
 */

/** Yakalanan olayın bu modülün ihtiyaç duyduğu alanları. */
export interface GlobalErrorEvent {
  /** `unhandledrejection` olayında reddin nedeni. */
  readonly reason?: unknown;
  /** `error` olayında hata nesnesi; kaynak yükleme hatalarında `null`. */
  readonly error?: unknown;
  /** `error` olayında serbest metin mesaj. */
  readonly message?: string;
  /** Varsayılan tarayıcı günlüklemesini susturmak için. */
  preventDefault(): void;
}

/** `window` benzeri, test edilebilir olay hedefi. */
export interface GlobalErrorTarget {
  addEventListener(type: string, handler: (event: GlobalErrorEvent) => void): void;
  removeEventListener(type: string, handler: (event: GlobalErrorEvent) => void): void;
}

/** Bildirim kanalı: tipli hata → kullanıcıya görünen mesaj. */
export type GlobalErrorReporter = (error: unknown) => void;

/**
 * Yakalanacak olaylar. `error` olayı hem betik istisnaları hem de kaynak
 * yükleme hataları için tetiklenir; ikincisinde `error` `null` olur ve
 * yalnızca `message` taşınır.
 */
const EVENT_TYPES = ['unhandledrejection', 'error'] as const;

function payloadOf(event: GlobalErrorEvent): unknown {
  if (event.error !== undefined && event.error !== null) return event.error;
  if (typeof event.message === 'string' && event.message.trim().length > 0) {
    return event.message;
  }
  return event.reason;
}

/**
 * Küresel dinleyicileri kurar ve kaldırma fonksiyonu döndürür.
 *
 * Her olay `report`'a ham `unknown` olarak verilir: normalizasyon tek
 * kaynaktan (`normalizeAppError`) yapılır, böylece kullanıcı mesajı her
 * yüzeyde aynı biçimde görünür.
 */
export function installGlobalErrorHandlers(
  target: GlobalErrorTarget,
  report: GlobalErrorReporter,
): () => void {
  const handleRejection = (event: GlobalErrorEvent): void => {
    // Reddi "işlenmiş" saymayız: konsol kaydı ve rapor bizim işimiz.
    event.preventDefault();
    report(event.reason);
  };

  const handleError = (event: GlobalErrorEvent): void => {
    const payload = payloadOf(event);
    if (payload === undefined || payload === null) return;
    event.preventDefault();
    report(payload);
  };

  const handlers: Record<(typeof EVENT_TYPES)[number], (event: GlobalErrorEvent) => void> = {
    unhandledrejection: handleRejection,
    error: handleError,
  };

  for (const type of EVENT_TYPES) target.addEventListener(type, handlers[type]);

  return () => {
    for (const type of EVENT_TYPES) target.removeEventListener(type, handlers[type]);
  };
}
