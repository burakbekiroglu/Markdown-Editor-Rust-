/**
 * Açılış ilk boya işareti ve Rust tarafına süre bildirimi.
 *
 * `requestAnimationFrame` iki kez zincirlenerek tarayıcının ilk kareyi gerçekten
 * çizdiği ana yaklaşılır. O anda:
 *
 * - `performance.mark('app:first-paint')` zaman çizelgesine işaret koyar,
 * - Rust'a `report_first_paint` komutu gönderilir; Rust kendi `Instant`
 *   sayacından geçen süreyi hesaplar ve loglar (release derlemesinde de
 *   okunabilen değer komutun dönüşüdür).
 *
 * Ölçüm isteğe bağlıdır: komut başarısız olursa uygulama davranışı değişmez.
 * Hata yine de yutulmaz — `invokeCommand` reddi tipli `AppError` olarak
 * yukarı iletilir; çağıran (`main.ts`) sahiplenmezse küresel
 * `unhandledrejection` dinleyicisi kullanıcıya taşır.
 */
import { invokeCommand } from '../ipc/client';

/** Zaman çizelgesindeki işaret adı. */
export const FIRST_PAINT_MARK = 'app:first-paint';
/** Rust `Instant` sayacından okunan süreç süresinin işaret adı. */
export const FIRST_PAINT_RUST_MARK = 'app:first-paint:rust';

/**
 * İlk kare çizildikten sonra çağrılır; işareti koyar ve süreyi bildirir.
 * Dönen promise, IPC reddini normalize edilmiş `AppError` olarak iletir;
 * bu modül hatayı sessizce yutmaz.
 */
export function reportFirstPaint(): Promise<void> {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark(FIRST_PAINT_MARK);
  }

  const pageMs =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? Math.round(performance.now())
      : 0;

  return invokeCommand('report_first_paint', { pageMs }).then((processMs) => {
    // Rust'ın `Instant` değeri zaman çizelgesine yazılır; ölçüm koşucusu
    // gerçek ilk boya anındaki süreç süresini buradan okur.
    if (typeof processMs !== 'number' || !Number.isFinite(processMs)) return;
    try {
      performance.mark(FIRST_PAINT_RUST_MARK, { startTime: processMs });
    } catch {
      // Zaman çizelgesi gelecekteki bir başlangıcı reddederse ölçüm düşer;
      // uygulama davranışı etkilenmez. Bu bir IPC hatası değildir.
    }
  });
}
