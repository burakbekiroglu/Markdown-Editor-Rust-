<script lang="ts">
  import { normalizeEntryName } from './nameValidation';

  export type EntryDialogKind = 'file' | 'folder' | 'rename';

  let {
    title,
    kind,
    initialValue = '',
    submitLabel,
    isDir = false,
    onSubmit,
    onCancel,
  }: {
    title: string;
    kind: EntryDialogKind;
    initialValue?: string;
    submitLabel: string;
    isDir?: boolean;
    onSubmit: (name: string) => Promise<string | null> | string | null;
    onCancel: () => void;
  } = $props();

  let value = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);
  let initialized = false;

  const folderName = $derived(kind === 'folder' || (kind === 'rename' && isDir));
  const validation = $derived(normalizeEntryName(value, folderName));

  const hint = $derived.by(() => {
    if (folderName) return '';
    const result = normalizeEntryName(value, false);
    return result.ok && result.name !== value.trim() ? `Kaydedilecek ad: ${result.name}` : '';
  });

  $effect(() => {
    if (!initialized) {
      initialized = true;
      value = initialValue;
    }
    inputEl?.focus();
    inputEl?.select();
  });

  async function submit(event: SubmitEvent | Event): Promise<void> {
    event.preventDefault();
    if (busy) return;

    const validation = normalizeEntryName(value, folderName);
    if (!validation.ok) {
      error = validation.reason;
      return;
    }

    busy = true;
    error = null;
    try {
      const message = await onSubmit(validation.name);
      if (typeof message === 'string' && message.length > 0) error = message;
    } finally {
      busy = false;
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) onCancel();
    }
  }
</script>

<div class="backdrop" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="entry-dialog-title">
    <h2 id="entry-dialog-title">{title}</h2>
    <form onsubmit={submit}>
      <label for="entry-name">Ad</label>
      <input
        id="entry-name"
        bind:this={inputEl}
        bind:value
        type="text"
        autocomplete="off"
        spellcheck="false"
        aria-invalid={error !== null}
        aria-describedby={error !== null ? 'entry-error' : undefined}
        onkeydown={onKeyDown}
        disabled={busy}
      />
      {#if hint}
        <p class="hint">{hint}</p>
      {/if}
      {#if error}
        <p class="error" id="entry-error" role="alert">{error}</p>
      {/if}
      <div class="actions">
        <button type="button" class="secondary" onclick={onCancel} disabled={busy}>Vazgeç</button>
        <button type="submit" class="primary" disabled={busy || !validation.ok}>
          {busy ? 'İşleniyor…' : submitLabel}
        </button>
      </div>
    </form>
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
    width: min(26rem, calc(100vw - 2rem));
    padding: 1.15rem 1.25rem 1rem;
    border-radius: 10px;
    background: var(--surface-raised, #1f2430);
    border: 1px solid var(--border, #333a49);
    box-shadow: 0 24px 60px rgb(0 0 0 / 50%);
  }

  h2 {
    margin: 0 0 0.9rem;
    font-size: 0.98rem;
    font-weight: 600;
  }

  label {
    display: block;
    margin-bottom: 0.35rem;
    font-size: 0.78rem;
    color: var(--text-muted, #9aa3b2);
  }

  input {
    width: 100%;
    padding: 0.48rem 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--border, #3a4354);
    background: var(--surface, #161a22);
    color: var(--text, #e7eaf0);
    font: inherit;
    font-size: 0.86rem;
  }

  input:focus-visible {
    outline: 2px solid var(--accent, #5aa9ff);
    outline-offset: 1px;
  }

  .hint,
  .error {
    margin: 0.45rem 0 0;
    font-size: 0.76rem;
  }

  .hint {
    color: var(--text-muted, #9aa3b2);
  }

  .error {
    color: var(--danger, #ff7b72);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
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

  button:disabled {
    opacity: 0.55;
    cursor: default;
  }
</style>
