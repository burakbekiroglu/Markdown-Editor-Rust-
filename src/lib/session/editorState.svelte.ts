/**
 * Editör görünüm durumunun (imleç + scroll) sekme yolu başına kaydı.
 *
 * `EditorSession` sekme başına `EditorState` tutar ve bu durum normalde
 * editör bileşeni içinde yaşar. Oturum kalıcılığı ise kabuk bileşeninde
 * (`App.svelte`) çalışır; iki taraf arasındaki tek köprü bu küçük kayıttır.
 *
 * Kayıt ayrıca `revision` sayacı yayınlar: `$effect` yalnızca reaktif
 * değerleri izlediği için, imleç/scroll değişimi sayacı artırmazsa oturum
 * yazımı tetiklenmez.
 */
import type { EditorViewSnapshot } from '../editor/session';
import type { SessionData } from './schema';

function sameCursor(
  a: EditorViewSnapshot['cursor'],
  b: EditorViewSnapshot['cursor'],
): boolean {
  if (a === null || b === null) return a === b;
  return a.anchor === b.anchor && a.head === b.head;
}

function sameScroll(
  a: EditorViewSnapshot['scroll'],
  b: EditorViewSnapshot['scroll'],
): boolean {
  if (a === null || b === null) return a === b;
  return a.top === b.top && a.left === b.left;
}

export class EditorStateRegistry {
  /** Reaktif tetikleyici; değer değişince artar. */
  revision = $state(0);
  #views = new Map<string, EditorViewSnapshot>();

  set(path: string, snapshot: EditorViewSnapshot): void {
    const previous = this.#views.get(path);
    if (
      previous !== undefined &&
      sameCursor(previous.cursor, snapshot.cursor) &&
      sameScroll(previous.scroll, snapshot.scroll)
    ) {
      return;
    }
    this.#views.set(path, snapshot);
    this.revision += 1;
  }

  get(path: string): EditorViewSnapshot | null {
    return this.#views.get(path) ?? null;
  }

  /** Kapanan sekmelerin kayıtlarını bırakır; bellek açık sekme sayısıyla sınırlıdır. */
  prune(openPaths: ReadonlySet<string>): void {
    for (const path of [...this.#views.keys()]) {
      if (!openPaths.has(path)) this.#views.delete(path);
    }
  }

  clear(): void {
    this.#views.clear();
  }
}

export const editorState = new EditorStateRegistry();

/** Geri yükleme sırasında bir kez tüketilecek görünüm durumları. */
const hydrated = new Map<string, EditorViewSnapshot>();

/** Oturumdan gelen imleç/scroll değerlerini sekme yolu başına hazırlar. */
export function stageHydratedViews(data: SessionData): void {
  hydrated.clear();
  for (const tab of data.tabs) {
    if (tab.cursor === null && tab.scroll === null) continue;
    hydrated.set(tab.path, { cursor: tab.cursor, scroll: tab.scroll });
  }
}

/**
 * Sekme ilk kez açılırken bekleyen görünüm durumunu verir ve tüketir.
 * Böylece kullanıcı sonradan imleci taşıdığında eski değer geri gelmez.
 */
export function takeHydratedView(path: string): EditorViewSnapshot | null {
  const snapshot = hydrated.get(path);
  if (snapshot === undefined) return null;
  hydrated.delete(path);
  return snapshot;
}

/** Testler için: bekleyen hidrasyon kayıtlarını temizler. */
export function clearHydratedViews(): void {
  hydrated.clear();
}
