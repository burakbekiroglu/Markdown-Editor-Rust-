import {
  createFile,
  createFolder,
  deleteEntry,
  describeFsError,
  listEntries,
  moveEntry,
  renameEntry,
  type EntryInfo,
} from './ipc';
import { affectedDirectories, removedPaths, type FsChange } from '../watch/events';
import { isSameOrInside, parentOf } from './paths';
import { toast } from './toast.svelte';

export type CreateKind = 'file' | 'folder';

/**
 * Ağaç verisi + dosya işlemleri.
 *
 * Tüm istekler oturumdaki çalışma köküne göre çözülür; kök Rust tarafında
 * (`WorkspaceState`) tutulur ve frontend buradan mutlak yol göndermez.
 */
export class TreeStore {
  root = $state('');
  entriesByDir = $state<Record<string, EntryInfo[]>>({});
  expanded = $state<Record<string, boolean>>({});
  loading = $state<Record<string, boolean>>({});
  rootError = $state<string | null>(null);

  get rootEntries(): EntryInfo[] {
    return this.entriesByDir[''] ?? [];
  }

  childrenOf(rel: string): EntryInfo[] {
    return this.entriesByDir[rel] ?? [];
  }

  /** Görünen kökü ayarlayıp ağacı yeniden yükler. */
  attachRoot(root: string): void {
    this.root = root;
    this.entriesByDir = {};
    this.expanded = { '': true };
    this.rootError = null;
    // Önceki kök için uçuştaki liste istekleri yeni köke bağlanmamalı.
    this.#inFlight.clear();
    void this.load('');
  }

  async load(rel: string): Promise<void> {
    if (this.root.length === 0) return;
    // Aynı klasör için uçuşta bir istek varsa ikincisi açılmaz; tembel yükleme
    // her klasörü bir kez listeler (örn. toggle + fs:changed çakışması).
    const pending = this.#inFlight.get(rel);
    if (pending !== undefined) return pending;
    const request = this.#loadOnce(rel).finally(() => {
      this.#inFlight.delete(rel);
    });
    this.#inFlight.set(rel, request);
    return request;
  }

  /** Uçuştaki liste istekleri; `load` bunları tekilleştirir. */
  #inFlight = new Map<string, Promise<void>>();

  async #loadOnce(rel: string): Promise<void> {
    this.loading[rel] = true;
    try {
      const entries = await listEntries(rel);
      this.entriesByDir = { ...this.entriesByDir, [rel]: entries };
      if (rel === '') this.rootError = null;
    } catch (error) {
      const message = describeFsError(error);
      if (rel === '') this.rootError = message;
      else toast.error(message);
    } finally {
      this.loading[rel] = false;
    }
  }

  async toggle(rel: string): Promise<void> {
    const open = !this.expanded[rel];
    this.expanded[rel] = open;
    if (open && this.entriesByDir[rel] === undefined) await this.load(rel);
  }

  /**
   * Ağacı diskten tazeler: önbellek boşaltılır, kök ve daha önce yüklenmiş
   * tüm klasörler yeniden listelenir. Açık klasörler açık kalır; yalnızca
   * içerikleri diskten yeniden okunur.
   */
  async reload(): Promise<void> {
    if (this.root.length === 0) return;
    const directories = Object.keys(this.entriesByDir);
    this.entriesByDir = {};
    // Kök önce okunur: hata durumu (`rootError`) kök listelemesine bağlıdır.
    await this.load('');
    await Promise.all(
      directories.filter((rel) => rel !== '').map((rel) => this.load(rel)),
    );
  }

  /**
   * Dışarıdan gelen `fs:changed` partisini ağaca uygular.
   *
   * Silinen alt ağaçlar önbellekten düşer; ardından yalnızca yüklü/açık
   * klasörler yeniden listelenir. Böylece her olay tüm ağacı yeniden okumaz.
   */
  async refreshFromChanges(changes: readonly FsChange[]): Promise<void> {
    if (this.root.length === 0) return;
    const removed = removedPaths(changes);
    for (const rel of removed) this.#forgetSubtree(rel);
    for (const directory of affectedDirectories(changes)) {
      // Silinen bir klasörün kendisi veya altı listelenmeye çalışılmaz:
      // liste çağrısı başarısız olur ve kullanıcıya yanlış bir hata gösterir.
      if (removed.some((rel) => isSameOrInside(directory, rel))) continue;
      if (
        directory === '' ||
        this.entriesByDir[directory] !== undefined ||
        this.expanded[directory] === true
      ) {
        await this.load(directory);
      }
    }
  }

  async createEntry(parentRel: string, kind: CreateKind, name: string): Promise<EntryInfo | null> {
    try {
      const entry =
        kind === 'file'
          ? await createFile(parentRel, name)
          : await createFolder(parentRel, name);
      this.expanded[parentRel] = true;
      await this.load(parentRel);
      toast.success(`${kind === 'file' ? 'Dosya' : 'Klasör'} oluşturuldu: ${entry.name}`);
      return entry;
    } catch (error) {
      toast.error(describeFsError(error));
      return null;
    }
  }

  async rename(rel: string, newName: string): Promise<EntryInfo | null> {
    try {
      const entry = await renameEntry(rel, newName);
      if (entry.relativePath !== rel) {
        await this.load(parentOf(entry.relativePath));
        if (entry.isDir) this.#forgetSubtree(rel);
      }
      toast.success(`Yeniden adlandırıldı: ${entry.name}`);
      return entry;
    } catch (error) {
      toast.error(describeFsError(error));
      return null;
    }
  }

  /**
   * Öğeyi başka bir klasöre taşır.
   *
   * Hedefte aynı adlı öğe varsa Rust `ENTRY_EXISTS` döndürür; taşıma
   * yapılmaz ve hata toast ile bildirilir. Klasör taşınırsa eski alt ağaç
   * önbelleği düşürülür ki eski yollar görünür kalmasın.
   */
  async move(rel: string, targetDirRel: string): Promise<EntryInfo | null> {
    try {
      const entry = await moveEntry(rel, targetDirRel);
      if (entry.relativePath !== rel) {
        this.#forgetSubtree(rel);
        await this.load(parentOf(rel));
        if (targetDirRel !== parentOf(rel)) await this.load(targetDirRel);
        this.expanded[targetDirRel] = true;
      }
      toast.success(`Taşındı: ${entry.name}`);
      return entry;
    } catch (error) {
      toast.error(describeFsError(error));
      return null;
    }
  }

  async remove(rel: string): Promise<boolean> {
    try {
      await deleteEntry(rel);
      this.#forgetSubtree(rel);
      await this.load(parentOf(rel));
      toast.success("Öğe Geri Dönüşüm Kutusu'na taşındı.");
      return true;
    } catch (error) {
      toast.error(describeFsError(error));
      return false;
    }
  }

  #forgetSubtree(rel: string): void {
    const next: Record<string, EntryInfo[]> = { ...this.entriesByDir };
    for (const key of Object.keys(next)) {
      if (key === rel || key.startsWith(`${rel}/`)) delete next[key];
    }
    this.entriesByDir = next;
  }
}
