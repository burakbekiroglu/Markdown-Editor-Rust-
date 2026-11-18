/**
 * CodeMirror 6 Ã§ekirdeÄŸi: **tek `EditorView`**, sekme baÅŸÄ±na `EditorState`.
 *
 * Sekme deÄŸiÅŸimi gÃ¶rÃ¼nÃ¼mÃ¼ yÄ±kmaz; saklanan `EditorState` `setState` ile
 * yerleÅŸtirilir. BÃ¶ylece:
 *
 * - Belge, geri alma geÃ§miÅŸi, arama durumu ve seÃ§im (imleÃ§) state ile taÅŸÄ±nÄ±r;
 *   CodeMirror seÃ§imi zaten state iÃ§inde tuttuÄŸu iÃ§in ayrÄ±ca saklanmaz.
 * - Scroll konumu `scrollPositionField` ile state'e gÃ¶mÃ¼lÃ¼r ve `setState`
 *   sonrasÄ± `restoreScrollPosition` ile DOM'a geri yazÄ±lÄ±r.
 * - GeÃ§miÅŸ sekme baÅŸÄ±na ayrÄ±dÄ±r: `history()` bir state alanÄ±dÄ±r, sekmeler
 *   birbirinin geri alma yÄ±ÄŸÄ±nÄ±nÄ± gÃ¶rmez.
 * - Tema `Compartment` Ã¼zerinden yeniden yapÄ±landÄ±rÄ±lÄ±r; tÃ¼m state'ler aynÄ±
 *   compartment Ã¶rneÄŸini paylaÅŸÄ±r.
 *
 * DÄ±ÅŸ deÄŸiÅŸiklik sÃ¶zleÅŸmesi (`conflictStore`) iÃ§in `contents`/`applyContents`
 * Ã§ifti korunur: iÃ§erik aktif olmayan sekmede de state Ã¶nbelleÄŸinden okunur.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import {
  openSearchPanel,
  search,
  searchKeymap,
} from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  crosshairCursor,
  type ViewUpdate,
} from '@codemirror/view';

import { computeBoldEdit } from './bold';
import { editorThemeExtension, resolveEditorTheme } from './editorTheme';
import { measurePerf } from './perf';
import {
  readScrollPosition,
  restoreScrollPosition,
  scrollPositionExtension,
  setScrollPosition,
} from './scrollState';
import type { Theme } from '../app/theme';

/** Ä°Ã§erik deÄŸiÅŸikliÄŸinin kaynaÄŸÄ±; dirty iÅŸareti buna gÃ¶re yÃ¶netilir. */
export type ChangeOrigin = 'user' | 'external';

/** Sekme baÅŸÄ±na kalÄ±cÄ±laÅŸtÄ±rÄ±labilir gÃ¶rÃ¼nÃ¼m durumu. */
export interface EditorViewSnapshot {
  cursor: { anchor: number; head: number } | null;
  scroll: { top: number; left: number } | null;
}

export interface EditorSessionCallbacks {
  /** Belge deÄŸiÅŸtiÄŸinde; `external` diskten gelen yenilemedir. */
  onChange?(tabId: string, contents: string, origin: ChangeOrigin): void;
  /** SeÃ§im veya scroll deÄŸiÅŸtiÄŸinde; oturum kalÄ±cÄ±lÄ±ÄŸÄ± buradan beslenir. */
  onViewState?(tabId: string, snapshot: EditorViewSnapshot): void;
}

/** Salt-okunur kipin state uzantÄ±larÄ±; hem dÃ¼zenlemeyi hem de imleci kapatÄ±r. */
function readOnlyExtensions(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

/**
 * SeÃ§imi yeni belge sÄ±nÄ±rlarÄ±na sÄ±kÄ±ÅŸtÄ±rÄ±r. Belge tamamen deÄŸiÅŸtirildiÄŸinde
 * CodeMirror seÃ§imi belgenin baÅŸÄ±na dÃ¼ÅŸÃ¼rÃ¼r; dÄ±ÅŸ deÄŸiÅŸiklikte imlecin yerinde
 * kalmasÄ± iÃ§in seÃ§im burada aÃ§Ä±kÃ§a taÅŸÄ±nÄ±r.
 */
function clampSelection(selection: EditorSelection, length: number): EditorSelection {
  return EditorSelection.create(
    selection.ranges.map((range) =>
      EditorSelection.range(Math.min(range.anchor, length), Math.min(range.head, length)),
    ),
    selection.mainIndex,
  );
}

/**
 * Geri alma geçmişinin sabit derinliği (olay sayısı).
 *
 * CodeMirror `updateBranch` yığını bu sınırın üstünde en fazla 20 olay daha
 * tutar: sekme başına geçmiş ≤ `UNDO_HISTORY_DEPTH + 21` olaydır. Sınır açıkça
 * yazılır, böylece kütüphane varsayılanı değişse de uzun oturumda geçmiş
 * sınırsız büyümez.
 */
export const UNDO_HISTORY_DEPTH = 100;

export class EditorSession {
  #callbacks: EditorSessionCallbacks;
  #view: EditorView | null = null;
  #states = new Map<string, EditorState>();
  #activeId: string | null = null;
  #theme: Theme;
  #themeCompartment = new Compartment();
  #readOnly = false;
  #readOnlyCompartment = new Compartment();
  #applyingExternal = false;

  constructor(callbacks: EditorSessionCallbacks = {}, theme: Theme = resolveEditorTheme()) {
    this.#callbacks = callbacks;
    this.#theme = theme;
  }

  get view(): EditorView | null {
    return this.#view;
  }

  get activeId(): string | null {
    return this.#activeId;
  }

  get theme(): Theme {
    return this.#theme;
  }

  /** GÃ¶rÃ¼nÃ¼mÃ¼ bir kez kurar; sonraki sekmeler yalnÄ±zca state deÄŸiÅŸtirir. */
  mount(parent: HTMLElement): void {
    if (this.#view !== null) return;
    this.#view = new EditorView({ state: this.#createState(''), parent });
  }

  hasState(tabId: string): boolean {
    return this.#states.has(tabId);
  }

  /** Sekmenin gÃ¼ncel metni; state yoksa `null` (baÄŸlÄ± editÃ¶r yok anlamÄ±). */
  contents(tabId: string): string | null {
    const state = this.#states.get(tabId);
    return state === undefined ? null : state.doc.toString();
  }

  /**
   * Oturumdan gelen imleÃ§/scroll durumunu state'e uygular. DeÄŸerler belge
   * uzunluÄŸuna sÄ±kÄ±ÅŸtÄ±rÄ±lÄ±r: dosya diskte kÄ±salmÄ±ÅŸ olabilir.
   */
  applyViewState(tabId: string, snapshot: EditorViewSnapshot): void {
    const state = this.#states.get(tabId);
    if (state === undefined) return;
    const length = state.doc.length;
    const selection =
      snapshot.cursor === null
        ? undefined
        : EditorSelection.single(
            Math.min(Math.max(0, snapshot.cursor.anchor), length),
            Math.min(Math.max(0, snapshot.cursor.head), length),
          );
    const effects =
      snapshot.scroll === null ? undefined : setScrollPosition.of(snapshot.scroll);
    const spec = { selection, effects };
    const view = this.#view;
    if (view !== null && this.#activeId === tabId && view.state === state) {
      view.dispatch(spec);
      restoreScrollPosition(view);
      return;
    }
    this.#states.set(tabId, state.update(spec).state);
  }

  /** Sekmeyi aÃ§ar: state yoksa oluÅŸturur, varsa disk iÃ§eriÄŸiyle eÅŸitler. */
  open(tabId: string, contents: string): void {
    const existing = this.#states.get(tabId);
    if (existing === undefined) {
      this.#states.set(tabId, this.#createState(contents));
    } else if (existing.doc.toString() !== contents) {
      this.#states.set(tabId, this.#replaceDocument(existing, contents));
    }
    this.activate(tabId);
  }

  /**
   * GÃ¶rÃ¼nÃ¼mÃ¼ sekmenin saklanan state'ine geÃ§irir ve scroll konumunu geri
   * yÃ¼kler. Zaten etkin state ise yeniden yerleÅŸtirme yapÄ±lmaz.
   */
  activate(tabId: string): void {
    const view = this.#view;
    const state = this.#states.get(tabId);
    if (view === null || state === undefined) return;
    this.#activeId = tabId;
    if (view.state === state) {
      restoreScrollPosition(view);
      return;
    }
    measurePerf('state-swap', () => {
      view.setState(state);
      restoreScrollPosition(view);
    });
  }

  /**
   * Diskteki iÃ§eriÄŸi uygular. Belge tamamen deÄŸiÅŸse bile seÃ§im (imleÃ§) ve
   * scroll konumu korunur: seÃ§im yeni uzunluÄŸa sÄ±kÄ±ÅŸtÄ±rÄ±lÄ±r, scroll DOM'a geri
   * yazÄ±lÄ±r. BÃ¶ylece temiz bir sekme sessizce yenilenirken kullanÄ±cÄ± yerini
   * kaybetmez.
   */
  applyContents(tabId: string, contents: string): void {
    const state = this.#states.get(tabId);
    if (state === undefined) {
      this.#states.set(tabId, this.#createState(contents));
      if (this.#activeId === tabId) this.activate(tabId);
      return;
    }
    if (state.doc.toString() === contents) return;

    if (this.#view !== null && this.#activeId === tabId) {
      const view = this.#view;
      const scroller = view.scrollDOM;
      const scrollTop = scroller.scrollTop;
      const scrollLeft = scroller.scrollLeft;
      const selection = clampSelection(view.state.selection, contents.length);
      this.#applyingExternal = true;
      try {
        measurePerf('external-apply', () => {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: contents },
            selection,
            // Diskten gelen tam belge deÄŸiÅŸimi geri alma geÃ§miÅŸine girmez:
            // aksi halde her dÄ±ÅŸ yenileme tam bir belge kopyasÄ± olarak
            // sekmenin geri alma yÄ±ÄŸÄ±nÄ±nda birikir (sÄ±nÄ±rsÄ±z bÃ¼yÃ¼me).
            annotations: Transaction.addToHistory.of(false),
          });
        });
      } finally {
        this.#applyingExternal = false;
      }
      scroller.scrollTop = scrollTop;
      scroller.scrollLeft = scrollLeft;
      return;
    }

    this.#states.set(tabId, this.#replaceDocument(state, contents));
  }

  /** Kapanan sekmelerin state'lerini bÄ±rakÄ±r; bellek belge baÅŸÄ±na sÄ±nÄ±rlÄ±dÄ±r. */
  prune(openTabIds: ReadonlySet<string>): void {
    for (const tabId of [...this.#states.keys()]) {
      if (!openTabIds.has(tabId)) this.#states.delete(tabId);
    }
  }

  /** Tema deÄŸiÅŸimini tÃ¼m saklanan state'lere uygular. */
  setTheme(theme: Theme): void {
    if (theme === this.#theme) return;
    this.#theme = theme;
    if (this.#view === null) return;
    const effect = this.#themeCompartment.reconfigure(editorThemeExtension(theme));
    for (const [tabId, state] of this.#states) {
      if (tabId === this.#activeId) continue;
      this.#states.set(tabId, state.update({ effects: effect }).state);
    }
    this.#view.dispatch({ effects: effect });
  }

  /**
   * Salt-okunur kipi tÃ¼m state'lere uygular. "Eksik dosya" sekmesinde iÃ§erik
   * korunur ama dÃ¼zenlenemez; sekme yeniden konumlandÄ±rÄ±lÄ±nca kip kalkar.
   */
  setReadOnly(readOnly: boolean): void {
    if (readOnly === this.#readOnly) return;
    this.#readOnly = readOnly;
    if (this.#view === null) return;
    const effect = this.#readOnlyCompartment.reconfigure(readOnlyExtensions(readOnly));
    for (const [tabId, state] of this.#states) {
      if (tabId === this.#activeId) continue;
      this.#states.set(tabId, state.update({ effects: effect }).state);
    }
    this.#view.dispatch({ effects: effect });
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  /**
   * Ctrl+B: seÃ§imi/kelimeyi `**` ile sarar veya sardÄ±ysa Ã§Ã¶zer. Salt-okunur
   * kipte deÄŸiÅŸiklik yapÄ±lmaz; iÅŸlendi bilgisi dÃ¶ner.
   */
  toggleBold(): boolean {
    const view = this.#view;
    if (view === null || this.#readOnly) return false;
    const text = view.state.doc.toString();
    view.dispatch(
      view.state.changeByRange((range) => {
        const edit = computeBoldEdit(text, range.from, range.to);
        return {
          changes: edit.changes,
          range: EditorSelection.range(edit.anchor, edit.head),
        };
      }),
    );
    view.focus();
    return true;
  }

  /** Ctrl+F: CodeMirror arama panelini aÃ§ar ve odaÄŸÄ± editÃ¶re verir. */
  openSearch(): boolean {
    const view = this.#view;
    if (view === null) return false;
    view.focus();
    openSearchPanel(view);
    return true;
  }

  /** Etkin sekme kalmadÄ±ÄŸÄ±nda gÃ¶rÃ¼nÃ¼mÃ¼ boÅŸaltÄ±r. */
  close(): void {
    this.#activeId = null;
    if (this.#view === null) return;
    this.#view.setState(this.#createState(''));
  }

  /** GÃ¶rÃ¼nÃ¼mÃ¼ yok eder; sekme state'leri de bÄ±rakÄ±lÄ±r. */
  destroy(): void {
    this.#view?.destroy();
    this.#view = null;
    this.#states.clear();
    this.#activeId = null;
  }

  #createState(doc: string): EditorState {
    return measurePerf('create-state', () =>
      EditorState.create({ doc, extensions: this.#extensions() }),
    );
  }

  #replaceDocument(state: EditorState, contents: string): EditorState {
    return measurePerf('replace-document', () =>
      state.update({
        changes: { from: 0, to: state.doc.length, insert: contents },
        selection: clampSelection(state.selection, contents.length),
        // Arka plandaki sekmenin diskten yenilenmesi de geri alma geÃ§miÅŸine
        // yazÄ±lmaz; tam belge kopyasÄ± orada da birikmemeli.
        annotations: Transaction.addToHistory.of(false),
      }).state,
    );
  }

  #extensions() {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history({ minDepth: UNDO_HISTORY_DEPTH }),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      bracketMatching(),
      indentOnInput(),
      markdown(),
      search({ top: true }),
      EditorView.lineWrapping,
      this.#themeCompartment.of(editorThemeExtension(this.#theme)),
      this.#readOnlyCompartment.of(readOnlyExtensions(this.#readOnly)),
      scrollPositionExtension(),
      keymap.of([
        // Mod-s ve Mod-f merkezi kÄ±sayol katmanÄ±nda (`app/shortcuts.ts`)
        // yÃ¶netilir; burada tekrar baÄŸlanmaz.
        ...historyKeymap,
        ...searchKeymap.filter((binding) => binding.key !== 'Mod-f'),
        ...defaultKeymap,
        indentWithTab,
      ]),
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown editÃ¶rÃ¼' }),
      EditorView.updateListener.of(this.#onUpdate),
    ];
  }

  #onUpdate = (update: ViewUpdate): void => {
    const tabId = this.#activeId;
    if (tabId === null) return;
    // SeÃ§im deÄŸiÅŸimi de state'in parÃ§asÄ±dÄ±r (imleÃ§ konumu); her gÃ¼ncellemede
    // tazelenir, bÃ¶ylece sekmeye dÃ¶nÃ¼ÅŸte imleÃ§ aynÄ± yere dÃ¶ner.
    this.#states.set(tabId, update.state);
    const main = update.state.selection.main;
    this.#callbacks.onViewState?.(tabId, {
      cursor: { anchor: main.anchor, head: main.head },
      scroll: readScrollPosition(update.state),
    });
    if (!update.docChanged) return;
    this.#callbacks.onChange?.(
      tabId,
      update.state.doc.toString(),
      this.#applyingExternal ? 'external' : 'user',
    );
  };
}
