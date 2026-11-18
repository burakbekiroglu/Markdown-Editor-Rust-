<script lang="ts">
  /**
   * Görünüm modu seçici (Editör / Bölünmüş / Önizleme).
   *
   * Sekmelerin üstünde durur ama durumu sekmeye bağlı değildir: mod global
   * `viewMode` deposundadır. `radiogroup` sözleşmesi gereği oklar, Home/End
   * seçimi değiştirir ve odağı taşır; tek durak noktası etkin seçenektir.
   */
  import { VIEW_MODES, viewMode, type ViewMode } from './viewMode.svelte';

  const LABELS: Record<ViewMode, string> = {
    editor: 'Editör',
    split: 'Bölünmüş',
    preview: 'Önizleme',
  };

  const TITLES: Record<ViewMode, string> = {
    editor: 'Yalnızca editör',
    split: 'Editör ve önizleme yan yana',
    preview: 'Yalnızca önizleme',
  };

  let group = $state<HTMLDivElement | null>(null);

  function select(mode: ViewMode): void {
    viewMode.setMode(mode);
  }

  function onKeyDown(event: KeyboardEvent, index: number): void {
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % VIEW_MODES.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + VIEW_MODES.length) % VIEW_MODES.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = VIEW_MODES.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = VIEW_MODES[next];
    select(target);
    group?.querySelector<HTMLElement>(`[data-mode="${target}"]`)?.focus();
  }
</script>

<div class="view-toggle" role="radiogroup" aria-label="Görünüm modu" bind:this={group}>
  {#each VIEW_MODES as mode, index (mode)}
    <button
      type="button"
      role="radio"
      aria-checked={viewMode.mode === mode}
      data-mode={mode}
      title={TITLES[mode]}
      tabindex={viewMode.mode === mode ? 0 : -1}
      class:active={viewMode.mode === mode}
      onclick={() => select(mode)}
      onkeydown={(event) => onKeyDown(event, index)}
    >
      {LABELS[mode]}
    </button>
  {/each}
</div>

<style>
  .view-toggle {
    display: inline-flex;
    align-items: stretch;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  button {
    padding: 0.18rem 0.6rem;
    border: 0;
    border-right: 1px solid var(--border);
    background: transparent;
    color: var(--text-dim);
    font: inherit;
    font-size: 0.72rem;
    line-height: 1.5;
    cursor: pointer;
  }

  button:last-child {
    border-right: 0;
  }

  button:hover:not(.active) {
    background: var(--bg-hover, #262e3c);
    color: var(--text);
  }

  button.active {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    color: var(--text);
  }

  button:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -2px;
  }
</style>
