<script lang="ts">
  /**
   * Açık sekmelerin çubuğu.
   *
   * - Sekme sırası store'daki dizi sırasıdır; etkinleştirme sırayı değiştirmez.
   * - Orta tık ve Ctrl+W sekmeyi kapatır; dirty sekmede önce onay istenir.
   * - Çok sayıda sekmede çubuk yatay kaydırılır (tekerlek yataya çevrilir).
   */
  import { onMount } from 'svelte';
  import { commands } from '../app/shortcuts';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { tabs } from './tabsStore.svelte';

  let closeTarget = $state<string | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);

  const dirtyTarget = $derived(tabs.tabs.find((tab) => tab.id === closeTarget) ?? null);

  function requestClose(id: string): void {
    const tab = tabs.tabs.find((item) => item.id === id);
    if (!tab) return;
    if (tab.dirty) {
      closeTarget = id;
      return;
    }
    tabs.close(id);
  }

  function confirmClose(): void {
    if (closeTarget === null) return;
    tabs.close(closeTarget);
    closeTarget = null;
  }

  /** Orta tık: Chromium'da otomatik kaydırmayı engelle ve sekmeyi kapat. */
  function onTabMouseDown(event: MouseEvent, id: string): void {
    if (event.button !== 1) return;
    event.preventDefault();
    requestClose(id);
  }

  function focusTab(id: string): void {
    const el = listEl?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`);
    el?.focus();
  }

  function moveActive(step: 1 | -1): void {
    const list = tabs.tabs;
    if (list.length === 0) return;
    const current = list.findIndex((tab) => tab.id === tabs.activeId);
    const from = current === -1 ? 0 : current;
    const next = list[(from + step + list.length) % list.length];
    tabs.activate(next.id);
    focusTab(next.id);
  }

  function selectEdge(edge: 'first' | 'last'): void {
    const list = tabs.tabs;
    if (list.length === 0) return;
    const next = edge === 'first' ? list[0] : list[list.length - 1];
    tabs.activate(next.id);
    focusTab(next.id);
  }

  function onTabKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        selectEdge('first');
        break;
      case 'End':
        event.preventDefault();
        selectEdge('last');
        break;
      default:
        break;
    }
  }

  /** Dikey tekerlek hareketini yatay kaydırmaya çevirir. */
  function onWheel(event: WheelEvent): void {
    const el = listEl;
    if (el === null) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 0) return;
    const next = Math.min(max, Math.max(0, el.scrollLeft + event.deltaY));
    if (next === el.scrollLeft) return;
    event.preventDefault();
    el.scrollLeft = next;
  }

  onMount(() =>
    commands.register('close-tab', () => {
      // Kısayol merkezi katmandan gelir; açık sekme yoksa tarayıcı
      // varsayılanına bırakmak yerine yutulur (WebView penceresi kapanmasın).
      if (tabs.activeId === null) return false;
      if (closeTarget === null) requestClose(tabs.activeId);
      return true;
    }),
  );

  // Aktif sekme her zaman görünür kalsın (çubuk kaydırılmış olabilir).
  $effect(() => {
    const id = tabs.activeId;
    if (id === null || listEl === null) return;
    listEl
      .querySelector<HTMLElement>(`[data-tab-id="${id}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
</script>

<div class="tabbar" role="tablist" aria-label="Açık dosyalar" bind:this={listEl} onwheel={onWheel}>
  {#each tabs.tabs as tab (tab.id)}
    <div
      class="tab"
      class:active={tab.id === tabs.activeId}
      class:dirty={tab.dirty}
      class:missing={tab.missing}
    >
      <button
        type="button"
        class="tab-button"
        role="tab"
        data-tab-id={tab.id}
        aria-selected={tab.id === tabs.activeId}
        tabindex={tab.id === tabs.activeId ? 0 : -1}
        title={tab.missing ? `${tab.path} (bulunamadı)` : tab.path}
        onclick={() => tabs.activate(tab.id)}
        onkeydown={onTabKeyDown}
        onmousedown={(event) => onTabMouseDown(event, tab.id)}
      >
        <span class="title">{tab.title}</span>
        {#if tab.dirty}
          <span class="dot" aria-label="Kaydedilmemiş değişiklik" title="Kaydedilmemiş değişiklik"
          ></span>
        {/if}
      </button>
      <button
        type="button"
        class="close"
        aria-label={`${tab.title} sekmesini kapat`}
        title="Kapat (Ctrl+W)"
        onclick={() => requestClose(tab.id)}
      >
        ×
      </button>
    </div>
  {/each}
</div>

{#if dirtyTarget}
  <ConfirmDialog
    title="Kaydedilmemiş değişiklikler"
    message={`"${dirtyTarget.title}" sekmesinde kaydedilmemiş değişiklikler var. Kapatırsanız bu değişiklikler kaybolur.`}
    confirmLabel="Kaydetmeden kapat"
    danger={true}
    onConfirm={confirmClose}
    onCancel={() => (closeTarget = null)}
  />
{/if}

<style>
  .tabbar {
    display: flex;
    flex: 0 0 auto;
    align-items: stretch;
    gap: 1px;
    height: 34px;
    overflow-x: auto;
    overflow-y: hidden;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    scrollbar-width: thin;
  }

  .tab {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    max-width: 200px;
    min-width: 90px;
    border-right: 1px solid var(--border);
    color: var(--text-dim);
  }

  .tab.active {
    background: var(--bg);
    color: var(--text);
    box-shadow: inset 0 2px 0 var(--accent);
  }

  .tab-button {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
    height: 100%;
    padding: 0 0.25rem 0 0.7rem;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.78rem;
    text-align: left;
    cursor: pointer;
  }

  .tab-button:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -2px;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab.missing .title {
    text-decoration: line-through;
    opacity: 0.7;
  }

  .dot {
    flex: 0 0 auto;
    width: 0.42rem;
    height: 0.42rem;
    border-radius: 50%;
    background: var(--accent);
  }

  .tab.active .dot {
    background: var(--accent);
  }

  .close {
    flex: 0 0 auto;
    width: 1.3rem;
    height: 1.3rem;
    margin-right: 0.35rem;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.95rem;
    line-height: 1;
    opacity: 0;
    cursor: pointer;
  }

  .tab:hover .close,
  .tab.active .close,
  .close:focus-visible {
    opacity: 0.75;
  }

  .close:hover {
    background: var(--bg-hover, #262e3c);
    opacity: 1;
  }
</style>
