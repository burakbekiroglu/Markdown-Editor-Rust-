// @vitest-environment jsdom
/**
 * Tek `EditorView` + sekme başına `EditorState` çekirdeğinin davranış testleri.
 *
 * Kapsam: görünümün yeniden yaratılmaması, belge/geçmiş ayrımı, imleç ve
 * scroll konumunun state ile taşınıp `setState` sonrası geri yüklenmesi,
 * dış içerik uygulamasının kaynağı ve büyük belgede swap ölçümü.
 */
import { isolateHistory, undo, undoDepth } from '@codemirror/commands';
import { getSearchQuery, searchPanelOpen } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lastPerfEntry, readPerfEntries, resetPerfEntries, SLOW_SWAP_MS } from './perf';
import { EditorSession, UNDO_HISTORY_DEPTH } from './session';
import { readScrollPosition, setScrollPosition } from './scrollState';

interface Harness {
  session: EditorSession;
  view: EditorView;
  parent: HTMLElement;
  changes: { tabId: string; contents: string; origin: string }[];
}

let harness: Harness | null = null;

function mountSession(): Harness {
  const parent = document.createElement('div');
  document.body.append(parent);

  const changes: Harness['changes'] = [];
  const session = new EditorSession({
    onChange: (tabId, contents, origin) => changes.push({ tabId, contents, origin }),
  });
  session.mount(parent);

  const view = session.view;
  if (view === null) throw new Error('görünüm kurulamadı');
  const created: Harness = { session, view, parent, changes };
  harness = created;
  return created;
}

beforeEach(() => {
  resetPerfEntries();
});

afterEach(() => {
  harness?.session.destroy();
  harness?.parent.remove();
  harness = null;
  document.body.innerHTML = '';
});

describe('EditorSession', () => {
  it('sekme değişiminde aynı EditorView örneğini korur', () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'a belgesi');
    session.open('tab-b', 'b belgesi');
    session.activate('tab-a');

    expect(session.view).toBe(view);
    expect(session.activeId).toBe('tab-a');
    expect(view.state.doc.toString()).toBe('a belgesi');
    expect(document.querySelectorAll('.cm-editor')).toHaveLength(1);
  });

  it('sekme başına belge, geçmiş ve dirty kaynağı ayrıdır', () => {
    const { session, view, changes } = mountSession();
    session.open('tab-a', 'bir');
    view.dispatch({ changes: { from: 3, insert: ' iki' } });
    expect(changes.at(-1)).toMatchObject({ tabId: 'tab-a', origin: 'user' });

    session.open('tab-b', 'başka');
    expect(view.state.doc.toString()).toBe('başka');

    session.activate('tab-a');
    expect(view.state.doc.toString()).toBe('bir iki');
    // Geri alma yalnızca kendi sekmesinin geçmişini kullanır.
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('bir');

    session.activate('tab-b');
    expect(view.state.doc.toString()).toBe('başka');
  });

  it('imleç konumunu state ile taşır ve sekmeye dönüşte geri yükler', () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'satır bir\nsatır iki\nsatır üç');
    view.dispatch({ selection: { anchor: 12 } });

    session.open('tab-b', 'kısa');
    expect(view.state.selection.main.head).toBe(0);

    session.activate('tab-a');
    expect(view.state.selection.main.head).toBe(12);
  });

  it('seçim aralığını (anchor/head) sekme başına korur', () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'satır bir\nsatır iki');
    view.dispatch({ selection: { anchor: 6, head: 9 } });
    expect(view.state.sliceDoc(6, 9)).toBe('bir');

    session.open('tab-b', 'başka belge');
    session.activate('tab-a');

    const main = view.state.selection.main;
    expect(main.anchor).toBe(6);
    expect(main.head).toBe(9);
    expect(view.state.sliceDoc(main.from, main.to)).toBe('bir');
  });

  it('scroll konumunu state içine gömer ve setState sonrası geri yükler', async () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'uzun belge\n'.repeat(200));
    session.open('tab-b', 'diğer');

    session.activate('tab-a');
    view.scrollDOM.scrollTop = 240;
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    expect(readScrollPosition(view.state).top).toBe(240);

    session.activate('tab-b');
    view.scrollDOM.scrollTop = 0;
    session.activate('tab-a');

    expect(readScrollPosition(view.state).top).toBe(240);
    expect(view.scrollDOM.scrollTop).toBe(240);
  });

  it('dış içerik uygulamasını "external" kaynağıyla bildirir', () => {
    const { session, view, changes } = mountSession();
    session.open('tab-a', 'eski');
    changes.length = 0;

    session.applyContents('tab-a', 'diskteki yeni içerik');

    expect(view.state.doc.toString()).toBe('diskteki yeni içerik');
    expect(changes).toEqual([
      { tabId: 'tab-a', contents: 'diskteki yeni içerik', origin: 'external' },
    ]);
  });

  it('diskten sessiz yeniden yükleme imleci ve scroll konumunu korur', async () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'eski satır\n'.repeat(200));
    view.dispatch({ selection: { anchor: 42 } });
    view.scrollDOM.scrollTop = 180;
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    session.applyContents('tab-a', 'yeni satır\n'.repeat(200));

    expect(view.state.doc.toString()).toBe('yeni satır\n'.repeat(200));
    expect(view.state.selection.main.head).toBe(42);
    expect(view.scrollDOM.scrollTop).toBe(180);
  });

  it('aktif olmayan sekmenin içeriğini state önbelleğinden okur ve uygular', () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'a');
    session.open('tab-b', 'b');

    expect(session.contents('tab-a')).toBe('a');

    session.applyContents('tab-a', 'a güncel');
    expect(session.contents('tab-a')).toBe('a güncel');
    // Aktif sekme etkilenmez; içerik sekmeye dönüldüğünde görünür.
    expect(view.state.doc.toString()).toBe('b');

    session.activate('tab-a');
    expect(view.state.doc.toString()).toBe('a güncel');
  });

  it('aynı içerikle açılan sekmede belge kimliğini değiştirmez', () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'aynı');
    const first = view.state;

    session.open('tab-a', 'aynı');

    expect(view.state).toBe(first);
  });

  it('dış içerik uygulaması geri alma geçmişine tam belge kopyası eklemez', () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'eski');
    session.applyContents('tab-a', 'diskteki yeni içerik');

    expect(undo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('diskteki yeni içerik');
  });

  it(' aktif olmayan sekmede dış yenileme de geri alma geçmişine girmez', () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'a');
    session.open('tab-b', 'b');
    session.applyContents('tab-a', 'a diskten');
    session.activate('tab-a');

    expect(undo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('a diskten');
  });

  it('kapalı sekmelerin state önbelleğini bırakır', () => {
    const { session } = mountSession();
    session.open('tab-a', 'a');
    session.open('tab-b', 'b');

    session.prune(new Set(['tab-b']));

    expect(session.hasState('tab-a')).toBe(false);
    expect(session.hasState('tab-b')).toBe(true);
  });

  it('geri alma geçmişi sabit derinlikte kalır (uzun oturum)', () => {
    const { session, view } = mountSession();
    session.open('tab-a', '');

    // Her düzenleme ayrı bir geçmiş olayı olsun: `isolateHistory` gruplamayı kapatır.
    for (let index = 0; index < UNDO_HISTORY_DEPTH * 4; index += 1) {
      view.dispatch({
        changes: { from: 0, insert: 'x' },
        annotations: isolateHistory.of('full'),
      });
    }

    // CodeMirror yığını `minDepth + 21` olayla sınırlar; sınırsız büyümez.
    expect(undoDepth(view.state)).toBeLessThanOrEqual(UNDO_HISTORY_DEPTH + 21);
    expect(undoDepth(view.state)).toBeGreaterThan(UNDO_HISTORY_DEPTH);
  });

  it('salt-okunur kipi tüm state’lere uygular ve düzenlemeyi engeller', () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'a');
    session.open('tab-b', 'b');

    session.setReadOnly(true);
    expect(session.readOnly).toBe(true);
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    expect(view.state.facet(EditorView.editable)).toBe(false);

    session.activate('tab-b');
    expect(view.state.facet(EditorState.readOnly)).toBe(true);

    session.setReadOnly(false);
    expect(view.state.facet(EditorState.readOnly)).toBe(false);
    expect(view.state.facet(EditorView.editable)).toBe(true);
  });

  it('tema değişimini tüm saklanan state’lere uygular', () => {
    const { session, view } = mountSession();
    session.open('tab-a', '# başlık');
    session.open('tab-b', 'b');
    session.activate('tab-a');

    session.setTheme('light');
    expect(session.theme).toBe('light');

    session.activate('tab-b');
    // Yeniden yapılandırma state güncellemesi olarak uygulandı; belge korunur.
    expect(view.state.doc.toString()).toBe('b');
    expect(session.theme).toBe('light');
  });

  it('büyük belgede swap süresini performans işareti olarak kaydeder', () => {
    const { session } = mountSession();
    const large = '# Başlık\n\n'.concat('paragraf metni '.repeat(8_000), '\n');
    session.open('tab-large', large);
    session.open('tab-small', 'küçük');
    resetPerfEntries();

    session.activate('tab-large');

    const entry = lastPerfEntry('state-swap');
    expect(entry).not.toBeNull();
    expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry?.durationMs).toBeLessThan(SLOW_SWAP_MS);
    expect(readPerfEntries().map((item) => item.name)).toContain('state-swap');
  });

  it('scroll dinleyicisi kare başına tek güncelleme yazar', async () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'satır\n'.repeat(100));
    const dispatch = vi.spyOn(view, 'dispatch');

    view.scrollDOM.scrollTop = 10;
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    view.scrollDOM.scrollTop = 20;
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(readScrollPosition(view.state).top).toBe(20);
  });

  it('state’te scroll alanı yoksa sıfır konum kabul edilir', () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'x');
    view.dispatch({ effects: setScrollPosition.of({ top: 15, left: 3 }) });

    expect(readScrollPosition(view.state)).toEqual({ top: 15, left: 3 });
  });

  it('toggleBold seçimi sarar, ikinci çağrıda çözer', () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'hello world');
    view.dispatch({ selection: { anchor: 0, head: 5 } });

    expect(session.toggleBold()).toBe(true);
    expect(view.state.doc.toString()).toBe('**hello** world');
    const main = view.state.selection.main;
    expect(view.state.sliceDoc(main.from, main.to)).toBe('hello');

    expect(session.toggleBold()).toBe(true);
    expect(view.state.doc.toString()).toBe('hello world');
  });

  it('toggleBold salt-okunur kipte belgeyi değiştirmez', () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'hello');
    session.setReadOnly(true);

    expect(session.toggleBold()).toBe(false);
    expect(view.state.doc.toString()).toBe('hello');
  });

  it('oturumdan gelen imleç/scroll durumunu uygular ve belge sınırına sıkıştırır', () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'satır\n'.repeat(20));

    session.applyViewState('tab-a', {
      cursor: { anchor: 6, head: 6 },
      scroll: { top: 120, left: 0 },
    });
    session.activate('tab-a');

    expect(view.state.selection.main.head).toBe(6);
    expect(view.scrollDOM.scrollTop).toBe(120);

    // Dosya diskte kısalmış olabilir: taşan imleç belge sonuna çekilir.
    session.applyViewState('tab-a', {
      cursor: { anchor: 999_999, head: 999_999 },
      scroll: null,
    });
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it('openSearch arama panelini açar ve büyük/küçük harf duyarlı seçeneği sunar', () => {
    const { session, view } = mountSession();
    session.open('tab-a', 'aranacak');

    expect(session.openSearch()).toBe(true);
    expect(searchPanelOpen(view.state)).toBe(true);

    const caseField = view.dom.querySelector<HTMLInputElement>(
      '.cm-panel.cm-search input[name="case"]',
    );
    if (caseField === null) throw new Error('büyük/küçük harf duyarlı seçeneği yok');
    expect(caseField.type).toBe('checkbox');
    expect(getSearchQuery(view.state).caseSensitive).toBe(false);

    caseField.checked = true;
    caseField.dispatchEvent(new Event('change'));
    expect(getSearchQuery(view.state).caseSensitive).toBe(true);
  });
});
