/**
 * Çalışma köküne göreli yollar için yardımcılar.
 * Göreli yollar her zaman `/` ayırıcısı ile tutulur, kök `''` ile temsil edilir.
 */

export function splitRel(path: string): string[] {
  return path.split('/').filter((part) => part.length > 0);
}

export function joinRel(parent: string, name: string): string {
  const base = parent.replace(/\/+$/, '');
  return base.length === 0 ? name : `${base}/${name}`;
}

export function parentOf(path: string): string {
  const parts = splitRel(path);
  parts.pop();
  return parts.join('/');
}

export function nameOf(path: string): string {
  const parts = splitRel(path);
  return parts[parts.length - 1] ?? '';
}

export function isSameOrInside(path: string, prefix: string): boolean {
  if (prefix.length === 0) return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Bir klasör yeniden adlandırıldığında altındaki yolların önekini değiştirir.
 */
export function replacePathPrefix(path: string, oldPrefix: string, newPrefix: string): string {
  if (!isSameOrInside(path, oldPrefix)) return path;
  if (oldPrefix.length === 0) return path;
  if (path === oldPrefix) return newPrefix;
  return `${newPrefix}${path.slice(oldPrefix.length)}`;
}
