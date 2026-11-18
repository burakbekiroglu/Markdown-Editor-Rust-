<script lang="ts">
  /**
   * Uygulama kabuğu.
   *
   * Açılış sıcak yolda tutulur: CodeMirror, markdown ve vurgulama modülleri
   * bu dosyada statik olarak import edilmez. `EditorPane` ilk sekme açıldığında
   * dinamik `import()` ile gelir; çalışma alanı geri yüklemesi de ilk boyadan
   * sonraya (boşta zamana) ertelenir. Böylece açılışta ağ isteği, tekrar eden
   * zamanlayıcı veya gereksiz IPC trafiği oluşmaz.
   */
  import { onMount, type Component } from 'svelte';
  import CloseConfirmDialog from './lib/app/CloseConfirmDialog.svelte';
  import { saveDirtyTabs } from './lib/app/closeCoordinator';
  import { subscribeAppCloseRequested } from './lib/app/closeRequest';
  import Splitter from './lib/app/Splitter.svelte';
  import ViewModeToggle from './lib/app/ViewModeToggle.svelte';
  import { installShortcuts, commands } from './lib/app/shortcuts';
  import { startThemeSync } from './lib/app/theme';
  import { viewMode } from './lib/app/viewMode.svelte';
  import { conflicts } from './lib/editor/conflictStore.svelte';
  import { handleExternalChanges } from './lib/editor/externalChange';
  import { readTabContents } from './lib/editor/documents';
  import { readWorkspaceFile } from './lib/editor/ipc';
  import { writeWorkspaceFile } from './lib/save/ipc';
  import { editorState, stageHydratedViews } from './lib/session/editorState.svelte';
  import { fileExists, loadSession, openWorkspacePath, saveSession } from './lib/session/ipc';
  import { SessionPersister } from './lib/session/persist';
  import { describeSkippedTabs, planRestore } from './lib/session/restore';
  import {
    DEFAULT_SIDEBAR_WIDTH,
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH,
    clampSidebarWidth,
    createSessionData,
    parseSession,
  } from './lib/session/schema';
  import FileTree from './lib/tree/FileTree.svelte';
  import TabBar from './lib/tree/TabBar.svelte';
  import { tabs } from './lib/tree/tabsStore.svelte';
  import ToastHost from './lib/tree/ToastHost.svelte';
  import { closeWorkspace, currentWorkspace, describeFsError, openWorkspace, type WorkspaceInfo } from './lib/tree/ipc';
  import { toast } from './lib/tree/toast.svelte';
  import { reportStartupWarnings } from './lib/app/startupWarnings';
  import { invokeCommand } from './lib/ipc/client';
  import { describeAppError } from './lib/ipc/errors';
  import type { FsChange } from './lib/watch/events';
  import { subscribeWorkspaceWatch } from './lib/watch/watcher';

  const title = 'Markdown Editor';

  /** Kenar çubuğu genişliği sınırları (px); ayırıcı bu aralıkta sürüklenir. */
  const SIDEBAR_DEFAULT_WIDTH = DEFAULT_SIDEBAR_WIDTH;

  let root = $state('');
  let picking = $state(false);
  let closing = $state(false);
  /** Kapanış onayı görünür mü; kirli sekme varken açılır. */
  let closePrompt = $state(false);
  /** Kaydet-ve-kapat sürüyor; çift istekleri engeller. */
  let appClosing = $state(false);
  let sidebarWidth = $state(SIDEBAR_DEFAULT_WIDTH);
  let EditorPane = $state<Component | null>(null);
  let editorPaneFailed = $state(false);
  let quickOpen = $state(false);
  /** Ctrl+P paneli yalnızca ilk açılışta yüklenir; açılış grafiğinde yer almaz. */
  let QuickOpenPanel = $state<Component<{ open: boolean; onClose: () => void }> | null>(null);
  /** Çakışma bantları ilk çakışmada yüklenir; açılışta boş kalır. */
  let ConflictHost = $state<Component | null>(null);
  /** Oturum hidrasyonu bitti mi; bitene dek diske yazılmaz. */
  let hydrated = $state(false);

  /**
   * Oturum yazıcısı: değişiklikler 500 ms debounce ile birleşir, dosya Rust
   * tarafında atomik olarak değiştirilir. Hata sessizce yutulmaz.
   */
  const sessionPersister = new SessionPersister(saveSession, {
    onError: (error) => toast.error(describeFsError(error)),
  });

  /** Durum çubuğu: kök klasör adı ve aktif sekmenin kayıt durumu. */
  const activeTab = $derived(tabs.active);
  /** Kapanış onayında listelenen kirli sekmeler. */
  const dirtyTabs = $derived(tabs.tabs.filter((tab) => tab.dirty));
  const rootLabel = $derived(root.length === 0 ? 'Çalışma alanı açık değil' : baseName(root));
  const tabLabel = $derived(
    activeTab === null
      ? 'Sekme yok'
      : `${activeTab.title} — ${
          activeTab.missing ? 'Bulunamadı' : activeTab.dirty ? 'Kaydedilmedi' : 'Kaydedildi'
        }`,
  );

  /** Tembel yükleyici tek bir söz paylaşır; bileşen yeniden bağlanırsa ağ yok. */
  let editorPaneLoader: Promise<typeof import('./lib/editor/EditorPane.svelte')> | null = null;

  function loadEditorPane(): Promise<typeof import('./lib/editor/EditorPane.svelte')> {
    editorPaneLoader ??= import('./lib/editor/EditorPane.svelte');
    return editorPaneLoader;
  }

  /** Ctrl+P paneli ilk kez istendiğinde gelir; açılış yükünü büyütmez. */
  let quickOpenLoader: Promise<typeof import('./lib/quickopen/QuickOpenPanel.svelte')> | null = null;

  function loadQuickOpenPanel(): Promise<typeof import('./lib/quickopen/QuickOpenPanel.svelte')> {
    quickOpenLoader ??= import('./lib/quickopen/QuickOpenPanel.svelte');
    return quickOpenLoader;
  }

  /** Çakışma bantları ilk çakışmada gelir; açılış yükünü büyütmez. */
  let conflictHostLoader: Promise<typeof import('./lib/editor/ConflictHost.svelte')> | null = null;

  function loadConflictHost(): Promise<typeof import('./lib/editor/ConflictHost.svelte')> {
    conflictHostLoader ??= import('./lib/editor/ConflictHost.svelte');
    return conflictHostLoader;
  }

  onMount(() => {
    let cancelled = false;
    // Pencere açılmadan önce oluşan hatalar (bozuk oturum dosyası gibi)
    // sessizce kaybolmaz: kuyruk bir kez okunur ve toast ile bildirilir.
    void reportStartupWarnings(
      () => invokeCommand('take_startup_warnings', {}),
      (error) => toast.error(describeAppError(error)),
    );
    // Kayıtlı görünüm modu ve ayırıcı oranı ilk boyamadan hemen sonra okunur.
    viewMode.hydrate();
    const cancel = scheduleAfterFirstPaint(() => {
      if (!cancelled) void restoreSession();
    });
    // Pencere kapanırken bekleyen oturum yazımı son kez gönderilir.
    const flushSession = (): void => {
      void sessionPersister.flush();
    };
    window.addEventListener('pagehide', flushSession);
    const stopThemeSync = startThemeSync();
    // Merkezi kısayol katmanı ve Ctrl+P komutu tek yerde bağlanır.
    const disposeShortcuts = installShortcuts();
    const unregisterQuickOpen = commands.register('quick-open', () => {
      if (root.length === 0) return false;
      quickOpen = !quickOpen;
      return true;
    });
    // Kapanış isteği Rust'tan isimli olayla gelir; karar burada verilir.
    let stopCloseRequested: (() => void) | null = null;
    void subscribeAppCloseRequested(handleCloseRequested)
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stopCloseRequested = unlisten;
      })
      .catch((error: unknown) => toast.error(describeFsError(error)));
    return () => {
      cancelled = true;
      cancel();
      window.removeEventListener('pagehide', flushSession);
      sessionPersister.dispose();
      stopThemeSync();
      unregisterQuickOpen();
      disposeShortcuts();
      stopCloseRequested?.();
      stopCloseRequested = null;
    };
  });

  /** Kök yolun son parçası; durum çubuğunda tam yol yerine klasör adı görünür. */
  function baseName(path: string): string {
    const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? path;
  }

  /**
   * İlk kare çizilene kadar bekler: `requestIdleCallback` varsa boşta zamanda,
   * yoksa tek seferlik bir makro görevde çalışır. Tekrar eden zamanlayıcı yok.
   */
  function scheduleAfterFirstPaint(callback: () => void): () => void {
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(callback, { timeout: 500 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(callback, 0);
    return () => clearTimeout(id);
  }

  /**
   * Açılışta oturumu geri yükler — ilk boyadan sonra, boşta zamanda.
   *
   * Sıra: açık kök (geliştirme yeniden yüklemesi) → kayıtlı oturum dosyası →
   * kökü yeniden açma → sekme yoklaması → görünüm/ayırıcı. Diskte artık
   * bulunmayan dosyalar geri yüklenmez ve kullanıcıya bilgi bildirimi
   * gösterilir. Bozuk veya bilinmeyen sürümlü dosya sessizce yok sayılır ve
   * boş durum ekranı açılır.
   */
  async function restoreSession(): Promise<void> {
    try {
      const existing = await currentWorkspace();
      const raw = await loadSession();
      const data = raw === null ? null : parseSession(raw);
      if (data === null) {
        if (existing) {
          root = existing.root;
          reportWatcherError(existing);
        }
        return;
      }

      viewMode.setMode(data.viewMode);
      viewMode.setRatio(data.splitRatio);
      sidebarWidth = clampSidebarWidth(data.sidebarWidth);
      stageHydratedViews(data);

      let targetRoot = existing?.root ?? '';
      if (data.root.length > 0 && !sameRoot(data.root, targetRoot)) {
        const info = await openWorkspacePath(data.root);
        targetRoot = info.root;
        reportWatcherError(info);
      } else if (existing) {
        reportWatcherError(existing);
      }

      if (targetRoot.length === 0) return;
      root = targetRoot;
      const plan = await planRestore(data, fileExists);
      // Diskte bulunmayan dosyalar geri yüklenmez; kullanıcı kaç sekmenin
      // atlandığını bilgi bildirimiyle görür (hata değil, sessiz kayıp yok).
      tabs.restore(
        plan.tabs.map((tab) => ({ path: tab.path, missing: false })),
        plan.activePath,
      );
      if (plan.missing.length > 0) toast.info(describeSkippedTabs(plan.missing));
    } catch (error) {
      toast.error(describeFsError(error));
      // Kök artık açılamıyorsa boş oturumla devam edilir; uygulama çökmez.
      root = '';
      tabs.restore([], null);
    } finally {
      hydrated = true;
    }
  }

  /** Windows yolları büyük/küçük harf ve ayırıcı duyarsızdır. */
  function sameRoot(a: string, b: string): boolean {
    return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
  }

  /**
   * Oturum anlık görüntüsü. `editorState.revision` okunur çünkü imleç/scroll
   * değişimi yalnızca bu sayaç üzerinden reaktiftir; sekme listesi, etkin
   * sekme, görünüm modu ve ayırıcı zaten reaktif kaynaklardır.
   */
  $effect(() => {
    if (!hydrated) return;
    void editorState.revision;
    const snapshot = createSessionData({
      root,
      tabs: tabs.tabs.map((tab) => {
        const view = editorState.get(tab.path);
        return {
          path: tab.path,
          cursor: view?.cursor ?? null,
          scroll: view?.scroll ?? null,
        };
      }),
      activePath: tabs.active?.path ?? null,
      viewMode: viewMode.mode,
      splitRatio: viewMode.ratio,
      sidebarWidth,
    });
    sessionPersister.schedule(snapshot);
  });

  // Editör yalnızca gerçekten bir sekme açıldığında yüklenir; açılışta değil.
  $effect(() => {
    if (tabs.active === null || EditorPane !== null || editorPaneFailed) return;
    let active = true;
    void loadEditorPane()
      .then((module) => {
        if (active) EditorPane = module.default;
      })
      .catch((error: unknown) => {
        if (!active) return;
        editorPaneFailed = true;
        toast.error(describeFsError(error));
      });
    return () => {
      active = false;
    };
  });

  // Hızlı geçiş paneli ilk Ctrl+P'de yüklenir; sonra bağlı kalır, böylece
  // aç/kapa odak davranışı (`open`) değişmez.
  $effect(() => {
    if (!quickOpen || QuickOpenPanel !== null) return;
    let active = true;
    void loadQuickOpenPanel()
      .then((module) => {
        if (active) QuickOpenPanel = module.default;
      })
      .catch((error: unknown) => toast.error(describeAppError(error)));
    return () => {
      active = false;
    };
  });

  // Çakışma bantları yalnızca gerçekten bir çakışma oluştuğunda yüklenir;
  // ilk boyada hiçbir şey çizmedikleri için görünüm değişmez.
  $effect(() => {
    if (conflicts.pending.length === 0 || ConflictHost !== null) return;
    let active = true;
    void loadConflictHost()
      .then((module) => {
        if (active) ConflictHost = module.default;
      })
      .catch((error: unknown) => toast.error(describeAppError(error)));
    return () => {
      active = false;
    };
  });

  /**
   * Dış değişiklikleri açık sekmelerle eşleştirir. Buradaki tek iş çakışma
   * kararıdır: ağaç tazelemesini `FileTree` kendi aboneliğinde yapar, bu
   * yüzden `onError` bilinçli olarak sessizdir (hata orada bildirilir).
   */
  $effect(() => {
    const watchedRoot = root;
    if (watchedRoot.length === 0) return;

    let active = true;
    let stop: (() => void) | null = null;

    void subscribeWorkspaceWatch({
      onChange: (changes) => {
        if (active) void applyExternalChanges(changes);
      },
      onError: () => {
        // `FileTree` aynı olayı dinleyip kullanıcıya toast gösterir.
      },
    })
      .then((unlisten) => {
        if (active) stop = unlisten;
        else unlisten();
      })
      .catch((error: unknown) => {
        if (active) toast.error(describeFsError(error));
      });

    return () => {
      active = false;
      stop?.();
      stop = null;
    };
  });

  async function applyExternalChanges(changes: FsChange[]): Promise<void> {
    // "Eksik dosya" durumu sekme yöneticisinin sorumluluğudur: silinen yol
    // sekmeyi kapatmaz, işaretler; yeniden oluşturulan yol işareti kaldırır.
    for (const change of changes) {
      if (change.kind === 'remove') tabs.markDeleted(change.path);
      else if (change.kind === 'create') tabs.markPresent(change.path);
    }
    await handleExternalChanges(changes, {
      tabs: () => tabs.tabs,
      conflicts,
      readFile: readWorkspaceFile,
      markClean: (tabId) => {
        tabs.setDirty(tabId, false);
        // Diskteki sürüm dışarıdan değişti; eski hash artık geçersiz.
        tabs.setHash(tabId, null);
      },
      onError: (error) => toast.error(describeFsError(error)),
    });
  }

  /**
   * İzleyici başlatma hatası klasör açmayı engellemez; komut yanıtıyla gelir
   * çünkü hata oluştuğunda frontend henüz `fs:watcher-error` olayına abone
   * değildir.
   */
  function reportWatcherError(info: WorkspaceInfo): void {
    if (info.watcherError) toast.error(describeFsError(info.watcherError));
  }

  async function pickFolder(): Promise<void> {
    if (picking) return;
    picking = true;
    try {
      const info = await openWorkspace();
      if (info) {
        root = info.root;
        reportWatcherError(info);
      }
    } catch (error) {
      toast.error(describeFsError(error));
    } finally {
      picking = false;
    }
  }

  /**
   * Oturum kökünü kapatır. Rust watcher'ı durdurup kökü unutur; `root` boşalınca
   * FileTree `attachRoot('')` ile ağaç/indeks önbelleğini sıfırlar ve izleyici
   * abonelikleri söner.
   */
  async function closeRoot(): Promise<void> {
    if (closing) return;
    closing = true;
    try {
      await closeWorkspace();
      root = '';
    } catch (error) {
      toast.error(describeFsError(error));
    } finally {
      closing = false;
    }
  }

  function onFileOpen(_path: string): void {
    // Sekme/editor entegrasyonu ayrı görevde bağlanır.
  }

  /**
   * Kirli sekme yoksa onay istemeden kapatır; varsa üç seçenekli onayı açar.
   * `appClosing` ve `closePrompt` çift isteği (ör. hızlı iki tıklama) yutar.
   */
  function handleCloseRequested(): void {
    if (appClosing || closePrompt) return;
    if (tabs.tabs.some((tab) => tab.dirty)) {
      closePrompt = true;
      return;
    }
    void destroyWindow();
  }

  /**
   * Pencereyi Rust tarafında yok eder. Webview `destroy`/`close` çağırmaz:
   * o çağrılar `core:window:allow-*` ACL izni ister ve webview'e gereksiz bir
   * yetki verirdi. Uygulama komutları ACL'ye tabi olmadığı için teardown
   * `app_close_window` ile Rust'a devredilir; `destroy` yeni bir
   * `CloseRequested` üretmediğinden `prevent_close` ile döngü oluşmaz.
   *
   * Bekleyen oturum yazımı (500 ms debounce) önce gönderilir: pencere
   * yok edilince sayfa boşaltılmaz ve `pagehide` güvenilir değildir, aksi
   * halde son imleç/scroll değişikliği kaybolurdu.
   */
  async function destroyWindow(): Promise<void> {
    try {
      await sessionPersister.flush();
      await invokeCommand('app_close_window', {});
    } catch (error) {
      toast.error(describeFsError(error));
    }
  }

  /**
   * "Kaydet ve Kapat": tüm kirli sekmeler sırayla atomik yazılır. Yazma
   * hatasında kapanma iptal edilir, hata toast ile gösterilir ve sekmeler
   * dirty kalır.
   */
  async function saveAndClose(): Promise<void> {
    if (appClosing) return;
    appClosing = true;
    try {
      const result = await saveDirtyTabs(tabs.tabs, {
        readContents: readTabContents,
        writeFile: (path, contents, expectedHash) =>
          writeWorkspaceFile(path, contents, expectedHash ?? undefined),
        markSaved: (id, hash, unchanged) => tabs.recordSave(id, hash, unchanged),
        notifyError: (failure) => toast.error(describeFsError(failure)),
      });
      closePrompt = false;
      if (result.status === 'failed') return;
      await destroyWindow();
    } finally {
      appClosing = false;
    }
  }

  /** "Kaydetmeden Kapat": hiçbir yazma yapmadan pencereyi yok eder. */
  async function closeWithoutSaving(): Promise<void> {
    if (appClosing) return;
    appClosing = true;
    closePrompt = false;
    try {
      await destroyWindow();
    } finally {
      // destroy başarısız olduysa uygulama açık kalır; sonraki denemeye izin ver.
      appClosing = false;
    }
  }
</script>

<main class="app">
  <header class="titlebar">
    <h1>{title}</h1>
    <div class="workspace-actions">
      <button type="button" class="open-workspace" onclick={pickFolder} disabled={picking}>
        {picking ? 'Seçiliyor…' : 'Klasör aç'}
      </button>
      {#if root.length > 0}
        <button type="button" class="close-workspace" onclick={closeRoot} disabled={closing}>
          {closing ? 'Kapatılıyor…' : 'Kapat'}
        </button>
      {/if}
    </div>
  </header>

  <div class="body">
    <aside class="sidebar" style:width="{sidebarWidth}px">
      <FileTree {root} onFileOpen={onFileOpen} />
    </aside>

    <Splitter
      width={sidebarWidth}
      min={SIDEBAR_MIN_WIDTH}
      max={SIDEBAR_MAX_WIDTH}
      onResize={(next) => (sidebarWidth = next)}
    />

    <section class="workspace">
      {#if root.length === 0}
        <div class="empty-state">
          <p class="empty-title">Çalışma alanı açık değil</p>
          <p class="empty-hint">Başlamak için bir çalışma klasörü açın.</p>
          <button type="button" class="empty-action" onclick={pickFolder} disabled={picking}>
            {picking ? 'Seçiliyor…' : 'Çalışma klasörü aç'}
          </button>
        </div>
      {:else}
        <div class="view-toolbar">
          <ViewModeToggle />
        </div>
        <TabBar />
        <div class="editor-area">
          {#if EditorPane}
            <EditorPane />
          {:else if editorPaneFailed}
            <p class="placeholder">Düzenleyici yüklenemedi. Dosyayı yeniden açın.</p>
          {:else}
            <p class="placeholder">Düzenleyici yükleniyor…</p>
          {/if}
        </div>
      {/if}
    </section>
  </div>

  <footer class="statusbar" role="status" aria-live="polite">
    <span class="status-root" title={root.length > 0 ? root : undefined}>{rootLabel}</span>
    <span class="status-divider" aria-hidden="true">•</span>
    <span class="status-tab">{tabLabel}</span>
  </footer>
</main>

{#if ConflictHost}
  <ConflictHost />
{/if}
<ToastHost />
{#if QuickOpenPanel}
  <QuickOpenPanel open={quickOpen} onClose={() => (quickOpen = false)} />
{/if}
{#if closePrompt}
  <CloseConfirmDialog
    titles={dirtyTabs.map((tab) => tab.title)}
    busy={appClosing}
    onSaveAndClose={saveAndClose}
    onCloseWithoutSaving={closeWithoutSaving}
    onCancel={() => (closePrompt = false)}
  />
{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg);
  }

  .titlebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    height: 36px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
  }

  .titlebar h1 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--text-dim);
  }

  .workspace-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .open-workspace {
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: transparent;
    color: var(--text-dim);
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }

  .open-workspace:hover:not(:disabled) {
    background: var(--bg-hover, #262e3c);
  }

  .open-workspace:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .close-workspace {
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: transparent;
    color: var(--text-dim);
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }

  .close-workspace:hover:not(:disabled) {
    background: var(--bg-hover, #262e3c);
    color: var(--text);
  }

  .close-workspace:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .sidebar {
    flex: 0 0 auto;
    min-width: 0;
    border-right: 1px solid var(--border);
    background: var(--bg-elevated);
    overflow: hidden;
  }

  .workspace {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  .view-toolbar {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: flex-end;
    height: 30px;
    padding: 0 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
  }

  .editor-area {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    min-height: 0;
    overflow: hidden;
  }

  .placeholder {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.82rem;
  }

  /* Boş durum: tek eylem sunan sakin bir ekran; çalışma alanı ortalanır. */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    margin: auto;
    padding: 1.5rem;
    text-align: center;
  }

  .empty-state .empty-title {
    margin: 0;
    color: var(--text);
    font-size: 0.95rem;
    font-weight: 600;
  }

  .empty-state .empty-hint {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.82rem;
  }

  .empty-state .empty-action {
    margin-top: 0.5rem;
    padding: 0.4rem 0.9rem;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: var(--accent);
    color: var(--bg);
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
  }

  .empty-state .empty-action:hover:not(:disabled) {
    filter: brightness(1.08);
  }

  .empty-state .empty-action:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .empty-state .empty-action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .statusbar {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.5rem;
    height: 24px;
    padding: 0 10px;
    border-top: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text-dim);
    font-size: 0.72rem;
    overflow: hidden;
    white-space: nowrap;
  }

  .status-root,
  .status-tab {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status-root {
    flex: 0 1 auto;
  }

  .status-tab {
    flex: 1 1 auto;
    min-width: 0;
  }

  .status-divider {
    flex: 0 0 auto;
    opacity: 0.6;
  }
</style>
