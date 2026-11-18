/**
 * highlight.js alt kümesinin tembel yükleyicisi.
 *
 * Çekirdek ve **yalnızca belgede görünen diller** ilk kod bloğu göründüğünde
 * dinamik `import()` ile yüklenir. Dokuz dil paketini birlikte yüklemek,
 * kullanılmayan yedi dilin modül/JIT maliyetini her oturuma taşır; bu yüzden
 * her dil kendi vaadiyle, ilk kez o dilde bir blok görüldüğünde yüklenir.
 * Yükleme tamamlanana kadar önizleme sade `<pre><code>` bloğunu gösterir;
 * yükleme başarısız olursa o dil için sade görünüm kalıcı olur. Dil paketleri
 * hiçbir zaman toplu (eager) yüklenmez.
 */

import type { HLJSApi, LanguageFn } from 'highlight.js';

import { languageFromClassName, type HighlightLanguage } from './language';

/** Dil kimliği başına modül yükleyicisi; her biri ayrı bir chunk. */
const LANGUAGE_IMPORTERS: Readonly<
  Record<HighlightLanguage, () => Promise<{ default: LanguageFn }>>
> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  json: () => import('highlight.js/lib/languages/json'),
  bash: () => import('highlight.js/lib/languages/bash'),
  rust: () => import('highlight.js/lib/languages/rust'),
  python: () => import('highlight.js/lib/languages/python'),
  xml: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
};

/** Çekirdek bir kez yüklenir; sonuç (veya `null`) önbelleğe alınır. */
let core: Promise<HLJSApi | null> | null = null;

/** Dil başına yükleme vaadi; aynı dil ikinci kez istenirse yeniden yüklenmez. */
const languages = new Map<HighlightLanguage, Promise<boolean>>();

function loadCore(): Promise<HLJSApi | null> {
  core ??= import('highlight.js/lib/core')
    .then((module) => module.default)
    .catch(() => {
      // Yükleme başarısızsa sade kod bloğu kalır; bu bilinçli geri çekilmedir.
      return null;
    });
  return core;
}

/**
 * Tek bir dili çekirdeğe kaydeder. Başarısızlık o dil için `false` döner;
 * diğer diller ve önizlemenin geri kalanı etkilenmez.
 */
function loadLanguage(api: HLJSApi, language: HighlightLanguage): Promise<boolean> {
  const cached = languages.get(language);
  if (cached !== undefined) return cached;
  const pending = LANGUAGE_IMPORTERS[language]()
    .then((module) => {
      api.registerLanguage(language, module.default);
      return true;
    })
    .catch(() => false);
  languages.set(language, pending);
  return pending;
}

/** Testler için: çekirdek ve dil önbelleklerini sıfırlar. */
export function resetHighlighterForTests(): void {
  core = null;
  languages.clear();
}

/**
 * Kök altındaki henüz vurgulanmamış kod bloklarını vurgular.
 *
 * Yalnızca blokların gerçekten kullandığı diller yüklenir; böylece bir belge
 * `js` içeriyorsa `rust`/`xml`/`css` paketleri hiç indirilmez. Vurgulama,
 * metin içeriğinden üretildiği için ek HTML enjeksiyonu oluşmaz. Yeniden
 * render edilen düğümlerde `data-highlighted` işareti bulunmadığından her blok
 * yalnızca bir kez işlenir.
 */
export async function highlightCodeBlocks(root: HTMLElement): Promise<void> {
  const candidates: { element: HTMLElement; language: HighlightLanguage }[] = [];
  for (const element of root.querySelectorAll<HTMLElement>('pre.md-code > code')) {
    if (element.dataset.highlighted === 'true') continue;
    const language = languageFromClassName(element.className);
    if (language !== null) candidates.push({ element, language });
  }
  if (candidates.length === 0) return;

  const api = await loadCore();
  if (api === null) return;

  const requested = [...new Set(candidates.map((candidate) => candidate.language))];
  const loaded = await Promise.all(
    requested.map((language) => loadLanguage(api, language)),
  );
  const available = new Set(requested.filter((_, index) => loaded[index] === true));
  if (available.size === 0) return;

  for (const { element, language } of candidates) {
    if (!available.has(language)) continue;
    const source = element.textContent ?? '';
    try {
      element.innerHTML = api.highlight(source, { language }).value;
      element.dataset.highlighted = 'true';
      element.classList.add('hljs');
    } catch {
      // Tek blok başarısız olursa sade metin olduğu gibi kalır.
      element.dataset.highlighted = 'failed';
    }
  }
}
