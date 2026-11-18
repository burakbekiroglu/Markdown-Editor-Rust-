<script lang="ts">
  import type { EntryInfo } from './ipc';
  import Self from './Tree.svelte';

  import { parentOf } from './paths';

  /** Sürükle-bırak taşıma davranışı; durum `FileTree` içinde tutulur. */
  export interface TreeDragHandlers {
    /** Vurgulanan hedef klasörün göreli yolu (kök için `''`). */
    dropTargetPath: string | null;
    onDragStart: (event: DragEvent, entry: EntryInfo) => void;
    onDragOver: (event: DragEvent, entry: EntryInfo) => void;
    onDragLeave: (event: DragEvent, entry: EntryInfo) => void;
    onDragEnd: () => void;
    onDrop: (event: DragEvent, entry: EntryInfo) => void;
  }

  let {
    entries,
    depth = 0,
    expanded,
    selectedPath,
    activePath = null,
    renamingPath,
    getChildren,
    getEntry,
    onOpenFile,
    onToggle,
    onSelect,
    onContextMenu,
    onRenameSubmit,
    onRenameCancel,
    onRenameStart,
    onDeleteRequest,
    drag = null,
  }: {
    entries: EntryInfo[];
    depth?: number;
    expanded: Record<string, boolean>;
    selectedPath: string | null;
    activePath?: string | null;
    renamingPath: string | null;
    getChildren: (rel: string) => EntryInfo[];
    getEntry: (rel: string) => EntryInfo | null;
    onOpenFile: (entry: EntryInfo) => void;
    onToggle: (entry: EntryInfo) => void;
    onSelect: (entry: EntryInfo) => void;
    onContextMenu: (event: MouseEvent, entry: EntryInfo) => void;
    onRenameSubmit: (entry: EntryInfo, name: string) => Promise<string | null>;
    onRenameCancel: () => void;
    onRenameStart: (entry: EntryInfo) => void;
    onDeleteRequest: (entry: EntryInfo) => void;
    drag?: TreeDragHandlers | null;
  } = $props();

  function focusRenameInput(node: HTMLInputElement): void {
    node.focus();
    node.select();
  }

  /** Roving tabindex: ağaç tek Tab durağı olur, odak seçili satırda başlar. */
  function tabIndexFor(entry: EntryInfo, index: number): number {
    if (selectedPath !== null) return selectedPath === entry.relativePath ? 0 : -1;
    return depth === 0 && index === 0 ? 0 : -1;
  }

  function focusRow(row: HTMLElement | null | undefined): void {
    if (!row) return;
    row.focus();
    row.scrollIntoView?.({ block: 'nearest' });
    const path = row.dataset.path;
    if (path !== undefined) {
      const entry = getEntry(path);
      if (entry !== null) onSelect(entry);
    }
  }

  /**
   * Klavye gezinmesi. Görünür satırlar `role="tree"` kapsayıcısından tek DOM
   * sorgusuyla bulunur; odak seçimle birlikte taşınır.
   */
  function onRowKeyDown(event: KeyboardEvent, entry: EntryInfo): void {
    if (renamingPath !== null) return;
    const current = event.currentTarget as HTMLElement;
    const tree = current.closest<HTMLElement>('[role="tree"]');
    if (tree === null) return;
    const rows = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const index = rows.indexOf(current);
    if (index === -1) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(rows[index + 1]);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(rows[index - 1]);
        break;
      case 'Home':
        event.preventDefault();
        focusRow(rows[0]);
        break;
      case 'End':
        event.preventDefault();
        focusRow(rows[rows.length - 1]);
        break;
      case 'ArrowRight':
        if (entry.isDir && expanded[entry.relativePath] !== true) {
          event.preventDefault();
          onToggle(entry);
        } else if (rows[index + 1] !== undefined) {
          event.preventDefault();
          focusRow(rows[index + 1]);
        }
        break;
      case 'ArrowLeft':
        if (entry.isDir && expanded[entry.relativePath] === true) {
          event.preventDefault();
          onToggle(entry);
        } else {
          event.preventDefault();
          const parentPath = parentOf(entry.relativePath);
          focusRow(rows.find((row) => row.dataset.path === parentPath));
        }
        break;
      case 'Enter':
        event.preventDefault();
        onSelect(entry);
        if (entry.isDir) onToggle(entry);
        else onOpenFile(entry);
        break;
      case 'F2':
        event.preventDefault();
        onRenameStart(entry);
        break;
      case 'Delete':
        event.preventDefault();
        onDeleteRequest(entry);
        break;
    }
  }
</script>

<ul role="group" class="tree-group">
  {#each entries as entry, index (entry.relativePath)}
    {@const isExpanded = expanded[entry.relativePath] === true}
    {@const renaming = renamingPath === entry.relativePath}
    {@const isActive = activePath === entry.relativePath}
    <li role="none">
      {#if renaming}
        <form
          class="row renaming"
          style:padding-left="{depth * 0.85 + 0.4}rem"
          onsubmit={(event) => {
            event.preventDefault();
            const input = event.currentTarget.querySelector('input');
            if (input) void onRenameSubmit(entry, input.value);
          }}
        >
          <input
            type="text"
            value={entry.name}
            use:focusRenameInput
            aria-label="Yeni ad"
            autocomplete="off"
            spellcheck="false"
            onkeydown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onRenameCancel();
              }
            }}
          />
        </form>
      {:else}
        <div
          class="row"
          class:selected={selectedPath === entry.relativePath}
          class:active={isActive}
          class:drop-target={drag !== null && drag.dropTargetPath === entry.relativePath}
          style:padding-left="{depth * 0.85 + 0.2}rem"
          role="treeitem"
          tabindex={tabIndexFor(entry, index)}
          data-path={entry.relativePath}
          draggable="true"
          aria-selected={selectedPath === entry.relativePath}
          aria-current={isActive ? 'true' : undefined}
          aria-expanded={entry.isDir ? isExpanded : undefined}
          aria-level={depth + 1}
          ondragstart={(event) => drag?.onDragStart(event, entry)}
          ondragover={(event) => drag?.onDragOver(event, entry)}
          ondragleave={(event) => drag?.onDragLeave(event, entry)}
          ondragend={() => drag?.onDragEnd()}
          ondrop={(event) => drag?.onDrop(event, entry)}
          onclick={() => {
            onSelect(entry);
            if (entry.isDir) onToggle(entry);
            else onOpenFile(entry);
          }}
          oncontextmenu={(event) => {
            event.preventDefault();
            onSelect(entry);
            onContextMenu(event, entry);
          }}
          onkeydown={(event) => onRowKeyDown(event, entry)}
        >
          <span class="icon" aria-hidden="true">
            {#if entry.isDir}
              {isExpanded ? '▾' : '▸'}
            {:else}
              •
            {/if}
          </span>
          <span class="name" title={entry.relativePath}>{entry.name}</span>
        </div>
      {/if}

      {#if entry.isDir && isExpanded}
        <Self
          entries={getChildren(entry.relativePath)}
          depth={depth + 1}
          {expanded}
          {selectedPath}
          {activePath}
          {renamingPath}
          {getChildren}
          {getEntry}
          {onOpenFile}
          {onToggle}
          {onSelect}
          {onContextMenu}
          {onRenameSubmit}
          {onRenameCancel}
          {onRenameStart}
          {onDeleteRequest}
          {drag}
        />
      {/if}
    </li>
  {/each}
</ul>

<style>
  .tree-group {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
    padding: 0.24rem 0.4rem;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.83rem;
    text-align: left;
    cursor: default;
    user-select: none;
  }

  .row:hover,
  .row:focus-visible {
    background: var(--surface-hover, #262e3c);
    outline: none;
  }

  .row.selected {
    background: var(--selection, #2b3b55);
  }

  /* Sürükleme sırasında geçerli hedef klasör. */
  .row.drop-target {
    background: var(--surface-hover, #262e3c);
    box-shadow: inset 0 0 0 1px var(--accent, #5aa9ff);
  }

  /* Açık sekmenin dosyası: seçimden bağımsız olarak vurgulanır. */
  .row.active {
    box-shadow: inset 2px 0 0 var(--accent, #5aa9ff);
    font-weight: 600;
  }

  .icon {
    width: 0.9rem;
    color: var(--text-muted, #8b93a3);
    font-size: 0.7rem;
    text-align: center;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .renaming {
    padding-top: 0.1rem;
    padding-bottom: 0.1rem;
  }

  .renaming input {
    width: 100%;
    padding: 0.2rem 0.35rem;
    border-radius: 4px;
    border: 1px solid var(--accent, #5aa9ff);
    background: var(--surface, #141821);
    color: var(--text, #e7eaf0);
    font: inherit;
    font-size: 0.82rem;
  }
</style>
