/**
 * Canlı önizlemenin saf markdown katmanı.
 *
 * - Markdown-it GFM'e yakın çekirdeğiyle çalışır: tablo, görev listesi, üstü
 *   çizili ve kod blokları. `html: false` olduğundan ham HTML hiçbir zaman
 *   etiket olarak yorumlanmaz, metne kaçırılır; `linkify: true` çıplak
 *   adresleri bağlantıya çevirir.
 * - Yerel göreli görseller `mdasset` protokolüne yönlendirilir; uzak, mutlak
 *   ve şemalı görseller hiçbir `src` üretmeden yer tutucuya dönüşür.
 * - Sonuç ayrıca DOMPurify'dan geçirilir (ikinci savunma katmanı): URI şeması
 *   beyaz listesi ve tehlikeli etiket/öznitelik engeli burada uygulanır.
 *
 * Bu modül yalnızca `PreviewPane` içinden, o bileşen de dinamik `import()` ile
 * geldiği için açılış paketine girmez; markdown-it ve DOMPurify ancak ilk
 * önizleme çizilirken yüklenir. Render fonksiyonları DOM'a yalnızca
 * `sanitizeHtml` çağrıldığında dokunur, bu yüzden Node testlerinde doğrudan
 * çalışır.
 */

import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import type { MarkdownIt as MarkdownItInstance, StateCore, Token } from 'markdown-it';

import { languageClass } from './language';
import { SOURCE_LINE_ATTR } from './sourceLine';

export { SOURCE_LINE_ATTR };

/** Aktif sekme içeriğinin önizlemeye yansıma gecikmesi. */
export const PREVIEW_DEBOUNCE_MS = 120;

/** `mdasset` protokolünün Windows'taki kökü. */
const WINDOWS_ASSET_ORIGIN = 'http://mdasset.localhost';
/** Diğer platformlarda özel protokol biçimi. */
const DEFAULT_ASSET_ORIGIN = 'mdasset://localhost';

/** Windows WebView2 özel protokolü `http://<scheme>.localhost` üzerinden sunar. */
export function isWindowsPlatform(): boolean {
  return typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent);
}

/** HTML metni ve öznitelik değerleri için tek kaçırma fonksiyonu. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Göreli görsel yolunu çalışma köküne göre çözer.
 *
 * `null`, görselin yüklenmemesi gerektiği anlamına gelir: uzak URL, `data:`,
 * `file:`, sürücü yolu, UNC yolu veya kökün dışına çıkan `..` dizisi.
 */
export function resolveRelativeAssetPath(
  href: string,
  documentPath: string,
): string | null {
  const normalized = href.trim().replace(/\\/g, '/');
  if (!normalized) return null;
  // Şema (https:, data:, file:, C:) veya protokol-göreli (//host) adresler.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized) || normalized.startsWith('//')) {
    return null;
  }
  if (normalized.startsWith('/')) return null;

  const withoutSuffix = normalized.split(/[?#]/, 1)[0] ?? '';
  if (!withoutSuffix) return null;

  let decoded = withoutSuffix;
  try {
    decoded = decodeURIComponent(withoutSuffix);
  } catch {
    // Bozuk yüzde kodlaması yüklenmez; yolu olduğu gibi denemiyoruz.
    return null;
  }

  const segments = documentPath.split('/').slice(0, -1).filter((part) => part.length > 0);
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }

  return segments.length > 0 ? segments.join('/') : null;
}

/** Çalışma köküne göreli yolu `mdasset` URL'sine çevirir. */
export function mdAssetUrl(
  relativePath: string,
  windows: boolean = isWindowsPlatform(),
): string {
  const encoded = relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const origin = windows ? WINDOWS_ASSET_ORIGIN : DEFAULT_ASSET_ORIGIN;
  return `${origin}/${encoded}`;
}

function renderCode(token: Token): string {
  const language = languageClass(token.info);
  const className = language === null ? '' : ` class="language-${language}"`;
  const line = token.map === null ? null : token.map[0] + 1;
  const lineAttr = line === null ? '' : ` ${SOURCE_LINE_ATTR}="${line}"`;
  // Standart markdown çıktısı gibi kapanış etiketinden önce tek satır sonu.
  const body = token.content.endsWith('\n') ? token.content : `${token.content}\n`;
  return `<pre class="md-code"${lineAttr}><code${className}>${escapeHtml(body)}</code></pre>\n`;
}

/**
 * Her blok token'ına kaynak satırını yazar.
 *
 * Önizleme ile editörün aynı satırı göstermesi bu öznitelik üzerinden
 * eşlenir: `token.map[0]` markdown-it'in 0 tabanlı satırıdır, öznitelik
 * kullanıcıya 1 tabanlı satır verir. Kapanış token'ları öznitelik taşımaz;
 * `inline` token'ının kendi etiketi yoktur (öznitelik kardeşine aittir).
 */
function sourceLineRule(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.nesting < 0 || token.type === 'inline' || token.type === 'fence') continue;
    if (token.map === null) continue;
    token.attrSet(SOURCE_LINE_ATTR, String(token.map[0] + 1));
  }
}

/** Öznitelik değerini metne indirger; yoksa `null`. */
function attrValue(token: Token, name: string): string | null {
  const value = token.attrGet(name);
  return value === null || value === undefined ? null : String(value);
}

function renderImage(token: Token, documentPath: string): string {
  const href = attrValue(token, 'src') ?? '';
  const relative = resolveRelativeAssetPath(href, documentPath);
  const alt = token.content;
  if (relative === null) {
    const label = alt.trim() || href;
    return `<span class="md-image-blocked" role="note" title="Uzak görsel yüklenmez">${escapeHtml(label)}</span>`;
  }
  const src = mdAssetUrl(relative);
  const title = attrValue(token, 'title');
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${titleAttr} loading="lazy">`;
}

/**
 * GFM görev listesi işaretlerini (`[x]` / `[ ]`) onay kutularına çevirir.
 *
 * Markdown-it görev listesini çekirdekte desteklemediği için liste öğesinin
 * ilk inline metni işaretten arındırılır ve yerine devre dışı bir onay kutusu
 * konur. Kutu HTML'i `html: false` ayarından bağımsızdır; kaynak metinden
 * değil, bu kuraldan üretilir ve yine DOMPurify'dan geçer.
 */
function taskListRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let index = 2; index < tokens.length; index += 1) {
    const inline = tokens[index];
    if (inline.type !== 'inline') continue;
    const paragraph = tokens[index - 1];
    const listItem = tokens[index - 2];
    if (listItem.type !== 'list_item_open' || paragraph.type !== 'paragraph_open') continue;

    const children = inline.children;
    const first = children?.[0];
    if (!children || first === undefined || first.type !== 'text') continue;
    const match = /^\[([ xX])\]\s+/.exec(first.content);
    if (match === null) continue;

    const checked = match[1].toLowerCase() === 'x';
    first.content = first.content.slice(match[0].length);
    const checkbox = new state.Token('html_inline', '', 0);
    checkbox.content = `<input type="checkbox" disabled${checked ? ' checked' : ''}> `;
    children.unshift(checkbox);
    listItem.attrJoin('class', 'task-list-item');
  }
}

/**
 * Belge yolu render sırasında `env` ile geçer; böylece parser tek kez kurulur.
 * Parser'ı her render'da yeniden kurmak, her tuş vuruşu debounce'unda yeni bir
 * markdown-it örneği + kural tablosu ayırıyordu (ölçülebilir ayırma çöpü).
 */
interface PreviewEnv {
  documentPath?: string;
  [key: string]: unknown;
  [key: symbol]: unknown;
}

/** Belgenin yoluna bağlı renderer kurallarını bir kez bağlar. */
function createParser(): MarkdownItInstance {
  const parser = new MarkdownIt({ html: false, linkify: true, breaks: false });
  parser.core.ruler.after('inline', 'task_lists', taskListRule);
  // Satır eşlemesi sanitize'dan önce eklenir; şema beyaz listesinde izinlidir.
  parser.core.ruler.push('source_lines', sourceLineRule);
  parser.renderer.rules.fence = (tokens, index) => renderCode(tokens[index]);
  parser.renderer.rules.image = (tokens, index, _options, env) =>
    renderImage(tokens[index], (env as PreviewEnv).documentPath ?? '');
  // Markdown-it üstü çiziliyi `<s>` ile üretir; önizleme `<del>` bekler.
  parser.renderer.rules.s_open = () => '<del>';
  parser.renderer.rules.s_close = () => '</del>';
  return parser;
}

let sharedParser: MarkdownItInstance | null = null;

/** Tek parser örneği; iki farklı klasördeki belge yolu `env` ile ayrışır. */
function parser(): MarkdownItInstance {
  sharedParser ??= createParser();
  return sharedParser;
}

/**
 * Markdown'u güvenli HTML'e çevirir (sanitize öncesi).
 *
 * Parser paylaşılır; belge yolu `env` üzerinden her render'a taşınır. Böylece
 * iki farklı klasördeki belge aynı anda render edilse bile görsel yolları
 * karışmaz ve render başına yeni parser ayrılmaz.
 */
export function renderMarkdown(source: string, documentPath = ''): string {
  const env: PreviewEnv = { documentPath };
  return parser().render(source, env);
}

/** Şema/etkinlik filtreleriyle ikinci savunma katmanı. */
const SANITIZE_OPTIONS: Parameters<typeof DOMPurify.sanitize>[1] = {
  ALLOWED_TAGS: [
    'a',
    'blockquote',
    'br',
    'code',
    'del',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'img',
    'input',
    'li',
    'ol',
    'p',
    'pre',
    'span',
    'strong',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'ul',
  ],
  ALLOWED_ATTR: [
    'alt',
    'checked',
    SOURCE_LINE_ATTR,
    'class',
    'disabled',
    'href',
    'loading',
    'start',
    'src',
    'title',
    'type',
  ],
  FORBID_TAGS: [
    'base',
    'button',
    'embed',
    'form',
    'frame',
    'frameset',
    'iframe',
    'link',
    'math',
    'meta',
    'noscript',
    'object',
    'option',
    'script',
    'select',
    'style',
    'svg',
    'template',
    'textarea',
  ],
  FORBID_ATTR: ['style', 'srcset', 'formaction', 'xlink:href'],
  // Bu öznitelikler URL değil, sabit değer taşır; URI regexp'i bunlara
  // uygulanmamalı (ör. type="checkbox" aksi halde düşer).
  ADD_URI_SAFE_ATTR: ['checked', 'disabled', 'loading', 'start', 'type', SOURCE_LINE_ATTR],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: true,
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|mailto):|(?:https?:\/\/mdasset\.localhost\/)|mdasset:)/i,
};

/** `src` değeri yalnızca yerel `mdasset` protokolüne mi ait? */
function isMdAssetSrc(src: string): boolean {
  return (
    src.startsWith('mdasset://localhost/') ||
    src.startsWith('http://mdasset.localhost/') ||
    src.startsWith('https://mdasset.localhost/')
  );
}

/**
 * Sanitize sonrasÄ± son savunma: `img` kaynaÄŸÄ± yerel protokol deÄŸilse gÃ¶rsel
 * dÃ¼ÄŸÃ¼mÃ¼ yer tutucuya dÃ¶nÃ¼ÅŸtÃ¼rÃ¼lÃ¼r, bÃ¶ylece uzak bir adres asla istenmez.
 *
 * AyrÄ±ÅŸtÄ±rma **tek bir kalÄ±cÄ±** `<template>` Ã¼zerinde yapÄ±lÄ±r ve iÅŸ bitince
 * iÃ§eriÄŸi boÅŸaltÄ±lÄ±r. Her render'da yeni bir template kurmak, her Ã§aÄŸrÄ± iÃ§in
 * ayrÄ± bir "template contents owner" belgesi ve o belgenin tÃ¼m dÃ¼ÄŸÃ¼mlerini
 * ayÄ±rÄ±yordu; ziyaret edilen her sekme bu dÃ¼ÄŸÃ¼mleri bellekte bÄ±rakÄ±yordu
 * (Ã¶lÃ§Ã¼ldÃ¼: render baÅŸÄ±na +1 belge, +~5.6k dÃ¼ÄŸÃ¼m).
 */
let scratchTemplate: HTMLTemplateElement | null = null;

function neutralizeRemoteImages(html: string): string {
  if (typeof document === 'undefined') return html;
  // Görsel içermeyen belgelerde ayrıştırma tamamen atlanır: görselleri
  // değiştirmek için belge boyutunda bir düğüm ağacı kurmak gereksizdir.
  // Ölçüm belgelerinde (ve tipik markdown'da) bu, render başına ~5.6k geçici
  // düğümün hiç ayrılmaması demektir. DOMPurify çıktısı küçük harflidir.
  if (!html.includes('<img')) return html;
  scratchTemplate ??= document.createElement('template');
  const template = scratchTemplate;
  template.innerHTML = html;
  for (const image of template.content.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? '';
    if (isMdAssetSrc(src)) {
      image.setAttribute('loading', 'lazy');
      continue;
    }
    const placeholder = document.createElement('span');
    placeholder.className = 'md-image-blocked';
    placeholder.title = 'Uzak gÃ¶rsel yÃ¼klenmez';
    placeholder.textContent = image.getAttribute('alt') || 'GÃ¶rsel yÃ¼klenmedi';
    image.replaceWith(placeholder);
  }
  const result = template.innerHTML;
  // Ä°Ã§erik boÅŸaltÄ±lÄ±r: aksi hâlde son render'Ä±n dÃ¼ÄŸÃ¼mleri yaÅŸamaya devam eder.
  template.innerHTML = '';
  return result;
}

/** Kaçırılmış markdown çıktısını beyaz listeyle temizler. */
export function sanitizeHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, SANITIZE_OPTIONS);
  return neutralizeRemoteImages(clean);
}

/** Önizlemenin tek giriş noktası: render + sanitize. */
export function renderPreview(source: string, documentPath = ''): string {
  return sanitizeHtml(renderMarkdown(source, documentPath));
}
