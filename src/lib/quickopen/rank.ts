/**
 * Ctrl+P sonuç sıralaması.
 *
 * Sonuç kümesi yalnızca dosyalardır (klasörler atlanır). Her dosya
 * `relativePath` üzerinden bulanık eşleştirilir; son kullanılan dosyalara
 * sıralamada ek puan verilir, böylece aynı sorguda yakın zamanda açılmış
 * dosya listenin başına çıkar. Skor eşitse yol alfabetik sıralanır.
 */
import { fuzzyMatch } from './fuzzy';

/** Sıralamaya girecek minimum alanlar. */
export interface RankableFile {
  name: string;
  relativePath: string;
  isDir: boolean;
}

export interface RankedFile<T extends RankableFile = RankableFile> {
  entry: T;
  score: number;
  /** `relativePath` içindeki eşleşen karakter konumları. */
  indices: number[];
}

/** Son kullanılan dosyaya verilen taban puan; sıra ilerledikçe azalır. */
export const RECENT_BONUS = 60;

export const DEFAULT_RESULT_LIMIT = 50;

export function rankFiles<T extends RankableFile>(
  entries: readonly T[],
  query: string,
  recent: readonly string[] = [],
  limit: number = DEFAULT_RESULT_LIMIT,
): RankedFile<T>[] {
  const recentRank = new Map<string, number>();
  recent.forEach((path, index) => {
    if (!recentRank.has(path)) recentRank.set(path, index);
  });

  const ranked: RankedFile<T>[] = [];
  for (const entry of entries) {
    if (entry.isDir) continue;
    const match = fuzzyMatch(query, entry.relativePath);
    if (match === null) continue;
    const rank = recentRank.get(entry.relativePath);
    const bonus = rank === undefined ? 0 : Math.max(RECENT_BONUS - rank, 1);
    ranked.push({ entry, score: match.score + bonus, indices: match.indices });
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.entry.relativePath.localeCompare(right.entry.relativePath);
  });

  return limit > 0 ? ranked.slice(0, limit) : ranked;
}
