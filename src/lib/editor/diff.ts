/**
 * Satır bazlı, salt okunur karşılaştırma.
 *
 * "Farkı Gör" disk içeriği (`before`) ile editör içeriğini (`after`) yan yana
 * göstermek için kullanılır; hiçbir içerik yazmaz veya değiştirmez.
 */

export type DiffLineKind = 'equal' | 'removed' | 'added';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Diskteki satır numarası (1 tabanlı); eklenen satırlarda `null`. */
  oldLine: number | null;
  /** Editördeki satır numarası (1 tabanlı); silinen satırlarda `null`. */
  newLine: number | null;
}

/** Çok büyük gövdelerde LCS tablosunun şişmemesi için hücre sınırı. */
const DEFAULT_MAX_CELLS = 4_000_000;

/**
 * Metni satırlara böler: CRLF/CR normalize edilir, tek bir sondaki satır sonu
 * yok sayılır (aksi halde her karşılaştırma hayalet boş satır üretirdi).
 */
export function toLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface Bounds {
  prefix: number;
  oldEnd: number;
  newEnd: number;
}

function commonBounds(oldLines: readonly string[], newLines: readonly string[]): Bounds {
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return { prefix, oldEnd, newEnd };
}

/** Editör diskten farklıysa en az bir `removed`/`added` satırı içerir. */
export function lineDiff(
  before: string,
  after: string,
  options: { maxCells?: number } = {},
): DiffLine[] {
  const oldLines = toLines(before);
  const newLines = toLines(after);
  const { prefix, oldEnd, newEnd } = commonBounds(oldLines, newLines);

  const result: DiffLine[] = [];
  for (let i = 0; i < prefix; i += 1) {
    result.push({ kind: 'equal', text: oldLines[i], oldLine: i + 1, newLine: i + 1 });
  }

  const oldMiddle = oldLines.slice(prefix, oldEnd);
  const newMiddle = newLines.slice(prefix, newEnd);

  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;
  const useTable = oldMiddle.length * newMiddle.length <= maxCells;

  const steps = useTable
    ? diffMiddle(oldMiddle, newMiddle)
    : [
        ...oldMiddle.map((text) => ({ kind: 'removed' as const, text })),
        ...newMiddle.map((text) => ({ kind: 'added' as const, text })),
      ];

  let oldNo = prefix + 1;
  let newNo = prefix + 1;
  for (const step of steps) {
    if (step.kind === 'equal') {
      result.push({ kind: 'equal', text: step.text, oldLine: oldNo, newLine: newNo });
      oldNo += 1;
      newNo += 1;
    } else if (step.kind === 'removed') {
      result.push({ kind: 'removed', text: step.text, oldLine: oldNo, newLine: null });
      oldNo += 1;
    } else {
      result.push({ kind: 'added', text: step.text, oldLine: null, newLine: newNo });
      newNo += 1;
    }
  }

  const suffixLength = oldLines.length - oldEnd;
  for (let i = 0; i < suffixLength; i += 1) {
    result.push({
      kind: 'equal',
      text: oldLines[oldEnd + i],
      oldLine: oldEnd + i + 1,
      newLine: newEnd + i + 1,
    });
  }

  return result;
}

function diffMiddle(
  oldLines: readonly string[],
  newLines: readonly string[],
): Array<{ kind: DiffLineKind; text: string }> {
  const width = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * width);

  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        oldLines[i] === newLines[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }

  const steps: Array<{ kind: DiffLineKind; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      steps.push({ kind: 'equal', text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      steps.push({ kind: 'removed', text: oldLines[i] });
      i += 1;
    } else {
      steps.push({ kind: 'added', text: newLines[j] });
      j += 1;
    }
  }
  while (i < oldLines.length) {
    steps.push({ kind: 'removed', text: oldLines[i] });
    i += 1;
  }
  while (j < newLines.length) {
    steps.push({ kind: 'added', text: newLines[j] });
    j += 1;
  }
  return steps;
}
