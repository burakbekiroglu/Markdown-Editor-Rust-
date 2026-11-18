import { describe, expect, it } from 'vitest';

import type { SaveableTab } from '../save/saveTab';
import { saveDirtyTabs, type SaveAllDeps } from './closeCoordinator';

interface Write {
  path: string;
  contents: string;
  expectedHash?: string | null;
}

function makeTab(id: string, dirty = true): SaveableTab {
  return { id, path: `notes/${id}.md`, dirty, hash: `${id}-hash` };
}

function harness(overrides: Partial<SaveAllDeps> = {}) {
  const writes: Write[] = [];
  const saved: { id: string; hash: string | null; unchanged: boolean }[] = [];
  const errors: string[] = [];
  const contents = new Map<string, string>();

  const deps: SaveAllDeps = {
    readContents: (id) => contents.get(id) ?? null,
    writeFile: async (path, text, expectedHash) => {
      writes.push({ path, contents: text, expectedHash });
      return { hash: `${path}:hash` };
    },
    markSaved: (id, hash, unchanged) => saved.push({ id, hash, unchanged }),
    notifyError: (failure) => errors.push(failure.message),
    ...overrides,
  };

  return { deps, writes, saved, errors, contents };
}

describe('saveDirtyTabs', () => {
  it('dirty sekme yoksa hiç yazmaz', async () => {
    const { deps, writes, saved, errors } = harness();

    const outcome = await saveDirtyTabs([makeTab('a', false), makeTab('b', false)], deps);

    expect(outcome).toEqual({ status: 'idle' });
    expect(writes).toEqual([]);
    expect(saved).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('tek dirty sekmeyi metniyle ve disk hash’iyle yazar', async () => {
    const { deps, writes, saved } = harness();
    deps.readContents = () => '# başlık\n';

    const outcome = await saveDirtyTabs([makeTab('a')], deps);

    expect(outcome).toEqual({ status: 'saved', saved: 1 });
    expect(writes).toEqual([
      { path: 'notes/a.md', contents: '# başlık\n', expectedHash: 'a-hash' },
    ]);
    expect(saved).toEqual([{ id: 'a', hash: 'notes/a.md:hash', unchanged: true }]);
  });

  it('birden çok dirty sekmeyi listedeki sırayla yazar', async () => {
    const { deps, writes, saved } = harness();
    deps.readContents = (id) => `<${id}>`;

    const outcome = await saveDirtyTabs([makeTab('a'), makeTab('b'), makeTab('c')], deps);

    expect(outcome).toEqual({ status: 'saved', saved: 3 });
    expect(writes.map((write) => write.path)).toEqual([
      'notes/a.md',
      'notes/b.md',
      'notes/c.md',
    ]);
    expect(saved.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('ortadaki yazma hatasında durur; sonraki sekmeler yazılmaz ve kapanma iptal edilir', async () => {
    const failure = { code: 'SaveFailed' as const, message: 'disk dolu' };
    const { deps, writes, saved, errors } = harness();
    deps.readContents = (id) => `<${id}>`;
    deps.writeFile = async (path, text, expectedHash) => {
      writes.push({ path, contents: text, expectedHash });
      if (path === 'notes/b.md') throw failure;
      return { hash: 'ok' };
    };

    const outcome = await saveDirtyTabs([makeTab('a'), makeTab('b'), makeTab('c')], deps);

    expect(outcome).toEqual({ status: 'failed', tabId: 'b', error: failure });
    expect(writes.map((write) => write.path)).toEqual(['notes/a.md', 'notes/b.md']);
    expect(saved.map((entry) => entry.id)).toEqual(['a']);
    expect(errors).toEqual(['disk dolu']);
  });

  it('içeriği bulunamayan sekme sessizce atlanmaz; kapatma iptal edilir', async () => {
    const { deps, writes, errors } = harness();

    const outcome = await saveDirtyTabs([makeTab('a')], deps);

    expect(outcome.status).toBe('failed');
    expect(writes).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('yazma sürerken içerik değiştiyse sekme dirty kalır (unchanged=false)', async () => {
    const { deps, saved, contents } = harness({
      writeFile: async () => {
        // Kullanıcı yazma sürerken yazmaya devam etti.
        contents.set('a', 'yeni içerik');
        return { hash: 'h' };
      },
    });
    contents.set('a', 'eski içerik');

    await saveDirtyTabs([makeTab('a')], deps);

    expect(saved).toEqual([{ id: 'a', hash: 'h', unchanged: false }]);
  });
});
