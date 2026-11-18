import { describe, expect, it, vi } from 'vitest';

import type { EventSubscriber } from '../ipc/events';
import { AppError } from '../ipc/errors';
import { FS_CHANGED_EVENT, WATCHER_ERROR_EVENT } from './events';
import { subscribeWorkspaceWatch } from './watcher';

interface Registered {
  event: string;
  handler: (event: { payload: unknown }) => void;
}

function fakeSubscriber(): { subscriber: EventSubscriber; registered: Registered[] } {
  const registered: Registered[] = [];
  const subscriber: EventSubscriber = (event, handler) => {
    registered.push({ event, handler });
    return Promise.resolve(() => {});
  };
  return { subscriber, registered };
}

describe('subscribeWorkspaceWatch', () => {
  it('iki olaya da abone olur', async () => {
    const { subscriber, registered } = fakeSubscriber();

    await subscribeWorkspaceWatch({ onChange: () => {}, onError: () => {} }, subscriber);

    expect(registered.map((entry) => entry.event)).toEqual([
      FS_CHANGED_EVENT,
      WATCHER_ERROR_EVENT,
    ]);
  });

  it('doğrulanmış değişiklik partisini işleyiciye iletir', async () => {
    const { subscriber, registered } = fakeSubscriber();
    const onChange = vi.fn();

    await subscribeWorkspaceWatch({ onChange, onError: () => {} }, subscriber);
    registered[0]?.handler({
      payload: {
        changes: [
          { path: 'notlar.md', kind: 'modify' },
          { path: '../kacis.md', kind: 'modify' },
        ],
      },
    });

    expect(onChange).toHaveBeenCalledWith([{ path: 'notlar.md', kind: 'modify' }]);
  });

  it('boş veya bozuk partide işleyiciyi çağırmaz', async () => {
    const { subscriber, registered } = fakeSubscriber();
    const onChange = vi.fn();

    await subscribeWorkspaceWatch({ onChange, onError: () => {} }, subscriber);
    registered[0]?.handler({ payload: { changes: [] } });
    registered[0]?.handler({ payload: { changes: [{ path: '../x.md', kind: 'modify' }] } });
    registered[0]?.handler({ payload: null });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('izleyici hatasını AppError olarak iletir', async () => {
    const { subscriber, registered } = fakeSubscriber();
    const onError = vi.fn();

    await subscribeWorkspaceWatch({ onChange: () => {}, onError }, subscriber);
    registered[1]?.handler({ payload: { code: 'WatcherFailed', message: 'izleyici durdu' } });

    expect(onError).toHaveBeenCalledTimes(1);
    const received = onError.mock.calls[0]?.[0] as AppError;
    expect(received).toBeInstanceOf(AppError);
    expect(received.code).toBe('WatcherFailed');
  });

  it('dönen fonksiyon iki dinleyiciyi de kaldırır', async () => {
    const registered: Registered[] = [];
    const unlisteners: Array<ReturnType<typeof vi.fn>> = [];
    const subscriber: EventSubscriber = (event, handler) => {
      registered.push({ event, handler });
      const unlisten = vi.fn();
      unlisteners.push(unlisten);
      return Promise.resolve(unlisten);
    };

    const stop = await subscribeWorkspaceWatch(
      { onChange: () => {}, onError: () => {} },
      subscriber,
    );
    stop();

    expect(unlisteners).toHaveLength(2);
    for (const unlisten of unlisteners) expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
