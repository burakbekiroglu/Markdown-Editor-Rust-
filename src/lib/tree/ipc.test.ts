import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeCommand } = vi.hoisted(() => ({
  invokeCommand: vi.fn(async () => []),
}));

vi.mock('../ipc/client', () => ({ invokeCommand }));

import { listEntries } from './ipc';

beforeEach(() => {
  invokeCommand.mockClear();
});

describe('listEntries', () => {
  it('dizin listesini fs_list_dir üzerinden köke göreli yolla ister', async () => {
    await listEntries('kutu');
    expect(invokeCommand).toHaveBeenCalledWith('fs_list_dir', { path: 'kutu' });

    await listEntries();
    expect(invokeCommand).toHaveBeenLastCalledWith('fs_list_dir', { path: '' });
  });
});
