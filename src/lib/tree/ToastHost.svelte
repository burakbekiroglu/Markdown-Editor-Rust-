<script lang="ts">
  import { toast } from './toast.svelte';
</script>

<div class="toast-host" aria-live="polite" aria-atomic="false">
  {#each toast.items as item (item.id)}
    <div class="toast {item.kind}" role={item.kind === 'error' ? 'alert' : 'status'}>
      <span>{item.message}</span>
      <button type="button" aria-label="Bildirimi kapat" onclick={() => toast.dismiss(item.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .toast-host {
    position: fixed;
    right: 0.9rem;
    bottom: 0.9rem;
    z-index: 1200;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-width: min(24rem, calc(100vw - 1.8rem));
  }

  .toast {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.55rem 0.65rem 0.55rem 0.8rem;
    border-radius: 7px;
    border: 1px solid var(--border, #333a49);
    background: var(--surface-raised, #1f2430);
    color: var(--text, #e7eaf0);
    font-size: 0.8rem;
    line-height: 1.4;
    box-shadow: 0 8px 24px rgb(0 0 0 / 40%);
  }

  .toast.error {
    border-color: var(--danger, #d13438);
  }

  .toast.success {
    border-color: var(--accent, #3b82f6);
  }

  .toast span {
    flex: 1;
  }

  button {
    border: 0;
    background: transparent;
    color: var(--text-muted, #9aa3b2);
    font: inherit;
    font-size: 0.95rem;
    line-height: 1;
    cursor: pointer;
  }
</style>
