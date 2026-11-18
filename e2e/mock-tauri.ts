/**
 * Playwright için sahte Tauri köprüsü.
 *
 * `installMockTauri` sayfa komut dosyalarından **önce** çalıştırılır ve
 * `window.__TAURI_INTERNALS__` yüzeyini kurar. Üretim kodu değişmez: uygulama
 * gerçek Tauri'de olduğu gibi aynı `invoke` çağrılarını yapar, yanıtlar ise
 * bellek içi sanal çalışma alanından gelir.
 *
 * Sözleşme `src/lib/ipc/types.ts` ile aynıdır: göreli yollar `/` ayırıcısı
 * kullanır, reddedilen komutlar `{ code, message }` gövdesiyle fırlatılır.
 *
 * Bu fonksiyon `page.addInitScript` ile serileştirildiği için kendi içinde
 * kapalıdır; modül kapsamındaki yardımcılara başvuramaz.
 */

export interface MockTauriFixture {
  /** Kanonik çalışma kökü; durum çubuğunda son parçası görünür. */
  root: string;
  /** Göreli yol (`/` ayırıcısı) → dosya içeriği. */
  files: Record<string, string>;
}

export interface MockWrite {
  path: string;
  contents: string;
}

export interface MockSnapshot {
  files: Record<string, string>;
  writes: MockWrite[];
  savedSessions: string[];
  /** `app_close_window` çağrıldı mı (pencere kapatma yolu). */
  closed: boolean;
  /** Çalışmayan bir komut istendi mi; tanı için. */
  unknownCommands: string[];
}

export interface MockBridge {
  root: string;
  /** Rust tarafının yaydığı olayı dinleyicilere iletir. */
  emit(event: string, payload?: unknown): void;
  /**
   * Diskteki bir dosyayı uygulama dışından değiştirir. Kaydetme akışındaki
   * `expectedHash` artık eşleşmez; çakışma senaryosunu sınamaya yarar.
   */
  writeExternal(path: string, contents: string): void;
  /** Yazma komutunu geciktirir; eşzamanlı ikinci isteğin kilidini sınar. */
  setWriteDelay(ms: number): void;
  snapshot(): MockSnapshot;
}

declare global {
  interface Window {
    __MD_EDITOR_MOCK__: MockBridge;
  }
}

/**
 * Sahte köprüyü kurar. `page.addInitScript(installMockTauri, fixture)` ile
 * kullanılır; tarayıcıda her gezinmeden önce yeniden çalışır.
 */
export function installMockTauri(fixture: MockTauriFixture): void {
  type Entry = {
    name: string;
    relativePath: string;
    isDir: boolean;
    isSymlink: boolean;
    size: number;
    modifiedMs: number | null;
  };
  type Callback = (payload: unknown) => void;
  type Failure = { code: string; message: string };

  const files = new Map<string, string>(Object.entries(fixture.files));
  const callbacks = new Map<number, Callback>();
  const listeners = new Map<number, { event: string; callbackId: number }>();
  const writes: MockWrite[] = [];
  const savedSessions: string[] = [];
  const unknownCommands: string[] = [];
  /** `plugin:store` kayıtları: anahtar → JSON değeri. */
  const storeValues = new Map<string, unknown>();
  let storeResourceId = 0;
  let nextResourceId = 1;
  /** `fs_write_file_atomic` gecikmesi; eşzamanlı istek kilidini sınamak için. */
  let writeDelayMs = 0;
  let workspaceOpen = false;
  let closed = false;
  let nextCallbackId = 1;
  let nextListenerId = 1;

  function failure(code: string, message: string): Failure {
    return { code, message };
  }

  /** FNV-1a; içerik değişince değişen deterministik içerik kimliği. */
  function hashOf(text: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${hash.toString(16).padStart(8, '0')}-${text.length}`;
  }

  function rootInfo(): { root: string; name: string } {
    const parts = fixture.root.split(/[\\/]/).filter((part) => part.length > 0);
    return { root: fixture.root, name: parts[parts.length - 1] ?? fixture.root };
  }

  function parentOf(relativePath: string): string {
    const index = relativePath.lastIndexOf('/');
    return index === -1 ? '' : relativePath.slice(0, index);
  }

  function nameOf(relativePath: string): string {
    const index = relativePath.lastIndexOf('/');
    return index === -1 ? relativePath : relativePath.slice(index + 1);
  }

  function directories(): Set<string> {
    const result = new Set<string>(['']);
    for (const path of files.keys()) {
      const parts = path.split('/');
      for (let depth = 1; depth < parts.length; depth += 1) {
        result.add(parts.slice(0, depth).join('/'));
      }
    }
    return result;
  }

  function entryOf(relativePath: string, isDir: boolean): Entry {
    return {
      name: nameOf(relativePath),
      relativePath,
      isDir,
      isSymlink: false,
      size: isDir ? 0 : (files.get(relativePath) ?? '').length,
      modifiedMs: null,
    };
  }

  function listDirectory(relativePath: string): Entry[] {
    const dirs = directories();
    if (relativePath !== '' && !dirs.has(relativePath)) {
      throw failure('NotFound', `Klasör bulunamadı: ${relativePath}`);
    }
    const children = new Map<string, boolean>();
    for (const dir of dirs) {
      if (dir !== '' && parentOf(dir) === relativePath) children.set(dir, true);
    }
    for (const path of files.keys()) {
      if (parentOf(path) === relativePath) children.set(path, false);
    }
    return Array.from(children.entries())
      .sort(([leftPath, leftDir], [rightPath, rightDir]) => {
        if (leftDir !== rightDir) return leftDir ? -1 : 1;
        return nameOf(leftPath).localeCompare(nameOf(rightPath), 'tr', { sensitivity: 'base' });
      })
      .map(([path, isDir]) => entryOf(path, isDir));
  }

  function indexWorkspace(): { entries: Entry[] } {
    const entries: Entry[] = [];
    for (const dir of directories()) {
      if (dir !== '') entries.push(entryOf(dir, true));
    }
    for (const path of files.keys()) entries.push(entryOf(path, false));
    return { entries };
  }

  function readFile(relativePath: string): string {
    const contents = files.get(relativePath);
    if (contents === undefined) {
      throw failure('NotFound', `Dosya bulunamadı: ${relativePath}`);
    }
    return contents;
  }

  function metadata(relativePath: string): Record<string, unknown> {
    if (files.has(relativePath)) {
      return {
        name: nameOf(relativePath),
        relativePath,
        isDir: false,
        isFile: true,
        isSymlink: false,
        isHidden: nameOf(relativePath).startsWith('.'),
        readOnly: false,
        size: (files.get(relativePath) ?? '').length,
        modifiedMs: null,
        createdMs: null,
      };
    }
    if (directories().has(relativePath)) {
      return {
        name: nameOf(relativePath),
        relativePath,
        isDir: true,
        isFile: false,
        isSymlink: false,
        isHidden: nameOf(relativePath).startsWith('.'),
        readOnly: false,
        size: 0,
        modifiedMs: null,
        createdMs: null,
      };
    }
    throw failure('NotFound', `Öğe bulunamadı: ${relativePath}`);
  }

  function writeFile(relativePath: string, contents: string, expectedHash: unknown): { hash: string } {
    const current = files.get(relativePath);
    if (current === undefined) {
      throw failure('NotFound', `Dosya bulunamadı: ${relativePath}`);
    }
    if (typeof expectedHash === 'string' && expectedHash !== hashOf(current)) {
      throw failure('ConflictDetected', 'Dosya diskte değişti.');
    }
    files.set(relativePath, contents);
    writes.push({ path: relativePath, contents });
    return { hash: hashOf(contents) };
  }

  function transformCallback(callback?: Callback, once = false): number {
    const id = nextCallbackId;
    nextCallbackId += 1;
    if (typeof callback === 'function') {
      callbacks.set(
        id,
        once
          ? (payload: unknown) => {
              callbacks.delete(id);
              callback(payload);
            }
          : callback,
      );
    }
    return id;
  }

  function unregisterCallback(id: number): void {
    callbacks.delete(id);
  }

  function emit(event: string, payload?: unknown): void {
    for (const [id, listener] of listeners) {
      if (listener.event !== event) continue;
      const callback = callbacks.get(listener.callbackId);
      if (callback === undefined) {
        listeners.delete(id);
        continue;
      }
      callback({ event, id, payload });
    }
  }

  function invoke(command: string, args: Record<string, unknown> = {}): unknown {
    switch (command) {
      case 'current_workspace':
        return workspaceOpen ? rootInfo() : null;
      case 'open_workspace':
      case 'open_workspace_path':
        workspaceOpen = true;
        return { ...rootInfo(), watcherError: null };
      case 'close_workspace':
        workspaceOpen = false;
        return rootInfo();
      // Açılış uyarıları: sahte köprüde kuyruk her zaman boştur.
      case 'take_startup_warnings':
        return [];
      // `tauri-plugin-store`: oturum `session.json` deposu. Kayıtlar bellekte
      // tutulur; `save` çağrısı diske yazımı temsil eder.
      case 'plugin:store|load': {
        storeResourceId = nextResourceId;
        nextResourceId += 1;
        return storeResourceId;
      }
      case 'plugin:store|get': {
        const key = String(args.key ?? '');
        return [storeValues.get(key), storeValues.has(key)];
      }
      case 'plugin:store|set': {
        storeValues.set(String(args.key ?? ''), args.value);
        return null;
      }
      case 'plugin:store|save':
        savedSessions.push(JSON.stringify(Object.fromEntries(storeValues)));
        return null;
      case 'list_workspace_dir':
      case 'fs_list_dir':
        return listDirectory(typeof args.path === 'string' ? args.path : '');
      case 'fs_index': {
        const result = indexWorkspace();
        return {
          root: fixture.root,
          entries: result.entries,
          truncated: false,
          skippedHidden: 0,
          skippedLarge: 0,
          skippedSymlinks: 0,
          skippedUnreadable: 0,
        };
      }
      case 'fs_metadata':
        return metadata(String(args.path ?? ''));
      case 'fs_read_file':
        return readFile(String(args.path ?? ''));
      case 'fs_read_document': {
        const path = String(args.path ?? '');
        const contents = readFile(path);
        return { contents, hash: hashOf(contents) };
      }
      case 'fs_write_file_atomic': {
        const path = String(args.path ?? '');
        const contents = String(args.contents ?? '');
        const expectedHash = args.expectedHash;
        const perform = () => writeFile(path, contents, expectedHash);
        if (writeDelayMs <= 0) return perform();
        const delay = writeDelayMs;
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            try {
              resolve(perform());
            } catch (error) {
              reject(error);
            }
          }, delay);
        });
      }
      case 'plugin:event|listen': {
        const id = nextListenerId;
        nextListenerId += 1;
        listeners.set(id, {
          event: String(args.event ?? ''),
          callbackId: Number(args.handler),
        });
        return id;
      }
      case 'plugin:event|unlisten':
        listeners.delete(Number(args.eventId));
        return null;
      // Kapatma webview'de `core:window:allow-destroy` ile değil, Rust'taki
      // uygulama komutuyla yapılır; sahte köprü o komutu taklit eder.
      case 'app_close_window':
        closed = true;
        return null;
      default:
        unknownCommands.push(command);
        throw failure('Internal', `Sahte köprü bu komutu tanımıyor: ${command}`);
    }
  }

  const internals = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main', windowLabel: 'main' },
    },
    invoke,
    transformCallback,
    unregisterCallback,
    convertFileSrc: (path: string) => path,
  };

  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = internals;
  (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => undefined,
  };

  window.__MD_EDITOR_MOCK__ = {
    root: fixture.root,
    emit,
    writeExternal: (path: string, contents: string) => {
      files.set(path, contents);
    },
    setWriteDelay: (ms: number) => {
      writeDelayMs = ms;
    },
    snapshot: () => ({
      files: Object.fromEntries(files),
      writes: writes.map((write) => ({ ...write })),
      savedSessions: [...savedSessions],
      closed,
      unknownCommands: [...unknownCommands],
    }),
  };
}
