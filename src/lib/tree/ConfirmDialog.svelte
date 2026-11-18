<script lang="ts">
  let {
    title,
    message,
    confirmLabel,
    danger = false,
    onConfirm,
    onCancel,
  }: {
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => Promise<void> | void;
    onCancel: () => void;
  } = $props();

  let busy = $state(false);
  let confirmEl = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    confirmEl?.focus();
  });

  async function confirm(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await onConfirm();
    } finally {
      busy = false;
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onCancel();
    }
  }
</script>

<div class="backdrop" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
  <div class="dialog" role="alertdialog" tabindex="-1" aria-modal="true" aria-labelledby="confirm-title" onkeydown={onKeyDown}>
    <h2 id="confirm-title">{title}</h2>
    <p>{message}</p>
    <div class="actions">
      <button type="button" class="secondary" onclick={onCancel} disabled={busy}>Vazgeç</button>
      <button
        bind:this={confirmEl}
        type="button"
        class={danger ? 'danger' : 'primary'}
        onclick={confirm}
        disabled={busy}
      >
        {busy ? 'İşleniyor…' : confirmLabel}
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1100;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 55%);
  }

  .dialog {
    width: min(27rem, calc(100vw - 2rem));
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

  .actions {
    display: flex;
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
    background: var(--danger, #d13438);
    color: #fff;
  }

  button:disabled {
    opacity: 0.55;
    cursor: default;
  }
</style>
