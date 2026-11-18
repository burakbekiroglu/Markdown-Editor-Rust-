import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionPersister, SAVE_DEBOUNCE_MS } from './persist';
import { createSessionData } from './schema';

function session(root: string) {
  return createSessionData({ root });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionPersister', () => {
  it('hızlı ardışık değişiklikleri tek yazmada birleştirir', async () => {
    const writes: string[] = [];
    const persister = new SessionPersister(async (json) => {
      writes.push(json);
    });

    persister.schedule(session('C:/bir'));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    persister.schedule(session('C:/iki'));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    expect(writes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]).root).toBe('C:/iki');
  });

  it('ayrı pencerelerdeki değişiklikleri ayrı ayrı yazar', async () => {
    const writes: string[] = [];
    const persister = new SessionPersister(async (json) => {
      writes.push(json);
    });

    persister.schedule(session('bir'));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    persister.schedule(session('iki'));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    expect(writes).toHaveLength(2);
  });

  it('flush beklemeden yazar ve zamanlayıcıyı iptal eder', async () => {
    const writes: string[] = [];
    const persister = new SessionPersister(async (json) => {
      writes.push(json);
    });

    persister.schedule(session('bir'));
    await persister.flush();
    expect(writes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(writes).toHaveLength(1);
  });

  it('yazmaları sıraya koyar; önceki bitmeden sonrakini başlatmaz', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writes: string[] = [];
    const persister = new SessionPersister(async (json) => {
      writes.push(json);
      await gate;
    });

    persister.schedule(session('bir'));
    const first = persister.flush();
    persister.schedule(session('iki'));
    const second = persister.flush();

    await Promise.resolve();
    expect(writes).toHaveLength(1);
    release();
    await first;
    await second;

    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1]).root).toBe('iki');
  });

  it('yazma hatasını bildirir ama zinciri kilitlemez', async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const persister = new SessionPersister(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('disk dolu');
      },
      { onError: (error) => errors.push(error) },
    );

    persister.schedule(session('bir'));
    await persister.flush();
    persister.schedule(session('iki'));
    await persister.flush();

    expect(errors).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it('cancel bekleyen yazmayı düşürür', async () => {
    const writes: string[] = [];
    const persister = new SessionPersister(async (json) => {
      writes.push(json);
    });

    persister.schedule(session('bir'));
    persister.cancel();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    expect(writes).toHaveLength(0);
  });
});
