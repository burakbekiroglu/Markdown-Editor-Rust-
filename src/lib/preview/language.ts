/**
 * Code block dil adlarının highlight.js alt kümesine eşlenmesi.
 *
 * Yalnızca bu editörün vaat ettiği diller çalıştırılır: js, ts, json, bash,
 * rust, python, html, css, md. Bilinmeyen bir dil sade kod bloğu olarak kalır;
 * böylece hiçbir ek dil paketi çalışma anında yüklenmez.
 */

/** highlight.js kayıt kimlikleri; html -> `xml`, md -> `markdown`. */
export const HIGHLIGHT_LANGUAGE_IDS = [
  'javascript',
  'typescript',
  'json',
  'bash',
  'rust',
  'python',
  'xml',
  'css',
  'markdown',
] as const;

export type HighlightLanguage = (typeof HIGHLIGHT_LANGUAGE_IDS)[number];

const ALIASES: Readonly<Record<string, HighlightLanguage>> = {
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'typescript',
  json: 'json',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  rust: 'rust',
  rs: 'rust',
  python: 'python',
  py: 'python',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  md: 'markdown',
  markdown: 'markdown',
};

/**
 * `js`, `js title="x"`, `JavaScript` gibi girdileri kanonik kimliğe çevirir.
 * Desteklenmeyen veya boş dil için `null` döner.
 */
export function normalizeLanguage(input: string | null | undefined): HighlightLanguage | null {
  if (typeof input !== 'string') return null;
  const first = input.trim().split(/\s+/)[0];
  if (!first) return null;
  return ALIASES[first.toLowerCase()] ?? null;
}

/** `language-ts extra` sınıf listesinden desteklenen dili çıkarır. */
export function languageFromClassName(className: string): HighlightLanguage | null {
  for (const name of className.split(/\s+/)) {
    if (!name.startsWith('language-')) continue;
    const language = normalizeLanguage(name.slice('language-'.length));
    if (language !== null) return language;
  }
  return null;
}

const SAFE_LANGUAGE_CLASS = /^[a-z0-9+#._-]+$/;

/**
 * Kod bloğu sınıfı için yazıldığı gibi dil adını döndürür (`ts`, `html`).
 *
 * Ad yalnızca desteklenen bir diğer adsa ve sınıf için güvenli karakterlerden
 * oluşuyorsa kabul edilir; böylece öznitelik enjeksiyonu oluşamaz.
 */
export function languageClass(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const first = input.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!SAFE_LANGUAGE_CLASS.test(first) || normalizeLanguage(first) === null) return null;
  return first;
}
