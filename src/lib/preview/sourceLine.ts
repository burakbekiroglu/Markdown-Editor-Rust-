/**
 * Satır eşlemeli senkron kaydırmanın okuduğu öznitelik adı.
 *
 * Ayrı bir modülde tutulur: editör kabuğu (`EditorPane`) bu sabiti statik
 * olarak import eder, önizleme ise tembel yüklenir. Sabit `markdown.ts`
 * içinde kalsaydı, yalnızca bir öznitelik adı için markdown-it ve DOMPurify
 * da editör chunk'ına sızardı.
 */
export const SOURCE_LINE_ATTR = 'data-source-line';
