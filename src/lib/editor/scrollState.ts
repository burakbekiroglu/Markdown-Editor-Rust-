/**
 * Scroll konumunun `EditorState` içine gömülmesi ve geri yüklenmesi.
 *
 * CodeMirror 6'da imleç/seçim zaten `EditorState` içindedir; scroll konumu ise
 * DOM'a aittir. Tek `EditorView` + sekme başına `EditorState` modelinde scroll
 * da state ile taşınmalıdır, aksi hâlde sekmeye dönüşte belge başına sıçrar.
 *
 * Çözüm: konumu tutan bir `StateField` + scroll olaylarını kare başına bir kez
 * state'e yazan bir `ViewPlugin`. `setState` sonrası `restoreScrollPosition`
 * değeri DOM'a geri yazar. İki eklenti de her `EditorState`'e eklenir.
 */
import { StateEffect, StateField, type Extension, type EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

export interface ScrollPosition {
  top: number;
  left: number;
}

/** Scroll dinleyicisinin state'e yazdığı güncelleme. */
export const setScrollPosition = StateEffect.define<ScrollPosition>();

/** Sekmenin son bilinen scroll konumu; state ile birlikte saklanır. */
export const scrollPositionField = StateField.define<ScrollPosition>({
  create: () => ({ top: 0, left: 0 }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setScrollPosition)) return effect.value;
    }
    return value;
  },
});

/** State'teki scroll konumu; alan yoksa (dış state) sıfır kabul edilir. */
export function readScrollPosition(state: EditorState): ScrollPosition {
  return state.field(scrollPositionField, false) ?? { top: 0, left: 0 };
}

/**
 * State'te saklanan konumu görünüme uygular. `setState` sonrası çağrılır;
 * yeni içerik DOM'a yazıldığı için atama aynı görev içinde geçerlidir.
 */
export function restoreScrollPosition(view: EditorView): void {
  const position = readScrollPosition(view.state);
  if (view.scrollDOM.scrollTop !== position.top) view.scrollDOM.scrollTop = position.top;
  if (view.scrollDOM.scrollLeft !== position.left) view.scrollDOM.scrollLeft = position.left;
}

/**
 * Scroll olaylarını izleyip konumu state'e yazar. Kare başına en fazla bir
 * dispatch yapılır; konum değişmediyse hiç dispatch edilmez.
 */
class ScrollRecorder {
  #view: EditorView;
  #frame: number | null = null;
  #disposed = false;

  constructor(view: EditorView) {
    this.#view = view;
    view.scrollDOM.addEventListener('scroll', this.#onScroll, { passive: true });
  }

  #onScroll = (): void => {
    if (this.#frame !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      this.#flush();
      return;
    }
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#flush();
    });
  };

  #flush(): void {
    if (this.#disposed) return;
    const { scrollTop, scrollLeft } = this.#view.scrollDOM;
    const current = this.#view.state.field(scrollPositionField, false);
    if (current !== undefined && current.top === scrollTop && current.left === scrollLeft) return;
    this.#view.dispatch({ effects: setScrollPosition.of({ top: scrollTop, left: scrollLeft }) });
  }

  destroy(): void {
    this.#disposed = true;
    this.#view.scrollDOM.removeEventListener('scroll', this.#onScroll);
    if (this.#frame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.#frame);
      this.#frame = null;
    }
  }
}

const scrollRecorder = ViewPlugin.define((view) => new ScrollRecorder(view));

/** Scroll konumunu state'e bağlayan eklenti listesi. */
export function scrollPositionExtension(): Extension {
  return [scrollPositionField, scrollRecorder];
}
