/**
 * Ctrl+B davranışının saf çekirdeği.
 *
 * Seçim varsa `**` ile sarılır; zaten `**` ile çevriliyse sarma kaldırılır.
 * Seçim yoksa imlecin bulunduğu kelime genişletilip sarılır; kelime yoksa
 * imleç `****` çiftinin ortasına yerleştirilir. Konumlar **değişiklik
 * öncesi** belge koordinatlarıdır; `anchor`/`head` ise değişiklik sonrası
 * yeni seçimi gösterir.
 */

export interface BoldEdit {
  changes: { from: number; to: number; insert: string };
  /** Değişiklik sonrası seçim başı. */
  anchor: number;
  /** Değişiklik sonrası seçim sonu. */
  head: number;
}

const MARKER = '**';

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char);
}

/** `pos` çevresindeki kelimenin sınırlarını döner; kelime yoksa ikisi eşittir. */
export function expandWord(text: string, pos: number): { start: number; end: number } {
  let start = pos;
  let end = pos;
  while (start > 0 && isWordChar(text[start - 1])) start -= 1;
  while (end < text.length && isWordChar(text[end])) end += 1;
  return { start, end };
}

/** Sarılı seçimi (dış `**` çifti) çözer. */
function unwrapOuter(from: number, to: number, inner: string): BoldEdit {
  return {
    changes: { from: from - MARKER.length, to: to + MARKER.length, insert: inner },
    anchor: from - MARKER.length,
    head: to - MARKER.length,
  };
}

/** Seçimdeki `**` çiftini çözer. */
function unwrapSelected(from: number, to: number, inner: string): BoldEdit {
  return {
    changes: { from, to, insert: inner },
    anchor: from,
    head: from + inner.length,
  };
}

/**
 * Verilen aralık için kalınlaştırma düzenlemesini üretir. Her zaman bir
 * değişiklik döner; aynı aralığa ikinci kez uygulamak seçimi geri alır.
 */
export function computeBoldEdit(text: string, from: number, to: number): BoldEdit {
  const hasSelection = from !== to;
  const start = hasSelection ? from : expandWord(text, from).start;
  const end = hasSelection ? to : expandWord(text, from).end;

  // Kelime yok ve seçim boş: imleç ortada olacak şekilde boş çift ekle.
  if (start === end) {
    return {
      changes: { from, to, insert: MARKER + MARKER },
      anchor: from + MARKER.length,
      head: from + MARKER.length,
    };
  }

  const selected = text.slice(start, end);
  const before = text.slice(Math.max(0, start - MARKER.length), start);
  const after = text.slice(end, end + MARKER.length);

  // Metin zaten dışarıdan `**` ile sarılı.
  if (before === MARKER && after === MARKER) {
    return unwrapOuter(start, end, selected);
  }

  // Seçim `**` işaretlerini kendisi içeriyor.
  if (
    selected.length > MARKER.length * 2 &&
    selected.startsWith(MARKER) &&
    selected.endsWith(MARKER)
  ) {
    return unwrapSelected(start, end, selected.slice(MARKER.length, -MARKER.length));
  }

  const wrapped = MARKER + selected + MARKER;
  return {
    changes: { from: start, to: end, insert: wrapped },
    anchor: start + MARKER.length,
    head: end + MARKER.length,
  };
}
