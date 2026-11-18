<script lang="ts">
  /**
   * Etkin sekmeyi CodeMirror 6 ile gösteren ince editör yüzeyi.
   *
   * Görünüm (EditorView) bileşen yaşamı boyunca **tek** tanedir; sekme geçişi
   * `EditorSession` içindeki `setState` ile yapılır. Böylece her sekmenin
   * belgesi, geri alma geçmişi, arama durumu, imleci ve scroll konumu korunur
   * (bkz. `session.ts` ve `scrollState.ts`).
   *
   * Dış değişiklik sözleşmesi `conflictStore` üzerinden kurulur: editör
   * `contents()` ile sekmenin güncel metnini verir (aktif olmasa da state
   * önbelleğinden), `applyContents()` ile diskteki sürümü tek işlemde uygular.
   * Watcher'dan gelen temiz sekme yenilemesi bu bağ üzerinden görünür ve
   * `origin === 'external'` olduğu için dirty işareti tetiklenmez.
   */
  import { onDestroy, onMount } from 'svelte';

  import { saveTab, type SaveableTab } from '../save/saveTab';
  import { writeWorkspaceFile } from '../save/ipc';
  import { commands } from '../app/shortcuts';
  import { describeFsError } from '../tree/ipc';
  import { tabs } from '../tree/tabsStore.svelte';
  import { toast } from '../tree/toast.svelte';
  import Splitter from '../app/Splitter.svelte';
  import { SPLIT_RATIO_MAX, SPLIT_RATIO_MIN, viewMode } from '../app/viewMode.svelte';
  import { conflicts } from './conflictStore.svelte';
  import { fileMetadata, readDocument } from './ipc';
  import { MAX_DOCUMENT_BYTES, decideOpen, formatMegabytes } from './openGuard';
  import ConfirmDialog from '../tree/ConfirmDialog.svelte';
  import { AppError } from '../ipc/errors';
  import { registerDocumentReader } from './documents';
  import { observeEditorTheme } from './editorTheme';
  import { EditorSession, type ChangeOrigin } from './session';
  import {
    ScrollSyncController,
    lineForTop,
    normalizeLineAnchors,
    topForLine,
    type LineAnchor,
    type LineSyncEndpoint,
  } from './scrollSync';
  import { editorState, takeHydratedView } from '../session/editorState.svelte';
  import MissingFileBanner from './MissingFileBanner.svelte';
  import { SOURCE_LINE_ATTR } from '../preview/sourceLine';

  let host = $state<HTMLDivElement | null>(null);
  let activeTabId = $state<string | null>(null);
  let activeTabPath = $state<string | null>(null);
  let activeMissing = $state(false);
  let previewSource = $state('');

  /** 2 MB üzeri dosya için kullanıcı kararı bekleniyor. */
  let pendingLargeOpen = $state<{ tabId: string; path: string; size: number } | null>(null);
  /**
   * Bu oturumda açılması onaylanmış büyük dosyalar. Temiz sekme her
   * etkinleşmede diskten tazelendiği için onay yolu başına bir kez sorulur.
   */
  const confirmedLargePaths = new Set<string>();

  /** Bölünmüş yerleşimin ölçümleri ve senkron uçları. */
  let shell = $state<HTMLDivElement | null>(null);
  let shellWidth = $state(0);
  let editorScroller = $state<HTMLElement | null>(null);
  let previewScroller = $state<HTMLElement | null>(null);
  const scrollSync = new ScrollSyncController();

  const activeTab = $derived(tabs.active);
  const mode = $derived(viewMode.mode);
  const splitPercent = $derived(`${(viewMode.ratio * 100).toFixed(3)}%`);
  const splitWidth = $derived(Math.round(shellWidth * viewMode.ratio));
  const splitMin = $derived(Math.round(shellWidth * SPLIT_RATIO_MIN));
  const splitMax = $derived(Math.round(shellWidth * SPLIT_RATIO_MAX));

  // `EditorSession` runes ile sarılmaz: sınıf özel alanları (#states) proxy
  // üzerinden okunamaz. Yalnızca etkin sekme kimliği reaktif tutulur.
  let session: EditorSession | null = null;
  /** Açık sekme başına içerik köprüsü; arka plan sekmeleri de tazelenir. */
  const tabBindings = new Map<string, () => void>();
  let stopThemeWatch: (() => void) | null = null;
  let loadToken = 0;

  function createSession(): EditorSession {
    const created = new EditorSession({
      onChange: (tabId, contents, origin) => onContentsChanged(tabId, contents, origin),
      onViewState: (tabId, snapshot) => {
        const tab = tabs.tabs.find((item) => item.id === tabId);
        if (tab !== undefined) editorState.set(tab.path, snapshot);
      },
    });
    stopThemeWatch = observeEditorTheme((theme) => created.setTheme(theme));
    return created;
  }

  /**
   * Oturumdan gelen imleç/scroll değerini sekme ilk kez açılırken uygular ve
   * tüketir; sonraki açılışlarda state zaten kendi konumunu taşır.
   */
  function applyHydratedView(tabId: string, path: string): void {
    const snapshot = takeHydratedView(path);
    if (snapshot !== null) session?.applyViewState(tabId, snapshot);
  }

  function onContentsChanged(tabId: string, contents: string, origin: ChangeOrigin): void {
    if (tabId === activeTabId) previewSource = contents;
    if (origin !== 'user') return;
    const tab = tabs.tabs.find((item) => item.id === tabId);
    if (tab !== undefined && !tab.dirty) tabs.setDirty(tabId, true);
  }

  /**
   * Yazma `ConflictDetected` ile reddedildiğinde disk sürümünü okuyup çakışma
   * bandını açar. Editör içeriği ve dirty işareti korunur; okuma başarısız
   * olursa hiçbir içerik değişmez, hata toast ile bildirilir.
   */
  async function reportSaveConflict(tab: SaveableTab, contents: string): Promise<void> {
    try {
      const document = await readDocument(tab.path);
      // Okuma sürerken sekme kapanmış veya yeniden adlandırılmış olabilir.
      const latest = tabs.tabs.find((item) => item.id === tab.id);
      if (latest === undefined || latest.path !== tab.path) return;
      conflicts.observe({
        tab: latest,
        editorContents: contents,
        diskContents: document.contents,
      });
    } catch (error) {
      toast.error(describeFsError(error));
    }
  }

  function save(): void {
    const tab = tabs.active;
    const current = session;
    if (tab === null || current === null) return;
    if (tab.missing) {
      toast.error('Dosya bulunamadı. Önce sekmeyi yeniden konumlandırın.');
      return;
    }
    const contents = current.contents(tab.id);
    if (contents === null) return;
    void saveTab(tab, contents, {
      writeFile: async (path, text, expectedHash) => {
        return writeWorkspaceFile(path, text, expectedHash ?? undefined);
      },
      markSaved: (id, hash) => {
        // Yazma sürerken kullanıcı yazmaya devam ettiyse dirty kalır; hash
        // yine de diskteki yeni sürümü gösterir.
        const unchanged = current.contents(id) === contents;
        tabs.recordSave(id, hash ?? null, unchanged);
      },
      notifyError: (failure) => toast.error(describeFsError(failure)),
      // Çakışmada tek karar yeri ConflictStore'dur: bant açılır, içerik korunur.
      onConflict: (failedTab, failedContents) => {
        void reportSaveConflict(failedTab, failedContents);
      },
    }).then((outcome) => {
      if (outcome.status === 'saved') toast.success(`Kaydedildi: ${tab.title}`);
    });
  }

  /**
   * Açık **her** sekme için çakışma köprüsü kurar.
   *
   * `fs:changed` işleyicisi (`externalChange`) içeriği bu köprüden okur; yalnızca
   * etkin sekmeyi bağlamak, arka plandaki temiz sekmelerin dış değişiklikte
   * tazelenmemesine yol açıyordu. Arka plan sekmesinin state'i görünüme
   * yerleştirilmeden güncellenir, bu yüzden etkin editör kilitlenmez. Kapanan
   * sekmelerin köprüleri bırakılır (bellek sekme sayısıyla sınırlı kalır).
   */
  function syncTabBindings(): void {
    const open = new Set(tabs.tabs.map((item) => item.id));
    // Kapanan sekmenin bekleyen çakışması tam belge kopyalarını tutmasın.
    conflicts.prune(open);
    for (const [tabId, unbind] of [...tabBindings]) {
      if (open.has(tabId)) continue;
      unbind();
      tabBindings.delete(tabId);
    }
    for (const tabId of open) {
      if (tabBindings.has(tabId)) continue;
      tabBindings.set(
        tabId,
        conflicts.bindEditor(tabId, {
          contents: () => session?.contents(tabId) ?? '',
          applyContents: (contents) => {
            session?.applyContents(tabId, contents);
          },
        }),
      );
    }
  }

  /** Sekmeyi görünür kılar: state swap + scroll restore. */
  function show(tabId: string): void {
    const current = session;
    const tab = tabs.tabs.find((item) => item.id === tabId);
    if (current === null || tab === undefined) return;
    current.activate(tabId);
    activeTabId = tabId;
    activeTabPath = tab.path;
    activeMissing = tab.missing;
    previewSource = current.contents(tabId) ?? '';
  }

  async function load(
    tabId: string,
    path: string,
    options: { confirmed?: boolean } = {},
  ): Promise<void> {
    const current = session;
    if (current === null) return;
    const token = ++loadToken;
    const before = tabs.tabs.find((item) => item.id === tabId);

    // Kaydedilmemiş içerik her zaman state'ten gelir; temiz sekme diskten
    // tazelenir, böylece sekme arka plandayken oluşan değişiklik görülür.
    if (before?.dirty && current.hasState(tabId)) {
      show(tabId);
      return;
    }

    // Boyut kapısı: 2 MB üzeri dosya onay ister, 5 MB üzeri hiç okunmadan
    // reddedilir. Meta veri alınamazsa karar okuyan komuta bırakılır.
    if (options.confirmed !== true && !confirmedLargePaths.has(path)) {
      let size: number | null = null;
      try {
        size = (await fileMetadata(path)).size;
      } catch {
        size = null;
      }
      if (token !== loadToken) return;
      if (size !== null) {
        const decision = decideOpen(size);
        if (decision === 'reject') {
          toast.error(
            describeFsError(
              new AppError(
                'TooLarge',
                `${path}: ${formatMegabytes(size)} (sınır ${formatMegabytes(MAX_DOCUMENT_BYTES)})`,
              ),
            ),
          );
          closeUnopenedTab(tabId);
          return;
        }
        if (decision === 'confirm') {
          pendingLargeOpen = { tabId, path, size };
          return;
        }
      }
    }

    try {
      const document = await readDocument(path);
      if (token !== loadToken) return;
      const latest = tabs.tabs.find((item) => item.id === tabId);
      if (!latest || latest.path !== path) return;
      current.open(tabId, document.contents);
      applyHydratedView(tabId, path);
      // Disk sürümünün hash'i sonraki kaydetmenin `expectedHash`'i olur.
      tabs.setHash(tabId, document.hash);
      show(tabId);
    } catch (error) {
      if (token !== loadToken) return;
      if (current.hasState(tabId)) {
        show(tabId);
        return;
      }
      toast.error(describeFsError(error));
    }
  }

  /**
   * "Eksik dosya" sekmesini aynı yolda yeniden oluşturur. İçerik bellekten
   * yazılır; başarıda sekme normal duruma döner ve dirty temizlenir. Hata
   * durumunda hiçbir şey değişmez, mesaj bantta gösterilir.
   */
  async function recreate(tabId: string): Promise<string | null> {
    const tab = tabs.tabs.find((item) => item.id === tabId);
    if (tab === undefined) return 'Sekme bulunamadı.';
    const current = session;
    const contents = current?.contents(tabId) ?? '';
    try {
      // Dosya diskte yok: eski hash geçersiz olduğundan `expectedHash`
      // gönderilmez, aksi halde Rust tarafı çakışma reddi verir.
      const result = await writeWorkspaceFile(tab.path, contents);
      // Önce "eksik" işareti kalkar; hash ancak bundan sonra yazılabilir.
      tabs.markPresent(tab.path);
      tabs.recordSave(tabId, result.hash ?? null, current?.contents(tabId) === contents);
      toast.success(`Kaydedildi: ${tab.title}`);
      return null;
    } catch (error) {
      return describeFsError(error);
    }
  }

  /**
   * Onay bekleyen büyük dosya açılışını iptal eder. Sekme bu açılış için
   * yeni oluşturulduysa (state yok) kapatılır; arka planda kalan boş sekme
   * kullanıcıya yanıltıcı görünmez.
   */
  function closeUnopenedTab(tabId: string): void {
    const current = session;
    if (current !== null && current.hasState(tabId)) return;
    tabs.close(tabId);
  }

  function cancelLargeOpen(): void {
    const pending = pendingLargeOpen;
    pendingLargeOpen = null;
    if (pending === null) return;
    closeUnopenedTab(pending.tabId);
  }

  function confirmLargeOpen(): void {
    const pending = pendingLargeOpen;
    pendingLargeOpen = null;
    if (pending === null) return;
    // Sekme bu arada kapanmış veya yeniden adlandırılmış olabilir.
    const latest = tabs.tabs.find((item) => item.id === pending.tabId);
    if (latest === undefined || latest.path !== pending.path) return;
    confirmedLargePaths.add(pending.path);
    void load(pending.tabId, pending.path, { confirmed: true });
  }

  // "Eksik dosya" sekmesini yeni yola bağlar.
  async function relocate(tabId: string, newPath: string): Promise<string | null> {
    try {
      await readDocument(newPath);
    } catch (error) {
      return describeFsError(error);
    }
    const result = tabs.relocate(tabId, newPath);
    return result.ok ? null : (result.reason ?? 'Sekme yeniden konumlandırılamadı.');
  }

  /** Açık sekmelerin kimlikleri; kapalı sekmelerin state'i bırakılır. */
  function openTabIds(): Set<string> {
    return new Set(tabs.tabs.map((item) => item.id));
  }

  $effect(() => {
    const element = host;
    // Etkin sekme ve sekme listesi bu efektin bağımlılıklarıdır.
    const tab = tabs.active;

    if (element === null) return;
    if (session === null) {
      session = createSession();
      session.mount(element);
      editorScroller = session.view?.scrollDOM ?? null;
    }
    const current = session;
    const openPaths = new Set(tabs.tabs.map((item) => item.path));
    current.prune(openTabIds());
    editorState.prune(openPaths);
    // Kapanan büyük dosyanın onay kaydı bellekte kalmasın: tampon açık sekme
    // sayısıyla sınırlıdır. Dosya yeniden açılırsa onay tekrar sorulur.
    for (const path of confirmedLargePaths) {
      if (!openPaths.has(path)) confirmedLargePaths.delete(path);
    }
    // Açık sekmelerin köprüleri sekme listesiyle eşitlenir; arka plan sekmesi
    // kapanınca köprüsü de bırakılır.
    syncTabBindings();

    // Sekme değişirse bekleyen "büyük dosya" onayı sahibi olmayan sekmeye
    // uygulanmasın: istem kapanır, dosya o sekme yeniden etkinleşince sorulur.
    if (pendingLargeOpen !== null && pendingLargeOpen.tabId !== tab?.id) {
      pendingLargeOpen = null;
    }

    if (tab === null) {
      if (activeTabId === null) return;
      loadToken += 1;
      activeTabId = null;
      activeTabPath = null;
      activeMissing = false;
      previewSource = '';
      current.setReadOnly(false);
      current.close();
      return;
    }

    // "Eksik dosya" sekmesi salt okunurdur; içerik korunur, düzenlenemez.
    current.setReadOnly(tab.missing);

    if (tab.id === activeTabId && tab.path === activeTabPath && tab.missing === activeMissing) {
      return;
    }

    if (tab.missing) {
      // Diskten okuma yapılmaz; elde state yoksa boş salt-okunur belge açılır.
      loadToken += 1;
      if (!current.hasState(tab.id)) {
        current.open(tab.id, '');
        applyHydratedView(tab.id, tab.path);
      }
      show(tab.id);
      return;
    }

    void load(tab.id, tab.path);
  });

  /**
   * Bölünmüş yerleşimin gerçek genişliği. Ayırıcı ve oran px cinsinden
   * çalıştığı için kabın ölçüsü tutulur; pencere yeniden boyutlanınca tazelenir.
   */
  $effect(() => {
    const element = shell;
    if (element === null) return;
    shellWidth = Math.round(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) shellWidth = Math.round(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  });

  /**
   * Önizlemedeki `data-source-line` bloklarının kap içindeki üst konumları.
   *
   * `offsetTop` kabın (`position: relative`) içinde okunur; her blok için kutu
   * ölçümü yapılmadığından kaydırma sırasında düzen yeniden hesaplanmaz.
   */
  function previewAnchors(container: HTMLElement): LineAnchor[] {
    const anchors: LineAnchor[] = [];
    for (const element of container.querySelectorAll<HTMLElement>(`[${SOURCE_LINE_ATTR}]`)) {
      const line = Number(element.getAttribute(SOURCE_LINE_ATTR));
      if (!Number.isFinite(line)) continue;
      anchors.push({ line, top: element.offsetTop });
    }
    return normalizeLineAnchors(anchors);
  }

  /** Ham DOM kabını eşitlemenin beklediği kaydırma arayüzüne sarar. */
  function withLineMap(
    element: HTMLElement,
    map: { lineAtTop: () => number; scrollToLine: (line: number) => void },
  ): LineSyncEndpoint {
    return {
      get scrollTop() {
        return element.scrollTop;
      },
      set scrollTop(value: number) {
        element.scrollTop = value;
      },
      get scrollHeight() {
        return element.scrollHeight;
      },
      get clientHeight() {
        return element.clientHeight;
      },
      addEventListener: (type, listener, options) =>
        element.addEventListener(type, listener, options),
      removeEventListener: (type, listener) => element.removeEventListener(type, listener),
      lineAtTop: map.lineAtTop,
      scrollToLine: map.scrollToLine,
    };
  }

  /** Görünür alanın üstündeki satırı CodeMirror'ın blok ölçümünden okur. */
  function editorLineAtTop(element: HTMLElement): number {
    const view = session?.view;
    if (view === null || view === undefined || view.scrollDOM !== element) return 1;
    // `lineBlockAtHeight` belge tepesine göre ölçer; görünür alanın tepesi
    // ekran koordinatından belge koordinatına çevrilir.
    const height = element.getBoundingClientRect().top + 2 - view.documentTop;
    const block = view.lineBlockAtHeight(Math.max(0, height));
    return view.state.doc.lineAt(block.from).number;
  }

  /** Verilen satırı editörün tepesine getirir (belge koordinatı = scrollTop). */
  function scrollEditorToLine(element: HTMLElement, line: number): void {
    const view = session?.view;
    if (view === null || view === undefined || view.scrollDOM !== element) return;
    const number = Math.min(Math.max(1, Math.round(line)), view.state.doc.lines);
    element.scrollTop = view.lineBlockAt(view.state.doc.line(number).from).top;
  }

  /** Senkron yalnızca bölünmüş modda ve iki uç da bağlıyken etkindir. */
  $effect(() => {
    const currentMode = viewMode.mode;
    const editorEl = editorScroller;
    const previewEl = previewScroller;
    if (currentMode !== 'split' || editorEl === null || previewEl === null) {
      scrollSync.detach();
      return;
    }
    scrollSync.attach(
      withLineMap(editorEl, {
        lineAtTop: () => editorLineAtTop(editorEl),
        scrollToLine: (line) => scrollEditorToLine(editorEl, line),
      }),
      withLineMap(previewEl, {
        lineAtTop: () => lineForTop(previewAnchors(previewEl), previewEl.scrollTop) ?? 1,
        scrollToLine: (line) => {
          const top = topForLine(previewAnchors(previewEl), line);
          if (top !== null) previewEl.scrollTop = top;
        },
      }),
    );
    return () => scrollSync.detach();
  });

  /**
   * Mod değişiminde paneller sökülmez, gizlenir; gizliyken CodeMirror ölçüm
   * yapamaz. Görünür olur olmaz yeniden ölçülür ve imleç konumu korunur.
   */
  $effect(() => {
    if (mode === 'preview') return;
    session?.view?.requestMeasure();
  });

  onMount(() => {
    // Kapanış akışı gibi dış tüketiciler arka plan sekmelerinin metnine
    // `readTabContents` üzerinden ulaşır; oturum bileşen içinde kalır.
    const disposeDocuments = registerDocumentReader((tabId) => session?.contents(tabId) ?? null);
    const disposers = [
      commands.register('save', () => {
        if (tabs.active === null || session === null) return false;
        save();
        return true;
      }),
      commands.register('bold', () =>
        tabs.active === null ? false : (session?.toggleBold() ?? false),
      ),
      commands.register('find', () =>
        tabs.active === null ? false : (session?.openSearch() ?? false),
      ),
    ];
    return () => {
      disposeDocuments();
      for (const dispose of disposers) dispose();
    };
  });

  onDestroy(() => {
    scrollSync.detach();
    loadToken += 1;
    for (const release of tabBindings.values()) release();
    tabBindings.clear();
    stopThemeWatch?.();
    stopThemeWatch = null;
    session?.destroy();
    session = null;
  });
</script>

<div
  class="editor-shell"
  class:split={mode === 'split'}
  style:--split-ratio={splitPercent}
  bind:this={shell}
>
  <div class="editor-column" class:collapsed={mode === 'preview'}>
    {#if activeTab && activeTab.missing}
      <MissingFileBanner
        title={activeTab.title}
        path={activeTab.path}
        dirty={activeTab.dirty}
        onRelocate={(newPath) => relocate(activeTab.id, newPath)}
        onSave={() => recreate(activeTab.id)}
        onClose={() => tabs.close(activeTab.id)}
      />
    {/if}
    <div class="editor-pane" bind:this={host} data-tab={activeTabId ?? ''}></div>
  </div>
  {#if mode === 'split'}
    <Splitter
      width={splitWidth}
      min={splitMin}
      max={splitMax}
      label="Editör ve önizleme arasındaki oran"
      onResize={(next) => {
        if (shellWidth > 0) viewMode.setRatio(next / shellWidth);
      }}
    />
  {/if}
  <div class="preview-column" class:collapsed={mode === 'editor'}>
    {#await import('../preview/PreviewPane.svelte') then previewModule}
      {@const PreviewPane = previewModule.default}
      <PreviewPane
        source={previewSource}
        documentPath={tabs.active?.path ?? ''}
        active={mode !== 'editor'}
        bind:element={previewScroller}
      />
    {/await}
  </div>
</div>

{#if pendingLargeOpen !== null}
  <ConfirmDialog
    title="Büyük dosya"
    message={`${pendingLargeOpen.path} dosyası ${formatMegabytes(pendingLargeOpen.size)} boyutunda. Metin düzenleyicide açmak belleği ve açılış süresini olumsuz etkileyebilir. Yine de açılsın mı?`}
    confirmLabel="Yine de aç"
    onConfirm={confirmLargeOpen}
    onCancel={cancelLargeOpen}
  />
{/if}

<style>
  .editor-shell {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    flex: 1;
    min-width: 0;
    min-height: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  /* Oran yalnızca bölünmüş modda sütun genişliğini belirler; ayırıcı 5px. */
  .editor-shell.split {
    grid-template-columns: minmax(0, var(--split-ratio, 50%)) 5px minmax(0, 1fr);
  }

  .editor-column {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .preview-column {
    display: flex;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  /*
   * Mod değişimi paneli sökmez, yalnızca gizler: CodeMirror görünümü ve
   * önizleme kaydırması mod geçişinde korunur (imleç ayrıca state'tedir).
   */
  .editor-column.collapsed,
  .preview-column.collapsed {
    display: none;
  }

  .editor-pane {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .editor-pane :global(.cm-editor) {
    height: 100%;
  }
</style>
