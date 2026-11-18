/**
 * Bulanık dosya eşleştirmesinin saf çekirdeği (Ctrl+P paneli).
 *
 * Sorgu, hedefin alt dizisi olarak (harf sırası korunarak) aranır. Skor;
 * ardışık eşleşme, kelime/segment başı, erken konum ve tam alt dizi
 * eşleşmesinden beslenir; uzun yollar hafifçe cezalandırılır. Dönen
 * `indices` vurgulama için hedefteki eşleşen karakter konumlarıdır.
 */

export interface FuzzyMatch {
  score: number;
  indices: number[];
}

export interface HighlightSegment {
  text: string;
  matched: boolean;
}

const WORD_SEPARATOR = /[\\/_.\-\s]/;

function isBoundary(target: string, index: number): boolean {
  if (index === 0) return true;
  const previous = target[index - 1];
  if (WORD_SEPARATOR.test(previous)) return true;
  const current = target[index];
  // camelCase sınırı: küçük harften büyük harfe geçiş.
  return (
    previous === previous.toLowerCase() &&
    previous !== previous.toUpperCase() &&
    current === current.toUpperCase() &&
    current !== current.toLowerCase()
  );
}

/**
 * `query` boşsa nötr skor döner (tüm dosyalar listelenir). Sorgunun
 * karakterleri sırayla bulunamazsa `null`.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return { score: 0, indices: [] };

  const lowerTarget = target.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let searchFrom = 0;
  let previousIndex = -1;

  for (const char of normalizedQuery) {
    const index = lowerTarget.indexOf(char, searchFrom);
    if (index === -1) return null;

    if (previousIndex >= 0) {
      score += index === previousIndex + 1 ? 8 : -Math.min(index - previousIndex - 1, 10);
    }
    if (index === 0) score += 6;
    if (isBoundary(target, index)) score += 12;

    indices.push(index);
    previousIndex = index;
    searchFrom = index + 1;
  }

  // Tam alt dizi eşleşmesi güçlü bir sinyaldir; sorgu uzadıkça daha anlamlı.
  if (lowerTarget.includes(normalizedQuery)) score += 20 + normalizedQuery.length * 10;
  score -= Math.floor(target.length / 20);

  return { score, indices };
}

/** Eşleşen konumları ardışık parçalara böler; panel vurgulama için kullanır. */
export function highlightSegments(
  text: string,
  indices: readonly number[],
): HighlightSegment[] {
  const matched = new Set(indices);
  const segments: HighlightSegment[] = [];
  let buffer = '';
  let bufferMatched = false;

  for (let index = 0; index < text.length; index += 1) {
    const isMatch = matched.has(index);
    if (buffer.length === 0) {
      buffer = text[index];
      bufferMatched = isMatch;
      continue;
    }
    if (isMatch === bufferMatched) {
      buffer += text[index];
      continue;
    }
    segments.push({ text: buffer, matched: bufferMatched });
    buffer = text[index];
    bufferMatched = isMatch;
  }

  if (buffer.length > 0) segments.push({ text: buffer, matched: bufferMatched });
  return segments;
}
