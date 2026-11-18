/**
 * Oturum geri yükleme planı.
 *
 * Saf tutulur: hangi yolun diskte olduğu bir yoklama fonksiyonuyla sorulur.
 * Böylece "diskte artık olmayan dosya geri yüklenmez, kullanıcıya bilgi
 * verilir" kuralı gerçek dosya sistemi olmadan test edilebilir.
 */
import type { SessionData } from './schema';

export interface RestoredTab {
  path: string;
}

export interface RestorePlan {
  root: string;
  /** Diskte bulunan, sırası korunmuş sekmeler. */
  tabs: RestoredTab[];
  activePath: string | null;
  /** Diskte artık bulunmayan ve atlanan sekmelerin yolları (sıra korunur). */
  missing: string[];
}

/** Diskte bulunma yoklaması; `true` = okunabilir dosya var. */
export type ExistsProbe = (path: string) => Promise<boolean>;

/** Bildirimde adı geçecek en fazla dosya; uzun listeler tek satırda kesilir. */
export const MAX_LISTED_MISSING = 3;

/**
 * Her sekmeyi sırayla yoklar. Diskte bulunmayan yollar geri yükleme
 * listesinden çıkarılır ve `missing` içinde toplanır: var olmayan bir dosya
 * için salt-okunur sekme açmak yerine kullanıcıya bilgi bildirimi gösterilir.
 */
export async function planRestore(
  data: SessionData,
  exists: ExistsProbe,
): Promise<RestorePlan> {
  const probes = await Promise.all(
    data.tabs.map(async (tab) => ({ path: tab.path, exists: await exists(tab.path) })),
  );
  const tabs = probes.filter((probe) => probe.exists).map((probe) => ({ path: probe.path }));
  const missing = probes.filter((probe) => !probe.exists).map((probe) => probe.path);
  const activePath =
    data.activePath !== null && tabs.some((tab) => tab.path === data.activePath)
      ? data.activePath
      : (tabs[0]?.path ?? null);
  return { root: data.root, tabs, activePath, missing };
}

/**
 * Atlanan sekmeler için kullanıcıya gösterilecek tek satırlık bilgi metni.
 * Liste boşsa boş dize döner; çağıran bildirimi yalnızca doluysa gösterir.
 */
export function describeSkippedTabs(missing: readonly string[]): string {
  if (missing.length === 0) return '';
  const shown = missing.slice(0, MAX_LISTED_MISSING).join(', ');
  const rest = missing.length - MAX_LISTED_MISSING;
  const suffix = rest > 0 ? ` ve ${rest} dosya daha` : '';
  return `${missing.length} dosya artık bulunamadığı için açılmadı: ${shown}${suffix}`;
}
