<script lang="ts">
  export interface MenuItem {
    id: string;
    label: string;
    disabled?: boolean;
    danger?: boolean;
    hint?: string;
  }

  let {
    x,
    y,
    items,
    onSelect,
    onClose,
  }: {
    x: number;
    y: number;
    items: MenuItem[];
    onSelect: (id: string) => void;
    onClose: () => void;
  } = $props();

  let menuEl = $state<HTMLDivElement | null>(null);
  let left = $state(0);
  let top = $state(0);

  const selectable = $derived(items.filter((item) => !item.disabled));

  $effect(() => {
    if (!menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    const first = menuEl.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
  });

  $effect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menuEl && event.target instanceof Node && menuEl.contains(event.target)) return;
      onClose();
    };
    const onWindowChange = () => onClose();
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onWindowChange);
    window.addEventListener('resize', onWindowChange);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onWindowChange);
      window.removeEventListener('resize', onWindowChange);
    };
  });

  function focusStep(delta: number): void {
    if (!menuEl || selectable.length === 0) return;
    const buttons = Array.from(
      menuEl.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    );
    const current = buttons.findIndex((button) => button === document.activeElement);
    const next = (current + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusStep(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusStep(-1);
    }
  }

  function choose(item: MenuItem): void {
    if (item.disabled) return;
    onSelect(item.id);
  }
</script>

<div
  bind:this={menuEl}
  class="context-menu"
  role="menu"
  tabindex="-1"
  aria-label="Dosya işlemleri"
  style:left="{left}px"
  style:top="{top}px"
  onkeydown={onKeyDown}
>
  {#each items as item (item.id)}
    <button
      type="button"
      role="menuitem"
      class:danger={item.danger}
      disabled={item.disabled}
      onclick={() => choose(item)}
    >
      <span class="label">{item.label}</span>
      {#if item.hint}
        <kbd>{item.hint}</kbd>
      {/if}
    </button>
  {/each}
</div>

<style>
  .context-menu {
    position: fixed;
    z-index: 1000;
    min-width: 13rem;
    padding: 0.3rem;
    display: flex;
    flex-direction: column;
    background: var(--surface-raised, #1f2430);
    border: 1px solid var(--border, #333a49);
    border-radius: 8px;
    box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
  }

  button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    width: 100%;
    padding: 0.4rem 0.65rem;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text, #e7eaf0);
    font: inherit;
    font-size: 0.85rem;
    text-align: left;
    cursor: default;
  }

  button:hover:not(:disabled),
  button:focus-visible {
    background: var(--surface-hover, #2c3444);
    outline: none;
  }

  button.danger {
    color: var(--danger, #ff7b72);
  }

  button:disabled {
    color: var(--text-muted, #7d8595);
    cursor: default;
  }

  kbd {
    color: var(--text-muted, #7d8595);
    font: inherit;
    font-size: 0.7rem;
  }
</style>
