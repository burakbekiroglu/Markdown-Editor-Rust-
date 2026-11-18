import { describe, expect, it, vi } from 'vitest';

import { describeAppError } from '../ipc/errors';
import {
  installGlobalErrorHandlers,
  type GlobalErrorEvent,
  type GlobalErrorTarget,
} from './globalErrors';

/** Dinleyicileri elle tutan sahte hedef: DOM olmadan olay akışı sınanır. */
function createTarget() {
  const listeners = new Map<string, Set<(event: GlobalErrorEvent) => void>>();
  const target: GlobalErrorTarget = {
    addEventListener(type, handler) {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(handler);
      listeners.set(type, handlers);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
  };
  return {
    target,
    emit(type: string, event: GlobalErrorEvent) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function event(overrides: Partial<GlobalErrorEvent> = {}): GlobalErrorEvent {
  return { preventDefault: vi.fn(), ...overrides };
}

describe('installGlobalErrorHandlers', () => {
  it('yakalanmamış promise reddini nedenini koruyarak bildirir', () => {
    const { target, emit } = createTarget();
    const report = vi.fn();
    installGlobalErrorHandlers(target, report);

    const rejection = event({ reason: { code: 'NotFound', message: 'notlar.md' } });
    emit('unhandledrejection', rejection);

    expect(report).toHaveBeenCalledWith({ code: 'NotFound', message: 'notlar.md' });
    expect(rejection.preventDefault).toHaveBeenCalledOnce();
  });

  it('error olayında hata nesnesini mesaja tercih eder', () => {
    const { target, emit } = createTarget();
    const report = vi.fn();
    installGlobalErrorHandlers(target, report);

    const failure = new Error('bileşen çöktü');
    emit('error', event({ error: failure, message: 'Script error.' }));

    expect(report).toHaveBeenCalledWith(failure);
  });

  it('kaynak yükleme hatasında serbest metin mesajı bildirir', () => {
    const { target, emit } = createTarget();
    const report = vi.fn();
    installGlobalErrorHandlers(target, report);

    emit('error', event({ error: null, message: 'stil dosyası yüklenemedi' }));

    expect(report).toHaveBeenCalledWith('stil dosyası yüklenemedi');
  });

  it('ayrıntısı olmayan error olayını gürültü yapmadan atlar', () => {
    const { target, emit } = createTarget();
    const report = vi.fn();
    installGlobalErrorHandlers(target, report);

    const empty = event({ error: null, message: '   ' });
    emit('error', empty);

    expect(report).not.toHaveBeenCalled();
    expect(empty.preventDefault).not.toHaveBeenCalled();
  });

  it('kaldırma fonksiyonu iki dinleyiciyi de söker', () => {
    const { target, emit, count } = createTarget();
    const report = vi.fn();
    const dispose = installGlobalErrorHandlers(target, report);

    expect(count('unhandledrejection')).toBe(1);
    expect(count('error')).toBe(1);

    dispose();
    emit('unhandledrejection', event({ reason: 'geç' }));

    expect(count('unhandledrejection')).toBe(0);
    expect(count('error')).toBe(0);
    expect(report).not.toHaveBeenCalled();
  });

  it('bildirilen ham değer Türkçe ve eylem odaklı metne dönüşür', () => {
    const { target, emit } = createTarget();
    const messages: string[] = [];
    installGlobalErrorHandlers(target, (error) => messages.push(describeAppError(error)));

    emit('unhandledrejection', event({ reason: { code: 'PermissionDenied', message: 'a.md' } }));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Erişim reddedildi');
    expect(messages[0]).toContain('izinlerini kontrol edip yeniden deneyin');
  });
});
