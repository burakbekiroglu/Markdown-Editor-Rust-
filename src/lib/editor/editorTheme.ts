/**
 * Editörün tema entegrasyonu.
 *
 * Renkler `src/app.css` içindeki token'lardan (`--bg`, `--text`, `--border`,
 * …) okunur; böylece açık/koyu tema ve sistem tercihi değişimi editörde
 * yeniden derleme gerektirmeden görünür. Yalnızca CodeMirror'ın `dark` bayrağı
 * (dolaylı olarak `&dark`/`&light` seçicileri) state'e gömülü olduğundan,
 * tema değişiminde bir `Compartment` ile yeniden yapılandırılır.
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';

import { themeFromMedia, type Theme } from '../app/theme';

/** Kök elemandaki `data-theme` özniteliği; yoksa sistem tercihi geçerlidir. */
export function resolveEditorTheme(root: Element | null = null): Theme {
  const element = root ?? (typeof document === 'undefined' ? null : document.documentElement);
  const attribute = element?.getAttribute('data-theme') ?? null;
  if (attribute === 'light' || attribute === 'dark') return attribute;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return themeFromMedia(window.matchMedia('(prefers-color-scheme: light)').matches);
}

/**
 * Tema değişimini izler: kök elemanın `data-theme` özniteliği (Tauri pencere
 * teması) ve sistem medya sorgusu. Dönen fonksiyon dinleyicileri kaldırır.
 */
export function observeEditorTheme(
  onChange: (theme: Theme) => void,
  root: Element | null = null,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const element = root ?? document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: light)');
  const notify = (): void => onChange(resolveEditorTheme(element));

  const observer = new MutationObserver(notify);
  observer.observe(element, { attributes: true, attributeFilter: ['data-theme'] });
  media.addEventListener('change', notify);

  return () => {
    observer.disconnect();
    media.removeEventListener('change', notify);
  };
}

/**
 * Markdown vurgusu; renkler token'lardan gelir, bu yüzden tema başına ayrı
 * stil tanımlanmaz.
 */
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--text, #d4d4d4)', fontWeight: '700' },
  { tag: tags.strong, color: 'var(--text, #d4d4d4)', fontWeight: '700' },
  { tag: tags.emphasis, color: 'var(--text-dim, #8a8a8a)', fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent, #4f9cf9)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--accent, #4f9cf9)' },
  { tag: tags.monospace, color: 'var(--diff-added, #7ee2a8)' },
  { tag: tags.quote, color: 'var(--text-dim, #8a8a8a)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--accent, #4f9cf9)' },
  { tag: tags.processingInstruction, color: 'var(--text-muted, #8a8a8a)' },
  { tag: tags.contentSeparator, color: 'var(--border, #3c3c3c)' },
]);

/** Editörün görsel dili; tüm renkler CSS değişkenlerini izler. */
function editorChrome(theme: Theme): Extension {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: '0.9rem',
        backgroundColor: 'var(--bg)',
        color: 'var(--text)',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono, Consolas, monospace)',
        lineHeight: '1.55',
      },
      '.cm-content': { caretColor: 'var(--text)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
      '.cm-gutters': {
        backgroundColor: 'var(--bg-elevated)',
        color: 'var(--text-muted)',
        borderRight: '1px solid var(--border)',
      },
      '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
      '.cm-activeLineGutter': {
        backgroundColor: 'var(--bg-hover)',
        color: 'var(--text)',
      },
      '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection)' },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
      '.cm-selectionMatch': { backgroundColor: 'var(--bg-hover)' },
      '.cm-searchMatch': {
        backgroundColor: 'var(--warning-bg)',
        outline: '1px solid var(--warning-border)',
      },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--warning-accent)' },
      '.cm-panels': {
        backgroundColor: 'var(--bg-elevated)',
        color: 'var(--text)',
      },
      '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
      '.cm-panel.cm-search input, .cm-panel.cm-search button': {
        backgroundColor: 'var(--surface-raised)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
      },
      '.cm-matchingBracket': {
        backgroundColor: 'var(--bg-hover)',
        outline: '1px solid var(--border)',
      },
      '.cm-placeholder': { color: 'var(--text-muted)' },
    },
    { dark: theme === 'dark' },
  );
}

/** Editör tema eklentisi: krom + markdown vurgusu birlikte. */
export function editorThemeExtension(theme: Theme): Extension {
  return [editorChrome(theme), syntaxHighlighting(markdownHighlight)];
}
