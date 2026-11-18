import { describe, expect, it } from 'vitest';

import {
  ScrollSyncController,
  lineForTop,
  normalizeLineAnchors,
  proportionalScrollTop,
  topForLine,
  type LineAnchor,
  type LineSyncEndpoint,
  type ScrollViewport,
} from './scrollSync';

/**
 * Gerçek DOM olmadan `scrollTop` yazımını scroll olayı olarak yayan sahte
 * görünüm. Tarayıcıda olay bir sonraki karede gelir; burada eşzamanlı
 * yayınlanır, böylece kilit yankıyı gerçekten bastırıyor mu görülür.
 */
class FakeViewport implements ScrollViewport {
  #top = 0;
  #listeners = new Set<() => void>();

  constructor(
    readonly scrollHeight: number,
    readonly clientHeight: number,
  ) {}

  get scrollTop(): number {
    return this.#top;
  }

  set scrollTop(value: number) {
    if (value === this.#top) return;
    this.#top = value;
    for (const listener of [...this.#listeners]) listener();
  }

  addEventListener(_type: 'scroll', listener: () => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: 'scroll', listener: () => void): void {
    this.#listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

function manualScheduler(): { schedule: (cb: () => void) => void; flush: () => void } {
  const queue: (() => void)[] = [];
  return {
    schedule: (cb) => queue.push(cb),
    flush: () => {
      while (queue.length > 0) queue.shift()?.();
    },
  };
}

describe('proportionalScrollTop', () => {
  it('kaynak oranını hedef aralığına ölçekler', () => {
    // Kaynak aralığı 800, %50 → hedef aralığı 1800'ün %50'si.
    expect(proportionalScrollTop(400, 1000, 200, 2000, 200)).toBe(900);
    expect(proportionalScrollTop(0, 1000, 200, 2000, 200)).toBe(0);
    expect(proportionalScrollTop(800, 1000, 200, 2000, 200)).toBe(1800);
  });

  it('kaydırma aralığı olmayan tarafta 0 döner', () => {
    expect(proportionalScrollTop(50, 400, 400, 2000, 200)).toBe(0);
    expect(proportionalScrollTop(50, 1000, 200, 300, 300)).toBe(0);
  });

  it('aralık dışı konumu kırpar', () => {
    expect(proportionalScrollTop(-40, 1000, 200, 2000, 200)).toBe(0);
    expect(proportionalScrollTop(9999, 1000, 200, 2000, 200)).toBe(1800);
  });
});

describe('ScrollSyncController', () => {
  it('editör kaydırmasını önizlemeye oransal taşır', () => {
    const scheduler = manualScheduler();
    const controller = new ScrollSyncController(scheduler.schedule);
    const editor = new FakeViewport(1000, 200); // aralık 800
    const preview = new FakeViewport(2000, 200); // aralık 1800
    controller.attach(editor, preview);

    editor.scrollTop = 400;

    expect(preview.scrollTop).toBe(900);
    // Yankı olayı kilitle yutuldu; editör tekrar kaymadı.
    expect(editor.scrollTop).toBe(400);
    controller.detach();
  });

  it('önizleme kaydırmasını editöre oransal taşır', () => {
    const scheduler = manualScheduler();
    const controller = new ScrollSyncController(scheduler.schedule);
    const editor = new FakeViewport(1000, 200);
    const preview = new FakeViewport(2000, 200);
    controller.attach(editor, preview);

    preview.scrollTop = 1800;

    expect(editor.scrollTop).toBe(800);
    expect(preview.scrollTop).toBe(1800);
    controller.detach();
  });

  it('kilit çözüldükten sonra karşı yön yeniden çalışır (salınım yok)', () => {
    const scheduler = manualScheduler();
    const controller = new ScrollSyncController(scheduler.schedule);
    const editor = new FakeViewport(1000, 200);
    const preview = new FakeViewport(2000, 200);
    controller.attach(editor, preview);

    editor.scrollTop = 400;
    expect(preview.scrollTop).toBe(900);
    scheduler.flush();

    // Kullanıcı şimdi önizlemeyi kaydırır; editör yeniden eşitlenir.
    preview.scrollTop = 0;
    expect(editor.scrollTop).toBe(0);
    scheduler.flush();

    editor.scrollTop = 800;
    expect(preview.scrollTop).toBe(1800);
    controller.detach();
  });

  it('programatik yazım yankı üretip geri sıçrama yapmaz', () => {
    const scheduler = manualScheduler();
    const controller = new ScrollSyncController(scheduler.schedule);
    const editor = new FakeViewport(1000, 200);
    const preview = new FakeViewport(2000, 200);
    controller.attach(editor, preview);

    // Önizlemenin scroll olayı eşzamanlı gelse bile editörü 400'e geri itmez.
    editor.scrollTop = 400;
    scheduler.flush();
    expect(editor.scrollTop).toBe(400);
    expect(preview.scrollTop).toBe(900);
    controller.detach();
  });

  it('detach dinleyicileri kaldırır ve eşitlemeyi durdurur', () => {
    const scheduler = manualScheduler();
    const controller = new ScrollSyncController(scheduler.schedule);
    const editor = new FakeViewport(1000, 200);
    const preview = new FakeViewport(2000, 200);
    controller.attach(editor, preview);
    expect(controller.attached).toBe(true);

    controller.detach();
    expect(controller.attached).toBe(false);
    expect(editor.listenerCount).toBe(0);
    expect(preview.listenerCount).toBe(0);

    editor.scrollTop = 400;
    expect(preview.scrollTop).toBe(0);
    scheduler.flush();
  });

  it('aynı çift yeniden bağlanınca dinleyici çoğaltmaz', () => {
    const scheduler = manualScheduler();
    const controller = new ScrollSyncController(scheduler.schedule);
    const editor = new FakeViewport(1000, 200);
    const preview = new FakeViewport(2000, 200);
    controller.attach(editor, preview);
    controller.attach(editor, preview);

    expect(editor.listenerCount).toBe(1);
    editor.scrollTop = 400;
    expect(preview.scrollTop).toBe(900);
    controller.detach();
  });
});

describe('satır eşlemesi yardımcıları', () => {
  const anchors: LineAnchor[] = [
    { line: 1, top: 0 },
    { line: 10, top: 300 },
    { line: 20, top: 600 },
  ];

  it('bağlantıları satıra göre sıralar ve tekrarı atar', () => {
    const normalized = normalizeLineAnchors([
      { line: 20, top: 600 },
      { line: 1, top: 0 },
      { line: 10, top: 300 },
      { line: 10, top: 320 },
      { line: Number.NaN, top: 10 },
    ]);
    expect(normalized).toEqual(anchors);
  });

  it('satırı konuma, konumu satıra çevirir', () => {
    expect(topForLine(anchors, 1)).toBe(0);
    expect(topForLine(anchors, 10)).toBe(300);
    expect(topForLine(anchors, 20)).toBe(600);
    // 5. satır 1 ile 10 arasında yarı yoldadır.
    expect(topForLine(anchors, 5.5)).toBeCloseTo(150, 6);
    // Aralık dışı satırlar uçlara kırpılır.
    expect(topForLine(anchors, -3)).toBe(0);
    expect(topForLine(anchors, 99)).toBe(600);

    expect(lineForTop(anchors, 0)).toBe(1);
    expect(lineForTop(anchors, 450)).toBe(15);
    expect(lineForTop([], 120)).toBeNull();
    expect(topForLine([], 4)).toBeNull();
  });
});

/** Satır eşlemesi sunan sahte uç: konum ↔ satır dönüşümü bağlantılardan gelir. */
class FakeLineViewport extends FakeViewport implements LineSyncEndpoint {
  readonly anchors: LineAnchor[];

  constructor(scrollHeight: number, clientHeight: number, anchors: LineAnchor[]) {
    super(scrollHeight, clientHeight);
    this.anchors = anchors;
  }

  lineAtTop(): number {
    return lineForTop(this.anchors, this.scrollTop) ?? 1;
  }

  scrollToLine(line: number): void {
    this.scrollTop = topForLine(this.anchors, line) ?? 0;
  }
}

describe('ScrollSyncController satır eşlemesi', () => {
  const editorAnchors: LineAnchor[] = [
    { line: 1, top: 0 },
    { line: 10, top: 100 },
    { line: 20, top: 200 },
  ];
  const previewAnchors: LineAnchor[] = [
    { line: 1, top: 0 },
    { line: 10, top: 300 },
    { line: 20, top: 600 },
  ];

  it('editörün üst satırını önizlemede aynı satıra taşır', () => {
    const scheduler = manualScheduler();
    const controller = new ScrollSyncController(scheduler.schedule);
    const editor = new FakeLineViewport(1000, 200, editorAnchors);
    const preview = new FakeLineViewport(2000, 200, previewAnchors);
    controller.attach(editor, preview);

    editor.scrollTop = 100; // 10. satır
    expect(preview.scrollTop).toBe(300);
    // Yankı yutuldu: editör kaymadı.
    expect(editor.scrollTop).toBe(100);
    scheduler.flush();
    expect(editor.scrollTop).toBe(100);
    controller.detach();
  });

  it('önizleme kaydırmasını editörde aynı satıra taşır ve salınım yapmaz', () => {
    const scheduler = manualScheduler();
    const controller = new ScrollSyncController(scheduler.schedule);
    const editor = new FakeLineViewport(1000, 200, editorAnchors);
    const preview = new FakeLineViewport(2000, 200, previewAnchors);
    controller.attach(editor, preview);

    preview.scrollTop = 601; // 20. satırdan sonrası
    expect(editor.scrollTop).toBe(200);
    scheduler.flush();
    // Kilit çözüldükten sonra da yankı yok.
    expect(preview.scrollTop).toBe(601);
    controller.detach();
  });
});
