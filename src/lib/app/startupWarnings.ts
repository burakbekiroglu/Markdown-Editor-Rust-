/**
 * Pencere açılmadan önce oluşan hataların kullanıcıya taşınması.
 *
 * Rust, uygulamayı durdurmayan açılış hatalarını (bozuk oturum dosyası,
 * bulunamayan oturum dizini) bir kuyrukta tutar. Bu hatalar Tauri olayıyla
 * gönderilemez: oluştuklarında webview henüz dinlemiyor. Bu yüzden frontend
 * hazır olduğunda kuyruğu bir kez çeker ve her uyarıyı tipli hata olarak
 * gösterir.
 *
 * Taşıyıcı (`StartupWarningReader`) ve bildirim (`StartupWarningReporter`)
 * dışarıdan verilir; `globalErrors` ve `createInvokeCommand` ile aynı
 * enjeksiyon deseni. Böylece davranış Svelte veya Tauri olmadan sınanır.
 */

/** Kuyruğu boşaltan okuma; üretimde `take_startup_warnings` komutu. */
export type StartupWarningReader = () => Promise<readonly unknown[]>;

/** Bildirim kanalı: ham uyarı → kullanıcıya görünen tipli hata. */
export type StartupWarningReporter = (warning: unknown) => void;

/**
 * Birikmiş açılış uyarılarını okur, her birini bildirir ve kaç uyarı
 * gösterildiğini döndürür.
 *
 * Okuma başarısız olursa bu da sessizce yutulmaz: hata `report`'a verilir,
 * dönen sayı `0` olur. Böylece "uyarı yok" ile "uyarılar okunamadı"
 * birbirine karışmaz.
 */
export async function reportStartupWarnings(
  read: StartupWarningReader,
  report: StartupWarningReporter,
): Promise<number> {
  let warnings: readonly unknown[];
  try {
    warnings = await read();
  } catch (error) {
    report(error);
    return 0;
  }
  for (const warning of warnings) report(warning);
  return warnings.length;
}
