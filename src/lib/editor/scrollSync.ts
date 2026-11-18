/**
 * Bölünmüş modda oransal, çift yönlü kaydırma eşitlemesi.
 *
 * İki taraf birbirini kaydırdığı için naif bir dinleyici sonsuz salınım üretir:
 * A kaydırır → B kaydırılır → B'nin scroll olayı A'yı yeniden kaydırır. Geri
 * besleme kilidi bunu engeller: programatik yazımdan **önce** ilgili tarafın
 * kilidi açılır ve bir sonraki karede (rAF) kapanır. Tarayıcı scroll olayını
 * kare çiziminden önce gönderdiği için yankı olayı yok sayılır; kullanıcı
 * kaydırması ise kilitten sonra normal işlenir.
 *
 * Oran `scrollTop / (scrollHeight - clientHeight)` ile hesaplanır; hedef
 * görünümün kendi kaydırma aralığına ölçeklenir. Kaydırma aralığı olmayan
 * taraf için hedef 0'dır.
 */

/** Eşitlemenin ihtiyaç duyduğu en küçük görünüm yüzeyi (testler sahte verebilir). */
export interface ScrollViewport {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  addEventListener(
    type: 'scroll',
    listener: () => void,
    options?: AddEventListenerOptions,
  ): void;
  removeEventListener(type: 'scroll', listener: () => void): void;
}

export type Scheduler = (callback: () => void) => void;

/** Önizlemede bir kaynak satırına bağlı bloğun kap içindeki üst konumu. */
export interface LineAnchor {
  line: number;
  top: number;
}

/**
 * Satır eşlemesi sunabilen kaydırma ucu.
 *
 * Editör ucu görünür alanın üstündeki satırı CodeMirror'dan okur; önizleme ucu
 * `data-source-line` taşıyan bloklardan üretilen bağlantılarla çalışır. Uç bu
 * iki metodu sunmuyorsa eşitleme oransal yola düşer.
 */
export interface LineSyncEndpoint extends ScrollViewport {
  /** Görünür alanın en üstündeki kaynak satırı (1 tabanlı, kesirli olabilir). */
  lineAtTop(): number;
  /** Verilen kaynak satırını görünür alanın en üstüne getirir. */
  scrollToLine(line: number): void;
}

/** Uç satır eşlemesi sunuyor mu? */
export function isLineSyncEndpoint(viewport: ScrollViewport): viewport is LineSyncEndpoint {
  const candidate = viewport as Partial<LineSyncEndpoint>;
  return (
    typeof candidate.lineAtTop === 'function' && typeof candidate.scrollToLine === 'function'
  );
}

/**
 * Bağlantıları satıra göre artan sıraya dizer ve aynı satırın tekrarını atar.
 * DOM'dan gelen liste güvenilmeyen veridir: sonlu olmayan değerler düşer.
 */
export function normalizeLineAnchors(anchors: readonly LineAnchor[]): LineAnchor[] {
  const sorted = [...anchors]
    .filter((anchor) => Number.isFinite(anchor.line) && Number.isFinite(anchor.top))
    .sort((a, b) => (a.line === b.line ? a.top - b.top : a.line - b.line));
  const result: LineAnchor[] = [];
  for (const anchor of sorted) {
    const last = result[result.length - 1];
    if (last !== undefined && last.line === anchor.line) continue;
    result.push({ line: anchor.line, top: anchor.top });
  }
  return result;
}

/** Verilen satırın hedef kap içindeki üst konumu; bağlantı yoksa `null`. */
export function topForLine(anchors: readonly LineAnchor[], line: number): number | null {
  if (anchors.length === 0) return null;
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (line <= first.line) return first.top;
  if (line >= last.line) return last.top;
  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1];
    const next = anchors[index];
    if (line > next.line) continue;
    const span = next.line - previous.line;
    if (span <= 0) return next.top;
    const ratio = (line - previous.line) / span;
    return previous.top + (next.top - previous.top) * ratio;
  }
  return last.top;
}

/** Verilen üst konumdaki kaynak satırı (kesirli); bağlantı yoksa `null`. */
export function lineForTop(anchors: readonly LineAnchor[], top: number): number | null {
  if (anchors.length === 0) return null;
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (top <= first.top) return first.line;
  if (top >= last.top) return last.line;
  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1];
    const next = anchors[index];
    if (top > next.top) continue;
    const span = next.top - previous.top;
    if (span <= 0) return next.line;
    const ratio = (top - previous.top) / span;
    return previous.line + (next.line - previous.line) * ratio;
  }
  return last.line;
}

/** Kare varsa rAF, yoksa makro görev; kilit her durumda çözülür. */
function defaultScheduler(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => callback());
    return;
  }
  setTimeout(callback, 0);
}

/** Kaynak konumunu hedef görünümün aralığına oransal olarak taşır. */
export function proportionalScrollTop(
  sourceTop: number,
  sourceScrollHeight: number,
  sourceClientHeight: number,
  targetScrollHeight: number,
  targetClientHeight: number,
): number {
  const sourceRange = sourceScrollHeight - sourceClientHeight;
  const targetRange = targetScrollHeight - targetClientHeight;
  if (sourceRange <= 0 || targetRange <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, sourceTop / sourceRange));
  return ratio * targetRange;
}

export class ScrollSyncController {
  #source: ScrollViewport | null = null;
  #target: ScrollViewport | null = null;
  #lockSource = false;
  #lockTarget = false;
  /**
   * Programatik yazımdan sonra hedefin beklenen konumu. Yankı olayı bir
   * sonraki karede de gelse bu değerle eşleştiği için yutulur; kilit yalnızca
   * aynı karedeki yankıyı değil, gecikmiş yankıyı da bu eşleşme durdurur.
   */
  #expectedSource: number | null = null;
  #expectedTarget: number | null = null;
  #scheduler: Scheduler;

  constructor(scheduler: Scheduler = defaultScheduler) {
    this.#scheduler = scheduler;
  }

  get attached(): boolean {
    return this.#source !== null;
  }

  /** İki görünümü bağlar; aynı çift yeniden bağlanmaz. */
  attach(source: ScrollViewport, target: ScrollViewport): void {
    if (this.#source === source && this.#target === target) return;
    this.detach();
    this.#source = source;
    this.#target = target;
    source.addEventListener('scroll', this.#onSourceScroll, { passive: true });
    target.addEventListener('scroll', this.#onTargetScroll, { passive: true });
  }

  detach(): void {
    this.#source?.removeEventListener('scroll', this.#onSourceScroll);
    this.#target?.removeEventListener('scroll', this.#onTargetScroll);
    this.#source = null;
    this.#target = null;
    this.#lockSource = false;
    this.#lockTarget = false;
    this.#expectedSource = null;
    this.#expectedTarget = null;
  }

  #onSourceScroll = (): void => {
    const source = this.#source;
    const target = this.#target;
    if (source === null || target === null) return;
    if (this.#consumeExpected('source', source) || this.#lockSource) return;
    this.#apply(source, target, 'target');
  };

  #onTargetScroll = (): void => {
    const source = this.#source;
    const target = this.#target;
    if (source === null || target === null) return;
    if (this.#consumeExpected('target', target) || this.#lockTarget) return;
    this.#apply(target, source, 'source');
  };

  /**
   * Kendi yazdığımız konuma dönen olayı ayıklar. Beklenti her olayda tüketilir:
   * konum eşleşmiyorsa bunu kullanıcı kaydırması sayar.
   */
  #consumeExpected(which: 'source' | 'target', viewport: ScrollViewport): boolean {
    const expected = which === 'source' ? this.#expectedSource : this.#expectedTarget;
    if (which === 'source') this.#expectedSource = null;
    else this.#expectedTarget = null;
    if (expected === null) return false;
    return Math.abs(viewport.scrollTop - expected) < 1.5;
  }

  #apply(from: ScrollViewport, to: ScrollViewport, lock: 'source' | 'target'): void {
    // Satır eşlemesi varsa kaynak görünür alanın üst satırı hedefte aynı satıra
    // taşınır; yoksa oransal konum kullanılır.
    if (isLineSyncEndpoint(from) && isLineSyncEndpoint(to)) {
      const line = from.lineAtTop();
      const before = to.scrollTop;
      this.#lock(lock);
      to.scrollToLine(line);
      // Hedef değişmediyse scroll olayı doğmaz; kilidi beklemeden bırak.
      if (Math.abs(to.scrollTop - before) < 0.5) {
        this.#unlock(lock);
        return;
      }
      // Gecikmiş yankı da ayıklansın diye yazdığımız konum beklenen olarak
      // işaretlenir; olay bir sonraki karede gelse bile eşleşir.
      this.#setExpected(lock, to.scrollTop);
      return;
    }
    const top = proportionalScrollTop(
      from.scrollTop,
      from.scrollHeight,
      from.clientHeight,
      to.scrollHeight,
      to.clientHeight,
    );
    // Hedef zaten bu konumdaysa scroll olayı doğmaz; kilit kurmaya gerek yok.
    if (Math.abs(to.scrollTop - top) < 0.5) return;
    this.#lock(lock);
    to.scrollTop = top;
  }

  #lock(which: 'source' | 'target'): void {
    if (which === 'source') this.#lockSource = true;
    else this.#lockTarget = true;
    this.#scheduler(() => this.#unlock(which));
  }

  #unlock(which: 'source' | 'target'): void {
    if (which === 'source') this.#lockSource = false;
    else this.#lockTarget = false;
  }

  #setExpected(which: 'source' | 'target', top: number): void {
    if (which === 'source') this.#expectedSource = top;
    else this.#expectedTarget = top;
  }
}
