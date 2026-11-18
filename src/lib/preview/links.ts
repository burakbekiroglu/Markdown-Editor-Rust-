/**
 * Önizleme bağlantılarının sistem tarayıcısına aktarılması.
 *
 * WebView içi navigasyon `security::is_allowed_navigation` ile kapatıldığı
 * için bir bağlantıya tıklamak tek başına hiçbir yere gitmez. Bu modül tek
 * izinli çıkış yoludur: yalnızca `http:` ve `https:` adresleri opener
 * eklentisine iletilir; göreli yollar ve `mailto:`, `file:`, `javascript:`,
 * `data:` gibi şemalar sessizce yok sayılır.
 */

const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** Bağlantı sistem tarayıcısında açılmaya uygun mu? */
export function isExternalUrl(href: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

/**
 * Adresi sistemin varsayılan uygulamasında açar.
 *
 * Opener eklentisi yalnızca çağrı anında dinamik olarak yüklenir; böylece bu
 * modülü içe aktaran testler ve tarayıcı dışı ortamlar Tauri köprüsüne ihtiyaç
 * duymaz. Uygun olmayan adres `false` döner; eklentinin reddi çağırana iletilir.
 */
export async function openExternalUrl(href: string): Promise<boolean> {
  if (!isExternalUrl(href)) return false;
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(href);
  return true;
}
