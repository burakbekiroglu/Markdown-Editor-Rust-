<script lang="ts">
  /**
   * Sarı çakışma bandı.
   *
   * Diskteki değişiklik ile kaydedilmemiş editör içeriği burada karşı karşıya
   * gelir; bant açık olduğu sürece hiçbir içerik sessizce değişmez:
   * - "Diski Yükle" yalnızca açık onaydan sonra uygulanır,
   * - "Benimkini Yaz" editör içeriğini diske yazar; yazma başarılı olmadan bant
   *   kapanmaz ve içerik korunur,
   * - "Farkı Gör" salt okunur karşılaştırma açar.
   */
  import ConfirmDialog from '../tree/ConfirmDialog.svelte';
  import type { PendingConflict } from './conflict';
  import { lineDiff, type DiffLine } from './diff';

  let {
    conflict,
    onLoadDisk,
    onWriteMine,
    readEditorContents,
  }: {
    conflict: PendingConflict;
    /** Onay verildikten sonra çağrılır; başarısızsa bant açık kalır. */
    onLoadDisk: () => Promise<void> | void;
    /** Kullanıcı kararı: editör içeriğini diske yazar. */
    onWriteMine: () => Promise<void> | void;
    /**
     * Editörün güncel içeriğini okur. Verilmezse çakışma anındaki anlık görüntü
     * kullanılır; böylece "Farkı Gör" her zaman gerçek editör içeriğini gösterir.
     */
    readEditorContents?: () => string | null;
  } = $props();

  let confirming = $state(false);
  /** Yazma sürerken ikinci bir yazma isteği üretilmez. */
  let writing = $state(false);
  let showDiff = $state(false);
  /** Fark paneli açıldığı andaki çift; panel salt okunur bir anlık görüntüdür. */
  let snapshot = $state<{ disk: string; editor: string } | null>(null);

  /** Aynı anda birden çok bant açılabildiği için DOM kimliği sekme başına benzersizdir. */
  const diffId = $derived(`conflict-diff-${conflict.tabId}`);

  const diff: DiffLine[] = $derived(
    showDiff && snapshot ? lineDiff(snapshot.disk, snapshot.editor) : [],
  );

  function toggleDiff(): void {
    if (showDiff) {
      showDiff = false;
      return;
    }
    // Kullanıcı bant açıldıktan sonra yazmaya devam etmiş olabilir; fark,
    // editörün o andaki içeriğiyle disk içeriğini karşılaştırır.
    snapshot = {
      disk: conflict.diskContents,
      editor: readEditorContents?.() ?? conflict.editorContents,
    };
    showDiff = true;
  }

  function requestReload(): void {
    confirming = true;
  }

  async function confirmReload(): Promise<void> {
    await onLoadDisk();
    confirming = false;
  }

  async function requestWriteMine(): Promise<void> {
    if (writing) return;
    writing = true;
    try {
      await onWriteMine();
    } finally {
      writing = false;
    }
  }
</script>

<section class="conflict" role="alert" aria-label="Dış değişiklik çakışması">
  <div class="bar">
    <span class="mark" aria-hidden="true">⚠</span>
    <div class="text">
      <strong>{conflict.path}</strong>
      <span>diskte siz düzenlerken değişti. Kaydedilmemiş değişiklikleriniz korunuyor.</span>
    </div>
    <div class="actions">
      <button type="button" class="reload" disabled={writing} onclick={requestReload}>
        Diski Yükle
      </button>
      <button
        type="button"
        class="keep"
        disabled={writing}
        aria-busy={writing}
        onclick={requestWriteMine}
      >
        Benimkini Yaz
      </button>
      <button
        type="button"
        class="diff"
        aria-expanded={showDiff}
        aria-controls={diffId}
        onclick={toggleDiff}
      >
        Farkı Gör
      </button>
    </div>
  </div>

  {#if showDiff}
    <div id={diffId} class="diff-panel" aria-label="Salt okunur fark" aria-readonly="true">
      <header class="diff-head">
        <span>Salt okunur karşılaştırma</span>
        <span class="legend">
          <span class="legend-item removed">− diskteki</span>
          <span class="legend-item added">+ editördeki</span>
        </span>
        <button type="button" class="close" onclick={() => (showDiff = false)}>Kapat</button>
      </header>
      <div class="diff-body">
        {#each diff as line, index (index)}
          <div class="diff-line {line.kind}">
            <span class="gutter">{line.oldLine ?? ''}</span>
            <span class="gutter">{line.newLine ?? ''}</span>
            <span class="sign" aria-hidden="true">{line.kind === 'added'
                ? '+'
                : line.kind === 'removed'
                  ? '−'
                  : ' '}</span>
            <span class="code">{line.text}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</section>

{#if confirming}
  <ConfirmDialog
    title="Diski yükle"
    message="Bu sekmedeki kaydedilmemiş değişiklikler kaybolacak ve dosya diskteki sürümle değiştirilecek. İmleç ve kaydırma konumunuz korunur. Devam edilsin mi?"
    confirmLabel="Değişiklikleri kaybet ve yükle"
    danger
    onConfirm={confirmReload}
    onCancel={() => (confirming = false)}
  />
{/if}

<style>
  .conflict {
    border: 1px solid var(--warning-border, #b8860b);
    border-radius: 8px;
    background: var(--warning-bg, #3a2f0b);
    color: var(--warning-text, #ffe9a8);
    box-shadow: 0 10px 28px rgb(0 0 0 / 35%);
    overflow: hidden;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.65rem;
  }

  .mark {
    font-size: 1rem;
    line-height: 1;
    color: var(--warning-accent, #f5c451);
  }

  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
    font-size: 0.8rem;
    line-height: 1.4;
  }

  .text strong {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 22ch;
  }

  .actions {
    display: flex;
    gap: 0.35rem;
    flex-shrink: 0;
  }

  .actions button,
  .close {
    padding: 0.28rem 0.6rem;
    border-radius: 5px;
    border: 1px solid var(--warning-border, #b8860b);
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.76rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .actions button:hover,
  .close:hover {
    background: rgb(255 233 168 / 12%);
  }

  .actions .reload {
    border-color: var(--warning-accent, #f5c451);
    font-weight: 600;
  }

  .diff-panel {
    border-top: 1px solid var(--warning-border, #b8860b);
    background: var(--surface-raised, #1b1f27);
    color: var(--text, #e7eaf0);
  }

  .diff-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.35rem 0.65rem;
    font-size: 0.72rem;
    color: var(--text-muted, #b3bac7);
  }

  .legend {
    display: flex;
    gap: 0.5rem;
    margin-left: auto;
  }

  .legend-item.removed {
    color: var(--diff-removed, #ff8b8b);
  }

  .legend-item.added {
    color: var(--diff-added, #7ee2a8);
  }

  .diff-body {
    max-height: 16rem;
    overflow: auto;
    font-family: var(--font-mono, 'Cascadia Mono', Consolas, monospace);
    font-size: 0.74rem;
    line-height: 1.45;
    padding-bottom: 0.35rem;
  }

  .diff-line {
    display: flex;
    gap: 0.5rem;
    padding: 0 0.65rem;
    white-space: pre;
  }

  .diff-line.removed {
    background: rgb(209 52 56 / 16%);
  }

  .diff-line.added {
    background: rgb(46 160 67 / 16%);
  }

  .gutter {
    width: 2.4ch;
    flex-shrink: 0;
    text-align: right;
    color: var(--text-dim, #7b8494);
    user-select: none;
  }

  .sign {
    width: 1ch;
    flex-shrink: 0;
    user-select: none;
  }

  .diff-line.removed .sign {
    color: var(--diff-removed, #ff8b8b);
  }

  .diff-line.added .sign {
    color: var(--diff-added, #7ee2a8);
  }

  .code {
    flex: 1;
    min-width: 0;
  }
</style>
