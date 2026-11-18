<script lang="ts">
  /**
   * Üç seçenekli kapanış onayı.
   *
   * Kirli sekme varken gösterilir: "Kaydet ve Kapat", "Kaydetmeden Kapat" ve
   * "Vazgeç". Odak güvenli seçenektedir; Escape kapatmayı iptal eder.
   * İşlem sürerken tüm düğmeler kilitlenir (çift yazma/kapama engellenir).
   */
  let {
    titles,
    busy = false,
    onSaveAndClose,
    onCloseWithoutSaving,
    onCancel,
  }: {
    titles: string[];
    busy?: boolean;
    onSaveAndClose: () => Promise<void> | void;
    onCloseWithoutSaving: () => Promise<void> | void;
    onCancel: () => void;
  } = $props();

  let primaryEl = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    primaryEl?.focus();
  });

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onCancel();
    }
  }
</script>

<div
  class="backdrop"
  role="presentation"
  onpointerdown={(e) => e.target === e.currentTarget && !busy && onCancel()}
>
  <div
    class="dialog"
    role="alertdialog"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="close-confirm-title"
    aria-describedby="close-confirm-message"
    onkeydown={onKeyDown}
  >
    <h2 id="close-confirm-title">Kaydedilmemiş değişiklikler</h2>
    <p id="close-confirm-message">
      {#if titles.length === 1}
        “{titles[0]}” dosyasında kaydedilmemiş değişiklik var. Kapatmadan önce
        kaydetmek ister misiniz?
      {:else}
        {titles.length} dosyada kaydedilmemiş değişiklik var. Kapatmadan önce
        hepsini kaydetmek ister misiniz?
      {/if}
    </p>
    {#if titles.length > 1}
      <ul>
        {#each titles as title}
          <li>{title}</li>
        {/each}
      </ul>
    {/if}
    <div class="actions">
      <button type="button" class="secondary" onclick={onCancel} disabled={busy}>Vazgeç</button>
      <button type="button" class="danger" onclick={onCloseWithoutSaving} disabled={busy}>
        Kaydetmeden Kapat
      </button>
      <button
        bind:this={primaryEl}
        type="button"
        class="primary"
        onclick={onSaveAndClose}
        disabled={busy}
      >
        {busy ? 'Kaydediliyor…' : 'Kaydet ve Kapat'}
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1200;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 55%);
  }

  .dialog {
    width: min(30rem, calc(100vw - 2rem));
    padding: 1.15rem 1.25rem 1rem;
    border-radius: 10px;
    background: var(--surface-raised, #1f2430);
    border: 1px solid var(--border, #333a49);
    box-shadow: 0 24px 60px rgb(0 0 0 / 50%);
  }

  h2 {
    margin: 0 0 0.6rem;
    font-size: 0.98rem;
    font-weight: 600;
  }

  p {
    margin: 0;
    font-size: 0.84rem;
    line-height: 1.5;
    color: var(--text-muted, #b3bac7);
  }

  ul {
    max-height: 9rem;
    margin: 0.65rem 0 0;
    padding-left: 1.1rem;
    overflow-y: auto;
    color: var(--text-muted, #b3bac7);
    font-size: 0.8rem;
    line-height: 1.5;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1.1rem;
  }

  button {
    padding: 0.42rem 0.9rem;
    border-radius: 6px;
    border: 1px solid transparent;
    font: inherit;
    font-size: 0.82rem;
    cursor: pointer;
  }

  button:focus-visible {
    outline: 2px solid var(--accent, #3b82f6);
    outline-offset: 2px;
  }

  .secondary {
    background: transparent;
    border-color: var(--border, #3a4354);
    color: var(--text, #e7eaf0);
  }

  .primary {
    background: var(--accent, #3b82f6);
    color: #fff;
  }

  .danger {
    background: transparent;
    border-color: var(--danger, #d13438);
    color: var(--danger, #d13438);
  }

  button:disabled {
    opacity: 0.55;
    cursor: default;
  }
</style>
