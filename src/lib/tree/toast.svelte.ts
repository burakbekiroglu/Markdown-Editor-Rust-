/**
 * Tek toast kanalı: tüm başarı/hata bildirimleri buradan geçer.
 */
export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const DISMISS_AFTER_MS = 5000;

class ToastStore {
  items = $state<Toast[]>([]);
  #nextId = 1;
  #timers = new Map<number, ReturnType<typeof setTimeout>>();

  push(kind: ToastKind, message: string): number {
    const id = this.#nextId++;
    this.items = [...this.items, { id, kind, message }];
    const timer = setTimeout(() => this.dismiss(id), DISMISS_AFTER_MS);
    this.#timers.set(id, timer);
    return id;
  }

  success(message: string): number {
    return this.push('success', message);
  }

  error(message: string): number {
    return this.push('error', message);
  }

  info(message: string): number {
    return this.push('info', message);
  }

  dismiss(id: number): void {
    const timer = this.#timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(id);
    }
    this.items = this.items.filter((item) => item.id !== id);
  }

  clear(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.items = [];
  }
}

export const toast = new ToastStore();
