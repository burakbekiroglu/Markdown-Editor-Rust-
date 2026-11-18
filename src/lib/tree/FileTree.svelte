<script lang="ts">
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte';
  import EntryDialog from './EntryDialog.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import Tree from './Tree.svelte';
  import type { EntryInfo } from './ipc';
  import { describeFsError } from './ipc';
  import { AppError, describeAppError } from '../ipc/errors';
  import { parentOf, isSameOrInside } from './paths';
  import { TreeStore } from './treeStore.svelte';
  import { tabs } from './tabsStore.svelte';
  import { toast } from './toast.svelte';
  import type { FsChange } from '../watch/events';
  import { subscribeWorkspaceWatch } from '../watch/watcher';

  let {
    root,
    onFileOpen,
  }: {
    root: string;
    onFileOpen?: (path: string) => void;
  } = $props();

  const store = new TreeStore();
  let selectedPath = $state<string | null>(null);
  /** Açık sekmenin yolu; seçimden ayrı olarak ağaçta vurgulanır. */
  const activePath = $derived(tabs.active?.path ?? null);
  let renamingPath = $state<string | null>(null);
  let menu = $state<{ x: number; y: number; target: EntryInfo | null } | null>(null);
  let createDialog = $state<{ kind: 'file' | 'folder'; parentRel: string } | null>(null);
  let deleteTarget = $state<EntryInfo | null>(null);
  let busy = $state(false);
  /** Ağaç diskten tazelenirken yenile düğmesi devre dışı kalır. */
  let reloading = $state(false);
  /** Sürüklenen öğenin yolu; null iken sürükleme yok. */
  let dragSource = $state<string | null>(null);
  /** Vurgulanan hedef klasör; kök için `''`, hedef yoksa null. */
  let dropTarget = $state<string | null>(null);

  $effect(() => {
    if (root !== store.root) store.attachRoot(root);
  });

  /**
   * Ağaç seçimi aktif sekmeyle senkron kalır: sekme değişince (tıklama,
   * kapatma, yeniden adlandırma/taşıma) o sekmenin satırı seçili olur.
   * Klasör seçimi aktif sekme değişmediği sürece korunur.
   */
  $effect(() => {
    const path = activePath;
    if (path !== null) selectedPath = path;
  });

  // Live workspace watch: external creates/renames/removals refresh only the
  // affected directories, and removed paths mark matching tabs as missing.
  let stopWatch: (() => void) | null = null;
  $effect(() => {
    const watchedRoot = root;
    let active = true;
    stopWatch?.();
    stopWatch = null;
    if (watchedRoot.length === 0) return;

    void subscribeWorkspaceWatch({
      onChange: (changes) => {
        if (!active) return;
        void applyExternalChanges(changes);
      },
      onError: (error) => {
        if (active) toast.error(describeFsError(error));
      },
    })
      .then((stop) => {
        if (active) stopWatch = stop;
        else stop();
      })
      .catch((error: unknown) => {
        // Abonelik kurulamazsa izleyici hiç çalışmıyor demektir; kullanıcı
        // dosyaların kendiliğinden güncellenmesini beklememeli.
        if (active) toast.error(describeFsError(error));
      });

    return () => {
      active = false;
      stopWatch?.();
      stopWatch = null;
    };
  });

  async function applyExternalChanges(changes: FsChange[]): Promise<void> {
    for (const change of changes) {
      if (change.kind === 'remove') tabs.markDeleted(change.path);
    }
    await store.refreshFromChanges(changes);
  }

  function containerOf(target: EntryInfo | null): string {
    if (target === null) return '';
    return target.isDir ? target.relativePath : parentOf(target.relativePath);
  }

  /** Klavye gezinmesi için yol → girdi çözümü (yalnız yüklü klasörlerde). */
  function entryAt(path: string): EntryInfo | null {
    return store.childrenOf(parentOf(path)).find((item) => item.relativePath === path) ?? null;
  }

  const menuItems = $derived.by<MenuItem[]>(() => {
    if (menu === null) return [];
    return [
      { id: 'new-file', label: 'Yeni dosya', hint: 'Ctrl+N' },
      { id: 'new-folder', label: 'Yeni klasör', hint: 'Ctrl+Shift+N' },
      { id: 'rename', label: 'Yeniden adlandır', hint: 'F2', disabled: menu.target === null },
      { id: 'delete', label: 'Sil', hint: 'Del', danger: true, disabled: menu.target === null },
    ];
  });

  function openMenu(event: MouseEvent, target: EntryInfo | null): void {
    menu = { x: event.clientX, y: event.clientY, target };
  }

  function handleMenuSelect(id: string): void {
    const target = menu?.target ?? null;
    const parentRel = containerOf(target);
    menu = null;
    if (id === 'new-file' || id === 'new-folder') {
      createDialog = { kind: id === 'new-file' ? 'file' : 'folder', parentRel };
    } else if (id === 'rename' && target) {
      renamingPath = target.relativePath;
    } else if (id === 'delete' && target) {
      deleteTarget = target;
    }
  }

  /**
   * Sürükle-bırak hedefi geçerli mi?
   *
   * Öğe kendi alt ağacına taşınamaz; zaten bulunduğu klasöre bırakmak da
   * gereksiz bir istek olur.
   */
  function canMoveInto(sourceRel: string, targetDirRel: string): boolean {
    if (isSameOrInside(targetDirRel, sourceRel)) return false;
    return parentOf(sourceRel) !== targetDirRel;
  }

  function handleDragStart(event: DragEvent, entry: EntryInfo): void {
    dragSource = entry.relativePath;
    dropTarget = null;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', entry.relativePath);
    }
  }

  /** Yalnızca klasör satırları hedef olur; dosya üzerine bırakma kabul edilmez. */
  function handleDragOver(event: DragEvent, entry: EntryInfo): void {
    if (!entry.isDir || dragSource === null) return;
    if (!canMoveInto(dragSource, entry.relativePath)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dropTarget = entry.relativePath;
  }

  function handleDragLeave(event: DragEvent, entry: EntryInfo): void {
    const next = event.relatedTarget;
    // Satır içindeki ikon/metin arasında gezerken vurgu düşmesin.
    if (next instanceof Node && event.currentTarget instanceof Node) {
      if (event.currentTarget.contains(next)) return;
    }
    if (dropTarget === entry.relativePath) dropTarget = null;
  }

  function handleDragEnd(): void {
    dragSource = null;
    dropTarget = null;
  }

  function handleDrop(event: DragEvent, entry: EntryInfo): void {
    // Dosya satırına bırakma kabul edilmez; tarayıcı varsayılanı yine de engellenir.
    event.preventDefault();
    if (!entry.isDir) return;
    const sourceRel = dragSource ?? event.dataTransfer?.getData('text/plain') ?? '';
    handleDragEnd();
    if (sourceRel.length === 0) return;
    if (!canMoveInto(sourceRel, entry.relativePath)) {
      if (isSameOrInside(entry.relativePath, sourceRel)) {
        // Yerel doğrulama hatası da tipli modelden geçer: başlık + ayrıntı +
        // eylem cümlesi, ham kod öneki olmadan.
        toast.error(
          describeAppError(new AppError('InvalidPath', 'Bir öğe kendi alt klasörüne taşınamaz.')),
        );
      }
      return;
    }
    void applyMove(sourceRel, entry.relativePath);
  }

  function isOnTreeRow(event: DragEvent): boolean {
    return event.target instanceof Element && event.target.closest('[role="treeitem"]') !== null;
  }

  /** Ağacın boş alanına bırakma, öğeyi kök klasöre taşır. */
  function handleRootDragOver(event: DragEvent): void {
    if (dragSource === null || isOnTreeRow(event)) return;
    if (!canMoveInto(dragSource, '')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dropTarget = '';
  }

  function handleRootDragLeave(event: DragEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget instanceof Node) {
      if (event.currentTarget.contains(next)) return;
    }
    if (dropTarget === '') dropTarget = null;
  }

  function handleRootDrop(event: DragEvent): void {
    if (isOnTreeRow(event)) return;
    event.preventDefault();
    const sourceRel = dragSource ?? event.dataTransfer?.getData('text/plain') ?? '';
    handleDragEnd();
    if (sourceRel.length === 0 || !canMoveInto(sourceRel, '')) return;
    void applyMove(sourceRel, '');
  }

  async function applyMove(sourceRel: string, targetDirRel: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const moved = await store.move(sourceRel, targetDirRel);
      if (moved === null) return;
      // Açık sekmeler taşınan dosya/klasörle birlikte yeni yolu izler.
      const tabResult = tabs.renamePath(sourceRel, moved.relativePath);
      if (!tabResult.ok) toast.error(tabResult.reason ?? 'Sekme güncellenemedi.');
      selectedPath = moved.relativePath;
    } finally {
      busy = false;
    }
  }

  async function toggle(entry: EntryInfo): Promise<void> {
    if (!entry.isDir) return;
    await store.toggle(entry.relativePath);
  }

  function openFile(entry: EntryInfo): void {
    if (entry.isDir) return;
    tabs.open(entry.relativePath);
    onFileOpen?.(entry.relativePath);
  }

  async function submitCreate(name: string): Promise<string | null> {
    if (createDialog === null) return null;
    const { kind, parentRel } = createDialog;
    const created = await store.createEntry(parentRel, kind, name);
    if (created === null) return 'Oluşturulamadı. Adı düzeltip yeniden deneyin.';
    createDialog = null;
    selectedPath = created.relativePath;
    if (created.isDir) {
      await store.toggle(created.relativePath);
    } else {
      openFile(created);
    }
    return null;
  }

  async function submitRename(entry: EntryInfo, rawName: string): Promise<string | null> {
    if (rawName === entry.name) {
      renamingPath = null;
      return null;
    }
    if (rawName.trim() === entry.name) {
      // Yalnızca baş/son boşluk eklenmiş ad geçersizdir; sessizce kapatma.
      toast.error(
        describeAppError(new AppError('InvalidPath', 'Ad başında veya sonunda boşluk olamaz.')),
      );
      return null;
    }
    const renamed = await store.rename(entry.relativePath, rawName);
    if (renamed === null) {
      // Hata toast ile bildirildi; satır içi giriş açık kalır.
      return null;
    }
    const tabResult = tabs.renamePath(entry.relativePath, renamed.relativePath);
    if (!tabResult.ok) toast.error(tabResult.reason ?? 'Sekme güncellenemedi.');
    renamingPath = null;
    selectedPath = renamed.relativePath;
    return null;
  }

  /**
   * Onaylanan silmeyi uygular. Sözleşme: dönen promise her koşulda çözülür
   * (reddetmez) — onay diyaloğu "İşleniyor…" durumunda kilitli kalmaz ve
   * çağıran taraf askıda bir görev bırakmaz. Başarısızlıkta diyalog açık
   * kalır, hata toast ile bildirilir; kullanıcı yeniden deneyebilir veya
   * vazgeçebilir.
   */
  async function confirmDelete(): Promise<void> {
    if (deleteTarget === null) return;
    if (busy) {
      // Kilit paylaşımlı (taşıma da `busy` tutar): sessizce yutmak yerine
      // kullanıcıya neden hiçbir şey olmadığını söyle, diyalogu kapatma.
      toast.info('Başka bir dosya işlemi sürüyor; silmeyi birazdan yeniden deneyin.');
      return;
    }
    const target = deleteTarget;
    busy = true;
    try {
      const removed = await store.remove(target.relativePath);
      if (!removed) return;
      tabs.markDeleted(target.relativePath);
      if (selectedPath === target.relativePath) selectedPath = null;
      deleteTarget = null;
    } catch (error) {
      // `store.remove` kendi hatasını bildirir; buraya yalnız beklenmedik bir
      // hata düşer. Yine de sessizce yutulmaz ve diyalog kilitli kalmaz.
      toast.error(describeFsError(error));
    } finally {
      busy = false;
    }
  }

  /**
   * İptal edilen silme hiçbir dosya sistemi işlemi yapmaz; kullanıcı bunu
   * toast ile görür ki diyaloğun sessizce kapandığı izlenimi oluşmasın.
   */
  function cancelDelete(): void {
    deleteTarget = null;
    toast.info('Silme iptal edildi.');
  }

  /** Ağacı diskten tazeler; başlıktaki "Yenile" düğmesi ve F5 aynı işi yapar. */
  async function reloadTree(): Promise<void> {
    if (reloading || store.root.length === 0) return;
    reloading = true;
    try {
      await store.reload();
    } finally {
      reloading = false;
    }
  }

  /**
   * F5 ağacı diskten tazeler (Ctrl/Alt/Meta ile birleşmez). WebView'un
   * varsayılan yeniden yüklemesi engellenir.
   */
  function handleWindowKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'F5' || event.ctrlKey || event.altKey || event.metaKey) return;
    if (store.root.length === 0) return;
    event.preventDefault();
    void reloadTree();
  }
</script>

<svelte:window onkeydown={handleWindowKeyDown} />

<section class="file-tree" aria-label="Dosya ağacı">
  <header>
    <span class="root-label" title={store.root}>{store.root.length > 0 ? store.root : 'Klasör açılmadı'}</span>
    <div class="header-actions">
      <button
        type="button"
        title="Yeni dosya"
        aria-label="Yeni dosya"
        disabled={store.root.length === 0}
        onclick={() => (createDialog = { kind: 'file', parentRel: '' })}
      >+</button>
      <button
        type="button"
        title="Yenile (F5)"
        aria-label="Ağacı yenile"
        disabled={store.root.length === 0 || reloading}
        onclick={() => void reloadTree()}
      >↻</button>
    </div>
  </header>

  <div class="tree-scroll" role="tree" tabindex="-1" aria-label="Dosya ağacı" oncontextmenu={(event) => {
    // Satırlar kendi menülerini açar; boş alan, boş klasör metni ve alt
    // klasör grupları kök bağlam menüsünü gösterir.
    const onRow = event.target instanceof Element && event.target.closest('[role="treeitem"]') !== null;
    if (!onRow) {
      event.preventDefault();
      openMenu(event, null);
    }
  }}
    ondragover={handleRootDragOver}
    ondragleave={handleRootDragLeave}
    ondrop={handleRootDrop}
    class:drop-target-root={dropTarget === ''}
  >
    {#if store.root.length === 0}
      <p class="empty">Başlamak için bir çalışma klasörü açın.</p>
    {:else if store.rootError}
      <p class="empty error" role="alert">{store.rootError}</p>
      <button type="button" class="secondary" onclick={() => void store.load('')}>Yeniden dene</button>
    {:else if store.rootEntries.length === 0 && store.loading[''] !== true}
      <p class="empty">Klasör boş. Sağ tık ile yeni dosya oluşturun.</p>
    {:else}
      <Tree
        entries={store.rootEntries}
        expanded={store.expanded}
        {selectedPath}
        {activePath}
        {renamingPath}
        getChildren={(rel) => store.childrenOf(rel)}
        getEntry={entryAt}
        onOpenFile={openFile}
        onToggle={(entry) => void toggle(entry)}
        onSelect={(entry) => (selectedPath = entry.relativePath)}
        onContextMenu={openMenu}
        onRenameSubmit={submitRename}
        onRenameCancel={() => (renamingPath = null)}
        onRenameStart={(entry) => (renamingPath = entry.relativePath)}
        onDeleteRequest={(entry) => (deleteTarget = entry)}
        drag={{
          dropTargetPath: dropTarget,
          onDragStart: handleDragStart,
          onDragOver: handleDragOver,
          onDragLeave: handleDragLeave,
          onDragEnd: handleDragEnd,
          onDrop: handleDrop,
        }}
      />
    {/if}
  </div>
</section>

{#if menu}
  <ContextMenu
    x={menu.x}
    y={menu.y}
    items={menuItems}
    onSelect={handleMenuSelect}
    onClose={() => (menu = null)}
  />
{/if}

{#if createDialog}
  <EntryDialog
    title={createDialog.kind === 'file' ? 'Yeni dosya' : 'Yeni klasör'}
    kind={createDialog.kind}
    submitLabel="Oluştur"
    onSubmit={submitCreate}
    onCancel={() => (createDialog = null)}
  />
{/if}

{#if deleteTarget}
  <ConfirmDialog
    title="Öğeyi sil"
    message={`"${deleteTarget.name}" Geri Dönüşüm Kutusu'na taşınacak.`}
    confirmLabel="Sil"
    danger={true}
    onConfirm={confirmDelete}
    onCancel={cancelDelete}
  />
{/if}

<style>
  .file-tree {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    color: var(--text, #e7eaf0);
    font-size: 0.85rem;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.45rem 0.6rem;
    border-bottom: 1px solid var(--border, #2b3240);
  }

  .root-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.78rem;
    color: var(--text-muted, #9aa3b2);
  }

  .header-actions {
    display: flex;
    gap: 0.25rem;
  }

  .header-actions button {
    width: 1.55rem;
    height: 1.55rem;
    border: 1px solid var(--border, #2b3240);
    border-radius: 5px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .header-actions button:hover:not(:disabled) {
    background: var(--surface-hover, #262e3c);
  }

  .header-actions button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .tree-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0.35rem 0.25rem 1rem;
  }

  /* Kök klasöre bırakma hedefi: ağacın tamamı vurgulanır. */
  .tree-scroll.drop-target-root {
    box-shadow: inset 0 0 0 1px var(--accent, #5aa9ff);
  }

  .empty {
    margin: 1rem 0.8rem;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--text-muted, #9aa3b2);
  }

  .empty.error {
    color: var(--danger, #ff7b72);
  }

  .secondary {
    margin: 0 0.8rem;
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--border, #2b3240);
    border-radius: 5px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }
</style>
