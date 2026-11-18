<script lang="ts">
  /**
   * Açık çakışma bantlarını uygulama kabuğuna yerleştiren ince katman.
   * Editör kendi sekmesi için `conflicts.bindEditor(tabId, binding)` çağırmalıdır;
   * bağlantı yoksa "Diski Yükle" içerik değiştirmez.
   */
  import { writeWorkspaceFile } from '../save/ipc';
  import { toast } from '../tree/toast.svelte';
  import { describeFsError } from '../tree/ipc';
  import { tabs } from '../tree/tabsStore.svelte';
  import ConflictBanner from './ConflictBanner.svelte';
  import { conflicts } from './conflictStore.svelte';
  import { writeMine } from './writeMine';

  function loadDisk(tabId: string): void {
    const outcome = conflicts.reload(tabId, { confirmed: true });
    if (outcome === 'applied') {
      // Disk içeriği editöre uygulandı: sekme artık diskle aynı.
      tabs.setDirty(tabId, false);
      toast.info('Diskteki sürüm yüklendi.');
    } else if (outcome === 'editor-unavailable') {
      toast.error('Bu sekmenin düzenleyicisi bulunamadı; içerik değiştirilmedi.');
    } else if (outcome === 'not-found') {
      toast.info('Çakışma zaten kapatılmış.');
    }
  }

  /** Kullanıcı kararı: editör içeriği diske yazılır, disk sürümü ezilir. */
  async function writeMineToDisk(tabId: string): Promise<void> {
    const outcome = await writeMine(tabId, {
      conflicts,
      // `expectedHash` verilmez: kullanıcı diskteki sürümü bilinçli olarak eziyor.
      write: (path, contents) => writeWorkspaceFile(path, contents),
      recordSaved: (id, hash, unchanged) => tabs.recordSave(id, hash, unchanged),
      onError: (error) => toast.error(describeFsError(error)),
    });

    if (outcome === 'written') {
      toast.success('Değişiklikleriniz diske yazıldı.');
    } else if (outcome === 'not-found') {
      toast.info('Çakışma zaten kapatılmış.');
    }
  }
</script>

{#if conflicts.pending.length > 0}
  <div class="conflict-host">
    {#each conflicts.pending as conflict (conflict.tabId)}
      <ConflictBanner
        {conflict}
        onLoadDisk={() => loadDisk(conflict.tabId)}
        onWriteMine={() => writeMineToDisk(conflict.tabId)}
        readEditorContents={() => conflicts.editorContents(conflict.tabId)}
      />
    {/each}
  </div>
{/if}

<style>
  .conflict-host {
    position: fixed;
    top: 44px;
    left: 50%;
    z-index: 1050;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    width: min(48rem, calc(100vw - 2rem));
    transform: translateX(-50%);
  }
</style>
