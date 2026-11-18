/**
 * Sistem teması eşitlemesi.
 *
 * İki kaynak aynı `data-theme` özniteliğini besler: `prefers-color-scheme`
 * medya sorgusu (tarayıcı/WebView2 varsayılanı) ve Tauri'nin pencere tema
 * olayı. CSS'te medya sorgusu tek başına da doğru token setini seçer; öznitelik
 * çalışma anında gelen değişimi uygular. Bu modül ağır bağımlılık içermez;
 * Tauri olay API'si yalnızca ihtiyaç anında dinamik `import()` ile yüklenir.
 */

export type Theme = 'light' | 'dark';

/** Medya sorgusu sonucunu temaya çevirir. */
export function themeFromMedia(prefersLight: boolean): Theme {
  return prefersLight ? 'light' : 'dark';
}

/** Tauri olay yükü güvenilmeyen veridir; tanınmayan değer yok sayılır. */
export function themeFromTauri(value: unknown): Theme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

/** `applyTheme` için gereken en küçük yüzey; testler sahte bir kök verebilir. */
export interface ThemeTarget {
  dataset: { theme?: string };
}

/**
 * Temayı kök elemana yazar. CSS `:root[data-theme=...]` kuralları ve
 * `color-scheme` bu özniteliği izler.
 *
 * `dataset.theme` kullanılır: `dataset['data-theme']` gibi tire içeren bir
 * anahtar DOMStringMap üzerinde `SyntaxError` fırlatır ve çağıran `onMount`
 * zincirini keser.
 */
export function applyTheme(theme: Theme, root: ThemeTarget = document.documentElement): void {
  root.dataset.theme = theme;
}

/** Medya sorgusunun ihtiyaç duyulan tek yüzeyi; testler sahte bir kaynak verebilir. */
export interface MediaQuerySource {
  (query: string): { matches: boolean };
}

/**
 * Sistem tercihini dinleyici kurmadan uygular.
 *
 * `main.ts` bunu montajdan **önce** çağırır: ilk kare koyu varsayılanla boyanıp
 * ardından açığa dönmez (tema kırpışması yok). `startThemeSync` aynı çözümlemeyi
 * dinleyicilerle sürdürür.
 */
export function applySystemTheme(
  root: ThemeTarget = document.documentElement,
  matchMedia: MediaQuerySource = (query) => window.matchMedia(query),
): void {
  applyTheme(themeFromMedia(matchMedia('(prefers-color-scheme: light)').matches), root);
}

/**
 * Sistem temasını izlemeye başlar ve mevcut temayı hemen uygular.
 * Dönen fonksiyon tüm dinleyicileri kaldırır; bileşen yok olduğunda çağrılır.
 */
export function startThemeSync(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

  const media = window.matchMedia('(prefers-color-scheme: light)');
  const syncFromMedia = (): void => applyTheme(themeFromMedia(media.matches));
  syncFromMedia();
  media.addEventListener('change', syncFromMedia);

  let stopTauri: (() => void) | null = null;
  let cancelled = false;

  void import('@tauri-apps/api/event')
    .then(({ listen, TauriEvent }) =>
      // Pencereye hedefli `tauri://theme-changed` olayı, hedefsiz (Any)
      // dinleyicilere de teslim edilir; böylece `@tauri-apps/api/window`
      // modülünün (~21 KB ham) ilk yük paketine girmesi gerekmez.
      listen<unknown>(TauriEvent.WINDOW_THEME_CHANGED, ({ payload }) => {
        const theme = themeFromTauri(payload);
        if (theme !== null) applyTheme(theme);
      }),
    )
    .then((unlisten) => {
      if (cancelled) unlisten();
      else stopTauri = unlisten;
    })
    .catch(() => {
      // Tarayıcıda veya olay izni yoksa pencere teması olayı kurulamaz;
      // medya sorgusu tek başına doğru temayı üretmeye devam eder.
    });

  return () => {
    cancelled = true;
    media.removeEventListener('change', syncFromMedia);
    stopTauri?.();
    stopTauri = null;
  };
}
