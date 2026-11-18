<script lang="ts">
  /**
   * Aktif sekmenin canlı önizlemesi.
   *
   * Kaynak metin her tuş vuruşunda gelir; HTML üretimi 120 ms debounce ile
   * yapılır. Kod vurgulama, sanitize edilmiş HTML DOM'a girdikten sonra
   * highlight.js alt kümesi yüklenince uygulanır; o ana kadar sade kod bloğu
   * görünür.
   */
  import { toast } from '../tree/toast.svelte';
  import { highlightCodeBlocks } from './highlight';
  import { isExternalUrl, openExternalUrl } from './links';
  import { PREVIEW_DEBOUNCE_MS, renderPreview } from './markdown';

  let {
    source,
    documentPath,
    active = true,
    element = $bindable<HTMLElement | null>(null),
  }: {
    source: string;
    documentPath: string;
    /** Panel görünür mü; görünmezken markdown yeniden render edilmez. */
    active?: boolean;
    /** Kaydırma kabı; bölünmüş modda senkron için üst bileşene açılır. */
    element?: HTMLElement | null;
  } = $props();

  let content = $state<HTMLElement | null>(null);
  let html = $state('');

  // Önizleme kabı bağlandığında/çözüldüğünde üst bileşene bildirilir; scroll
  // senkronu bu elemanı dinler. Bileşen sökülürse bağ da temizlenir.
  $effect(() => {
    element = content;
    return () => {
      element = null;
    };
  });

  $effect(() => {
    if (!active) return;
    const nextSource = source;
    const nextPath = documentPath;
    const timer = setTimeout(() => {
      html = renderPreview(nextSource, nextPath);
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const target = content;
    const rendered = html;
    if (target === null || rendered.length === 0) return;
    void highlightCodeBlocks(target);
  });

  /**
   * Önizlemedeki bağlantılar WebView'i terk etmez: varsayılan davranış
   * durdurulur ve yalnızca dış adresler opener ile sistem tarayıcısında
   * açılır. Göreli yollar sessizce yok sayılır; klavyeyle Enter da aynı
   * `click` olayını ürettiği için ayrı bir yol gerekmez.
   */
  async function onContentClick(event: MouseEvent): Promise<void> {
    const target = event.target;
    const anchor = target instanceof Element ? target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const href = anchor.getAttribute('href');
    if (href === null) return;
    event.preventDefault();
    if (!isExternalUrl(href)) return;
    try {
      await openExternalUrl(href);
    } catch {
      toast.error('Bağlantı sistem tarayıcısında açılamadı.');
    }
  }

  // Tıklama, `{@html}` ile gelen bağlantılardan kabı dinleyerek devralınır:
  // etkileşimli öğe bağlantının kendisidir, kap değil. Klavye ile Enter da
  // bağlantıda `click` ürettiği için ayrı bir tuş işleyicisi gerekmez.
  $effect(() => {
    const target = content;
    if (target === null) return;
    const handler = (event: MouseEvent) => void onContentClick(event);
    target.addEventListener('click', handler);
    return () => target.removeEventListener('click', handler);
  });
</script>

<article class="preview-pane" bind:this={content} aria-label="Canlı önizleme">
  {#if html.length > 0}
    {@html html}
  {:else}
    <p class="preview-empty">Önizleme için yazmaya başlayın.</p>
  {/if}
</article>

<style>
  .preview-pane {
    flex: 1 1 auto;
    min-width: 0;
    /* Satır eşlemeli senkron `offsetTop`'u bu kabın içinde okur. */
    position: relative;
    overflow: auto;
    padding: 1.25rem 1.5rem 3rem;
    border-left: 1px solid var(--border);
    font-size: 0.88rem;
    line-height: 1.65;
    color: var(--text);
    background: var(--bg);
    overflow-wrap: anywhere;
  }

  .preview-empty {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.82rem;
  }

  .preview-pane :global(h1),
  .preview-pane :global(h2),
  .preview-pane :global(h3),
  .preview-pane :global(h4),
  .preview-pane :global(h5),
  .preview-pane :global(h6) {
    margin: 1.4em 0 0.55em;
    font-weight: 600;
    line-height: 1.25;
  }

  .preview-pane :global(h1) {
    font-size: 1.55em;
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--border);
  }

  .preview-pane :global(h2) {
    font-size: 1.3em;
    padding-bottom: 0.25em;
    border-bottom: 1px solid var(--border);
  }

  .preview-pane :global(h3) {
    font-size: 1.12em;
  }

  .preview-pane :global(p),
  .preview-pane :global(ul),
  .preview-pane :global(ol),
  .preview-pane :global(blockquote),
  .preview-pane :global(pre),
  .preview-pane :global(table) {
    margin: 0 0 0.9em;
  }

  .preview-pane :global(ul),
  .preview-pane :global(ol) {
    padding-left: 1.5em;
  }

  .preview-pane :global(li + li) {
    margin-top: 0.25em;
  }

  .preview-pane :global(li > input[type='checkbox']) {
    margin: 0 0.4em 0 -1.2em;
    vertical-align: middle;
    accent-color: var(--accent);
  }

  .preview-pane :global(a) {
    color: var(--accent);
    text-decoration: none;
  }

  .preview-pane :global(a:hover) {
    text-decoration: underline;
  }

  .preview-pane :global(del) {
    color: var(--text-dim);
  }

  .preview-pane :global(blockquote) {
    padding: 0.15em 0.9em;
    border-left: 3px solid var(--border);
    color: var(--text-dim);
  }

  .preview-pane :global(hr) {
    margin: 1.4em 0;
    border: none;
    border-top: 1px solid var(--border);
  }

  .preview-pane :global(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.94em;
  }

  .preview-pane :global(th),
  .preview-pane :global(td) {
    padding: 0.4em 0.65em;
    border: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
  }

  .preview-pane :global(th) {
    background: var(--bg-elevated);
    font-weight: 600;
  }

  .preview-pane :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
  }

  .preview-pane :global(.md-image-blocked) {
    display: inline-block;
    padding: 0.15em 0.5em;
    border: 1px dashed var(--border);
    border-radius: 4px;
    color: var(--text-dim);
    font-size: 0.85em;
  }

  .preview-pane :global(code) {
    font-family: var(--font-mono, Consolas, monospace);
    font-size: 0.92em;
  }

  .preview-pane :global(:not(pre) > code) {
    padding: 0.12em 0.35em;
    border-radius: 4px;
    background: var(--bg-elevated);
  }

  .preview-pane :global(pre.md-code) {
    overflow-x: auto;
    padding: 0.75em 0.9em;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: #161616;
    line-height: 1.5;
  }

  .preview-pane :global(pre.md-code code) {
    padding: 0;
    background: none;
    white-space: pre;
  }

  /* highlight.js alt kümesi için küçük, yerel bir tema. */
  .preview-pane :global(.hljs-comment),
  .preview-pane :global(.hljs-quote) {
    color: #6a9955;
  }

  .preview-pane :global(.hljs-keyword),
  .preview-pane :global(.hljs-selector-tag),
  .preview-pane :global(.hljs-literal),
  .preview-pane :global(.hljs-type) {
    color: #c586c0;
  }

  .preview-pane :global(.hljs-string),
  .preview-pane :global(.hljs-regexp),
  .preview-pane :global(.hljs-attr) {
    color: #ce9178;
  }

  .preview-pane :global(.hljs-number),
  .preview-pane :global(.hljs-symbol) {
    color: #b5cea8;
  }

  .preview-pane :global(.hljs-title),
  .preview-pane :global(.hljs-section),
  .preview-pane :global(.hljs-name) {
    color: #dcdcaa;
  }

  .preview-pane :global(.hljs-built_in),
  .preview-pane :global(.hljs-variable),
  .preview-pane :global(.hljs-template-variable),
  .preview-pane :global(.hljs-params) {
    color: #9cdcfe;
  }

  .preview-pane :global(.hljs-meta),
  .preview-pane :global(.hljs-tag) {
    color: #569cd6;
  }

  .preview-pane :global(.hljs-emphasis) {
    font-style: italic;
  }

  .preview-pane :global(.hljs-strong) {
    font-weight: 600;
  }
</style>
