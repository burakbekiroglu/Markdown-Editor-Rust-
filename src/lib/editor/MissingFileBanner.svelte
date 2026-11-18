<script lang="ts">
  /**
   * "Eksik dosya" bandı.
   *
   * Dosya uygulama dışında silinmiş veya taşınmışsa sekme kapanmaz: editör
   * salt-okunur olur ve bu bant üç yol sunar:
   * - kullanıcı bellekten "Kaydet" ile dosyayı aynı yolda yeniden oluşturur,
   * - ya da çalışma köküne göreli yeni bir yol yazarak sekmeyi yeniden bağlar,
   * - ya da sekmeyi kapatır (kaydedilmemiş içerik varsa önce onay istenir).
   *
   * Bant kullanıcı karar verene kadar kaldırılmaz; editördeki kirli içerik
   * bellekte korunur.
   */
  import ConfirmDialog from '../tree/ConfirmDialog.svelte';

  let {
    title,
    path,
    dirty,
    onRelocate,
    onSave,
    onClose,
  }: {
    title: string;
    path: string;
    dirty: boolean;
    /** Yeni yolu doğrulayıp sekmeyi bağlar; hata mesajı dönerse bant açık kalır. */
    onRelocate: (newPath: string) => Promise<string | null>;
    /** Bellekteki içeriği aynı yolda yazar; hata mesajı dönerse bant açık kalır. */
    onSave: () => Promise<string | null>;
    onClose: () => void;
  } = $props();

  let value = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let confirming = $state(false);
  let initialized = false;

  $effect(() => {
    if (initialized) return;
    initialized = true;
    value = path;
  });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const next = value.trim().replace(/\\/g, '/');
    if (next.length === 0) {
      error = 'Dosya yolu boş olamaz.';
      return;
    }
    busy = true;
    error = null;
    try {
      error = await onRelocate(next);
    } finally {
      busy = false;
    }
  }

  /** Aynı yolda yeniden oluşturur; kirli içerik bellekten yazılır. */
  async function save(): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      error = await onSave();
    } finally {
      busy = false;
    }
  }

  function requestClose(): void {
    if (dirty) {
      confirming = true;
      return;
    }
    onClose();
  }

  function confirmClose(): void {
    confirming = false;
    onClose();
  }
</script>

<section class="missing" role="alert" aria-label="Eksik dosya">
  <div class="bar">
    <span class="mark" aria-hidden="true">⚠</span>
    <div class="text">
      <strong>{title}</strong>
      <span>
        dosyası bulunamadı ({path}). İçerik korunuyor; düzenleme salt okunur.
      </span>
    </div>
    <button type="button" class="primary" onclick={save} disabled={busy}>
      {busy ? 'Kaydediliyor…' : 'Kaydet'}
    </button>
    <form class="relocate" onsubmit={submit}>
      <label class="sr-only" for="relocate-path">Yeni dosya yolu</label>
      <input
        id="relocate-path"
        type="text"
        bind:value
        placeholder="yeni/yol/dosya.md"
        autocomplete="off"
        spellcheck="false"
        aria-invalid={error !== null}
        aria-describedby={error !== null ? 'missing-error' : undefined}
        disabled={busy}
      />
      <button type="submit" disabled={busy}>Yeniden konumlandır</button>
    </form>
    <button type="button" class="close" onclick={requestClose} disabled={busy}>
      Sekmeyi Kapat
    </button>
  </div>
  {#if error}
    <p class="error" id="missing-error" role="alert">{error}</p>
  {/if}
</section>

{#if confirming}
  <ConfirmDialog
    title="Kaydedilmemiş değişiklikler"
    message={`"${title}" sekmesinde kaydedilmemiş değişiklikler var. Kapatırsanız bu değişiklikler kaybolur.`}
    confirmLabel="Kaydetmeden kapat"
    danger={true}
    onConfirm={confirmClose}
    onCancel={() => (confirming = false)}
  />
{/if}

<style>
  .missing {
    flex: 0 0 auto;
    border-bottom: 1px solid var(--border);
    background: var(--warning-bg, #3a2f14);
    color: var(--warning-text, #f2d58a);
    font-size: 0.78rem;
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    padding: 0.4rem 0.75rem;
  }

  .mark {
    flex: 0 0 auto;
  }

  .text {
    flex: 1 1 14rem;
    min-width: 0;
    display: flex;
    gap: 0.35rem;
    overflow: hidden;
  }

  .text strong {
    flex: 0 0 auto;
    font-weight: 600;
  }

  .text span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.9;
  }

  .relocate {
    display: flex;
    flex: 0 0 auto;
    gap: 0.35rem;
  }

  input {
    width: 12rem;
    padding: 0.22rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 0.76rem;
  }

  input:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  button {
    padding: 0.22rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.76rem;
    cursor: pointer;
  }

  .primary {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
  }

  .close:hover {
    background: var(--bg-hover, #262e3c);
  }

  button:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .error {
    margin: 0;
    padding: 0 0.75rem 0.4rem;
    color: var(--danger, #ff7b72);
    font-size: 0.74rem;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>
