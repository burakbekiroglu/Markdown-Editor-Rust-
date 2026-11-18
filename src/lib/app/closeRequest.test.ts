import { describe, expect, it, vi } from 'vitest';

import {
  CLOSE_REQUESTED_EVENT,
  subscribeAppCloseRequested,
  type CloseRequestHandler,
  type CloseRequestSubscriber,
} from './closeRequest';

function fakeSubscriber(): {
  subscriber: CloseRequestSubscriber;
  emit: () => void;
  unlisten: ReturnType<typeof vi.fn>;
} {
  let handler: CloseRequestHandler | null = null;
  const unlisten = vi.fn();
  const subscriber: CloseRequestSubscriber = (next) => {
    handler = next;
    return Promise.resolve(unlisten);
  };
  return {
    subscriber,
    emit: () => handler?.(),
    unlisten,
  };
}

describe('subscribeAppCloseRequested', () => {
  it('olay adı Rust sabitiyle aynıdır', () => {
    expect(CLOSE_REQUESTED_EVENT).toBe('app:close-requested');
  });

  it('kapanış isteğini işleyiciye iletir', async () => {
    const { subscriber, emit } = fakeSubscriber();
    const handler = vi.fn();

    await subscribeAppCloseRequested(handler, subscriber);
    emit();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('kaldırma fonksiyonunu olduğu gibi döndürür', async () => {
    const { subscriber, unlisten } = fakeSubscriber();

    const stop = await subscribeAppCloseRequested(() => {}, subscriber);
    stop();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
