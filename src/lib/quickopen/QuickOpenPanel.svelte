<script lang="ts">
  /**
   * Ctrl+P hızlı geçiş paneli.
   *
   * Panel her açılışta `fs_index` üzerinden çalışma alanı indeksini tazeler ve
   * yalnızca dosyaları listeler. Sorgu [`rankFiles`] ile bulanık eşleştirilir;
   * son kullanılan dosyalar [`recentFiles`] üzerinden öne alınır. Klavye:
   * Ok tuşları seçim, Enter aç, Escape kapat. Seçim `aria-activedescendant`
   * ile girişe bağlanır; odak giriş alanında kalır.
   */
  import { tick } from 'svelte';

  import type { IndexEntry } from '../ipc/types';
  import { describeFsError, indexWorkspace } from '../tree/ipc';
  import { tabs } from '../tree/tabsStore.svelte';
  import { toast } from '../tree/toast.svelte';
  import { highlightSegments } from './fuzzy';
  import { rankFiles, type RankedFile } from './rank';
  import { recentFiles } from './recent.svelte';

  let { open, onClose }: { open: boolean; onClose: () => void } = $props();

  const LIST_ID = 'quick-open-list';

  let files = $state<IndexEntry[]>([]);
  let query = $state('');
  let selectedIndex = $state(0);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  /** Dizin taraması sınıra takıldıysa sonuçlar eksik olabilir. */
  let truncated = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLUListElement | null>(null);
  let loadToken = 0;
  let wasOpen = false;
  /** Panel açılmadan önce odaklı öğe; kapanınca odağı geri alır. */
  let returnFocusTo: HTMLElement | null = null;

  const results = $derived(rankFiles(files, query, recentFiles.list));

  function optionId(index: number): string {
    return `quick-open-option-${index}`;
  }

  function select(index: number): void {
    selectedIndex = index;
  }

  function move(delta: number): void {
    const count = results.length;
    if (count === 0) return;
    selectedIndex = (selectedIndex + delta + count) % count;
  }

  function choose(item: RankedFile<IndexEntry> | undefined): void {
    if (item === undefined) return;
    recentFiles.record(item.entry.relativePath);
    tabs.open(item.entry.relativePath);
    onClose();
  }

  async function load(): Promise<void> {
    const token = ++loadToken;
    loading = true;
    loadError = null;
    truncated = false;
    try {
      const result = await indexWorkspace('');
      if (token !== loadToken) return;
      files = result.entries.filter((entry) => !entry.isDir);
      truncated = result.truncated;
    } catch (error) {
      if (token !== loadToken) return;
      loadError = describeFsError(error);
      toast.error(loadError);
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  function onInputKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(results[selectedIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  // Açılış: sorgu/seçim sıfırlanır, indeks tazelenir ve giriş odaklanır.
  // Kapanış: odak, panel açılmadan önceki öğeye (genellikle editör) döner.
  $effect(() => {
    if (!open) {
      if (wasOpen) {
        const previous = returnFocusTo;
        returnFocusTo = null;
        if (previous !== null && previous.isConnected) previous.focus();
      }
      wasOpen = false;
      return;
    }
    if (wasOpen) return;
    wasOpen = true;
    returnFocusTo =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    recentFiles.hydrate();
    query = '';
    selectedIndex = 0;
    void load();
    void tick().then(() => {
      if (open) inputEl?.focus();
    });
  });

  // Sorgu değişince seçim ilk satıra döner.
  $effect(() => {
    // `query` bağımlılığı; seçim her yeni sorguda başa alınır.
    query;
    selectedIndex = 0;
  });

  // Etkin satır listede görünür kalsın.
  $effect(() => {
    const index = selectedIndex;
    const list = listEl;
    if (list === null) return;
    const element = list.children[index];
    if (element instanceof HTMLElement) element.scrollIntoView({ block: 'nearest' });
  });
</script>

{#if open}
  <div
    class="backdrop"
    role="presentation"
    onpointerdown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}
  >
    <div class="panel" role="dialog" aria-modal="true" aria-label="Hızlı dosya geçişi">
      <input
        bind:this={inputEl}
        bind:value={query}
        class="search"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={LIST_ID}
        aria-autocomplete="list"
        aria-label="Dosya adı ara"
        aria-activedescendant={results.length > 0 ? optionId(selectedIndex) : undefined}
        placeholder="Dosya adı ara…"
        autocomplete="off"
        spellcheck="false"
        onkeydown={onInputKeyDown}
      />

      <div class="results">
        {#if loading && files.length === 0}
          <p class="status">Dizin taranıyor…</p>
        {:else if loadError}
          <p class="status error" role="alert">{loadError}</p>
        {:else if results.length === 0}
          <p class="status">
            {query.trim().length === 0
              ? 'Çalışma alanında dosya bulunamadı.'
              : 'Eşleşen dosya yok.'}
          </p>
        {:else}
          <ul id={LIST_ID} class="list" role="listbox" aria-label="Dosya sonuçları" bind:this={listEl}>
            {#each results as item, index (item.entry.relativePath)}
              <li
                id={optionId(index)}
                class="option"
                class:active={index === selectedIndex}
                role="option"
                aria-selected={index === selectedIndex}
                onmousedown={(event) => {
                  event.preventDefault();
                  choose(item);
                }}
                onmouseenter={() => select(index)}
              >
                <span class="name">{item.entry.name}</span>
                <span class="path">
                  {#each highlightSegments(item.entry.relativePath, item.indices) as segment, segmentIndex (segmentIndex)}<span
                      class:match={segment.matched}>{segment.text}</span
                    >{/each}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if truncated && !loadError}
          <p class="status truncation" role="status">
            Dizin taraması sınıra takıldı; bazı dosyalar listede olmayabilir.
          </p>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1050;
    display: grid;
    place-items: start center;
    padding-top: 12vh;
    background: rgb(0 0 0 / 45%);
  }

  .panel {
    display: flex;
    flex-direction: column;
    width: min(38rem, calc(100vw - 2rem));
    max-height: 60vh;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface-raised, #2d2d30);
    box-shadow: 0 24px 60px rgb(0 0 0 / 50%);
  }

  .search {
    flex: 0 0 auto;
    width: 100%;
    padding: 0.7rem 0.9rem;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 0.9rem;
    outline: none;
  }

  .search:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .results {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }

  .list {
    margin: 0;
    padding: 0.25rem;
    list-style: none;
  }

  .option {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.4rem 0.55rem;
    border-radius: 6px;
    color: var(--text);
    cursor: pointer;
  }

  .option.active {
    background: var(--selection);
  }

  .name {
    overflow: hidden;
    font-size: 0.84rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .path {
    overflow: hidden;
    color: var(--text-dim);
    font-size: 0.72rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .match {
    color: var(--accent);
    font-weight: 700;
  }

  .status {
    margin: 0;
    padding: 1rem 0.9rem;
    color: var(--text-dim);
    font-size: 0.8rem;
  }

  .status.error {
    color: var(--danger);
  }

  /* Eksik indeks uyarısı listenin altında ince bir şerit olarak durur. */
  .status.truncation {
    padding: 0.45rem 0.9rem;
    border-top: 1px solid var(--border);
    font-size: 0.72rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    .panel {
      animation: quick-open-in 120ms ease-out;
    }
  }

  @keyframes quick-open-in {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
