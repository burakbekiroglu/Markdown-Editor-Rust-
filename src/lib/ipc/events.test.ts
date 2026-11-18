import { describe, expect, it, vi } from 'vitest';

import { subscribeEvent, type EventSubscriber } from './events';

interface Registered {
  event: string;
  handler: (event: { payload: unknown }) => void;
}

/** Sahte abone: kaydedilen işleyicileri testin elle tetiklemesine izin verir. */
function fakeSubscriber(): {
  subscriber: EventSubscriber;
  registered: Registered[];
  unlisten: ReturnType<typeof vi.fn>;
} {
  const registered: Registered[] = [];
  const unlisten = vi.fn();
  const subscriber: EventSubscriber = (event, handler) => {
    registered.push({ event, handler });
    return Promise.resolve(unlisten);
  };
  return { subscriber, registered, unlisten };
}

describe('subscribeEvent', () => {
  it('doğrulanmış yükü işleyiciye iletir', async () => {
    const { subscriber, registered } = fakeSubscriber();
    const handler = vi.fn();

    await subscribeEvent<string>(
      'test:event',
      (payload) => (typeof payload === 'string' ? payload : null),
      handler,
      subscriber,
    );

    expect(registered).toHaveLength(1);
    expect(registered[0]?.event).toBe('test:event');

    registered[0]?.handler({ payload: 'geçerli' });
    expect(handler).toHaveBeenCalledWith('geçerli');
  });

  it('geçersiz yükü işleyiciye hiç iletmez', async () => {
    const { subscriber, registered } = fakeSubscriber();
    const handler = vi.fn();

    await subscribeEvent<string>(
      'test:event',
      (payload) => (typeof payload === 'string' ? payload : null),
      handler,
      subscriber,
    );

    registered[0]?.handler({ payload: { bozuk: true } });
    registered[0]?.handler({ payload: null });

    expect(handler).not.toHaveBeenCalled();
  });

  it('unlisten fonksiyonunu olduğu gibi döndürür', async () => {
    const { subscriber, unlisten } = fakeSubscriber();

    const stop = await subscribeEvent<number>(
      'test:event',
      (payload) => (typeof payload === 'number' ? payload : null),
      () => {},
      subscriber,
    );

    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
