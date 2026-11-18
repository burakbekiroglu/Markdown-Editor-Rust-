/**
 * Çakışma bantlarının Svelte 5 runes tabanlı deposu.
 *
 * Bellekte tutulan tek şey **bekleyen kararlardır**: disk anlık görüntüsü ve
 * kullanıcının editör içeriği. Depo, bir editör bağlanmadıkça hiçbir içeriği
 * değiştirmez; "Yeniden Yükle" de açık onay ve bağlı bir editör ister.
 */
import {
  canReload,
  decideExternalChange,
  type ConflictTab,
  type ExternalChangeDecision,
  type PendingConflict,
  type ReloadOutcome,
} from './conflict';

/** Editörün sahibi tarafından sağlanan köprü. */
export interface EditorBinding {
  /** Editörün o anki içeriği; çakışma kararı bu değerle verilir. */
  contents(): string;
  /** Diskteki içeriği uygular; imleç/scroll koruması editörün sorumluluğudur. */
  applyContents(contents: string): void;
}

export interface ObserveInput {
  tab: ConflictTab;
  editorContents: string;
  diskContents: string;
  now?: number;
}

export interface ReloadRequest {
  /** Kullanıcı onayı; `true` olmadan hiçbir içerik yazılmaz. */
  confirmed: boolean;
}

export class ConflictStore {
  /** Açık bantlar; her sekme için en fazla bir tane. */
  pending = $state<PendingConflict[]>([]);

  #bindings = new Map<string, EditorBinding>();

  /** Sekme kapanınca veya editör sökülürken bağlantıyı kaldırır. */
  bindEditor(tabId: string, binding: EditorBinding): () => void {
    this.#bindings.set(tabId, binding);
    return () => {
      if (this.#bindings.get(tabId) === binding) this.#bindings.delete(tabId);
    };
  }

  for(tabId: string): PendingConflict | null {
    return this.pending.find((conflict) => conflict.tabId === tabId) ?? null;
  }

  /**
   * Bağlı editörün o anki içeriği. Bağlantı yoksa `null`: çağıran taraf bu
   * sekme için içerik karşılaştırması yapmamalı ve hiçbir şeyi ezmemelidir.
   */
  editorContents(tabId: string): string | null {
    return this.#bindings.get(tabId)?.contents() ?? null;
  }

  /**
   * Dış değişikliği sınıflandırır. Dirty sekmede editör içeriği **değişmez**;
   * yalnızca bant açılır/tazelenir. Temiz sekmede depo yine içerik uygulamaz,
   * karar çağırana döner (çağıran editörün sahibidir).
   */
  observe(input: ObserveInput): ExternalChangeDecision {
    const decision = decideExternalChange({
      tab: input.tab,
      editorContents: input.editorContents,
      diskContents: input.diskContents,
      pending: this.for(input.tab.id),
      now: input.now,
    });

    if (decision.action === 'unchanged') {
      this.#remove(input.tab.id);
      return decision;
    }

    if (decision.action === 'conflict') {
      this.#upsert(decision.conflict);
      return decision;
    }

    this.#remove(input.tab.id);
    return decision;
  }

  /**
   * "Diski Yükle": yalnızca açık onayla ve bağlı editör varsa uygular.
   * Başarısız/onaysız çağrıda bant açık kalır; içerik değişmez.
   */
  reload(tabId: string, request: ReloadRequest): ReloadOutcome {
    const conflict = this.for(tabId);
    if (!conflict) return 'not-found';
    if (!canReload(request)) return 'confirmation-required';

    const binding = this.#bindings.get(tabId);
    if (!binding) return 'editor-unavailable';

    binding.applyContents(conflict.diskContents);
    this.#remove(tabId);
    return 'applied';
  }

  /**
   * Temiz sekmenin sessiz yeniden yüklemesi. Yalnızca bağlı editör varsa
   * uygulanır; başarı durumunda `true` döner ve içerik diskle eşitlenir.
   * Çağıran, dirty işaretini temizlemekle yükümlüdür.
   */
  applyReload(tabId: string, contents: string): boolean {
    const binding = this.#bindings.get(tabId);
    if (!binding) return false;
    binding.applyContents(contents);
    return true;
  }

  /**
   * "Benimkini Yaz" başarıyla tamamlandığında bant kapanır; editör içeriği ve
   * dirty işareti bu çağrıdan etkilenmez (dirty'yi yazan katman yönetir).
   */
  keepMine(tabId: string): PendingConflict | null {
    const conflict = this.for(tabId);
    if (!conflict) return null;
    this.#remove(tabId);
    return conflict;
  }

  clear(): void {
    this.pending = [];
  }

  /**
   * Kapanan sekmelerin bekleyen çakışmalarını bırakır.
   *
   * Her kayıt, çakışma anındaki editör ve disk içeriğinin **tam kopyalarını**
   * taşır; sekme kapandıktan sonra bu kopyaların bellekte kalması için bir
   * neden yoktur. Açık sekmelerin bantları korunur.
   */
  prune(openTabIds: ReadonlySet<string>): void {
    const next = this.pending.filter((conflict) => openTabIds.has(conflict.tabId));
    if (next.length !== this.pending.length) this.pending = next;
  }

  #upsert(conflict: PendingConflict): void {
    const rest = this.pending.filter((item) => item.tabId !== conflict.tabId);
    this.pending = [...rest, conflict];
  }

  #remove(tabId: string): void {
    if (this.pending.some((item) => item.tabId === tabId)) {
      this.pending = this.pending.filter((item) => item.tabId !== tabId);
    }
  }
}

export const conflicts = new ConflictStore();
