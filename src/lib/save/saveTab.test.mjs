import { describe, expect, it } from 'vitest';

import { normalizeSaveFailure, saveTab } from './saveTab.ts';

function makeTab(overrides = {}) {
  return { id: 'tab-1', path: 'notes/a.md', dirty: true, ...overrides };
}

function makeDeps({ writeFile } = {}) {
  const calls = { writes: [], saved: [], errors: [] };
  return {
    calls,
    deps: {
      writeFile:
        writeFile ??
        (async (path, contents, expectedHash) => {
          // Hash yalnızca verildiğinde kayda girer; böylece eski beklentiler korunur.
          calls.writes.push(
            expectedHash === undefined ? { path, contents } : { path, contents, expectedHash },
          );
        }),
      markSaved(id) {
        calls.saved.push(id);
      },
      notifyError(failure) {
        calls.errors.push(failure);
      },
    },
  };
}

describe('saveTab', () => {
  it('dirty sekmeyi kaydeder ve ancak yazma başarılı olunca temizler', async () => {
    const tab = makeTab();
    const { deps, calls } = makeDeps();

    const outcome = await saveTab(tab, '# başlık\n', deps);

    expect(outcome).toEqual({ status: 'saved' });
    expect(calls.writes).toEqual([{ path: 'notes/a.md', contents: '# başlık\n' }]);
    expect(calls.saved).toEqual(['tab-1']);
    expect(calls.errors).toEqual([]);
    expect(tab.dirty).toBe(true);
  });

  it('başarısız kaydetmede sekme dirty kalır ve hata bildirilir', async () => {
    const tab = makeTab();
    const failure = { code: 'SaveFailed', message: 'sharing violation after 3 attempts' };
    const { deps, calls } = makeDeps({
      writeFile: async () => {
        throw failure;
      },
    });

    const outcome = await saveTab(tab, 'yeni içerik', deps);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toEqual(failure);
    expect(tab.dirty).toBe(true);
    expect(calls.saved).toEqual([]);
    expect(calls.errors).toEqual([failure]);
  });

  it('temiz sekme için yazma yapılmaz', async () => {
    let writes = 0;
    const { deps, calls } = makeDeps({
      writeFile: async () => {
        writes += 1;
      },
    });

    const outcome = await saveTab(makeTab({ dirty: false }), 'içerik', deps);

    expect(outcome).toEqual({ status: 'skipped' });
    expect(writes).toBe(0);
    expect(calls.saved).toEqual([]);
    expect(calls.errors).toEqual([]);
  });

  it('yazma sırasında içerik aynen iletilir (CRLF, unicode, BOM)', async () => {
    const contents = '\uFEFF# Başlık\r\n\r\nTürkçe: ğüşiöç — 日本語\r\n';
    const { deps, calls } = makeDeps();

    await saveTab(makeTab({ path: 'notlar/ğüş.md' }), contents, deps);

    expect(calls.writes).toEqual([{ path: 'notlar/ğüş.md', contents }]);
  });

  it('diskteki sürümün hash’i `expectedHash` olarak yazmaya iletilir', async () => {
    const { deps, calls } = makeDeps();

    await saveTab(makeTab({ hash: 'disk-hash' }), 'yeni içerik', deps);

    expect(calls.writes).toEqual([
      { path: 'notes/a.md', contents: 'yeni içerik', expectedHash: 'disk-hash' },
    ]);
  });

  it('başarılı yazmanın döndürdüğü hash store’a iletilir', async () => {
    const saved = [];
    const { deps } = makeDeps({ writeFile: async () => ({ hash: 'yeni-hash' }) });
    deps.markSaved = (id, hash) => saved.push({ id, hash });

    const outcome = await saveTab(makeTab(), 'içerik', deps);

    expect(outcome).toEqual({ status: 'saved' });
    expect(saved).toEqual([{ id: 'tab-1', hash: 'yeni-hash' }]);
  });

  it('aynı sekmeye eşzamanlı ikinci istek ikinci bir yazma üretmez', async () => {
    let release = () => {};
    let writes = 0;
    const { deps, calls } = makeDeps({
      writeFile: async () => {
        writes += 1;
        await new Promise((resolve) => {
          release = resolve;
        });
        return { hash: 'ilk-hash' };
      },
    });

    const first = saveTab(makeTab(), 'ilk içerik', deps);
    const second = await saveTab(makeTab(), 'ikinci içerik', deps);

    expect(second).toEqual({ status: 'locked' });
    expect(writes).toBe(1);

    release();

    expect(await first).toEqual({ status: 'saved' });
    expect(writes).toBe(1);
    expect(calls.saved).toEqual(['tab-1']);
  });

  it('kilit yazma bitince serbest kalır; sonraki kaydetme yine yazar', async () => {
    let writes = 0;
    const { deps, calls } = makeDeps({
      writeFile: async () => {
        writes += 1;
      },
    });

    expect(await saveTab(makeTab(), 'ilk', deps)).toEqual({ status: 'saved' });
    expect(await saveTab(makeTab(), 'ikinci', deps)).toEqual({ status: 'saved' });

    expect(writes).toBe(2);
    expect(calls.saved).toEqual(['tab-1', 'tab-1']);
  });

  it('ConflictDetected çakışma bandını tetikler ve sekme dirty kalır', async () => {
    const failure = { code: 'ConflictDetected', message: 'diskteki sürüm farklı' };
    const conflicts = [];
    const tab = makeTab();
    const { deps, calls } = makeDeps({
      writeFile: async () => {
        throw failure;
      },
    });
    deps.onConflict = (conflictTab, contents) =>
      conflicts.push({ id: conflictTab.id, path: conflictTab.path, contents });

    const outcome = await saveTab(tab, 'benim içeriğim', deps);

    expect(outcome).toEqual({ status: 'failed', error: failure });
    expect(conflicts).toEqual([
      { id: 'tab-1', path: 'notes/a.md', contents: 'benim içeriğim' },
    ]);
    expect(calls.saved).toEqual([]);
    expect(calls.errors).toEqual([failure]);
    expect(tab.dirty).toBe(true);
  });

  it('çakışma dışındaki hatalarda çakışma bandı açılmaz', async () => {
    const failure = { code: 'SaveFailed', message: 'disk dolu' };
    let conflicts = 0;
    const { deps } = makeDeps({
      writeFile: async () => {
        throw failure;
      },
    });
    deps.onConflict = () => {
      conflicts += 1;
    };

    await saveTab(makeTab(), 'içerik', deps);

    expect(conflicts).toBe(0);
  });
});

describe('normalizeSaveFailure', () => {
  it('hatalar tipli { code, message } biçimine normalize edilir', () => {
    expect(normalizeSaveFailure({ code: 'SaveFailed', message: 'disk dolu' })).toEqual({
      code: 'SaveFailed',
      message: 'disk dolu',
    });
    expect(normalizeSaveFailure({ code: 'PATH_OUTSIDE_WORKSPACE' })).toEqual({
      code: 'PathEscape',
      message: 'Çalışma klasörü dışına erişim engellendi',
    });
    expect(normalizeSaveFailure({ code: 'ENTRY_EXISTS', message: 'zaten var' })).toEqual({
      code: 'ConflictDetected',
      message: 'zaten var',
    });
    expect(normalizeSaveFailure({ message: 'beklenmeyen' })).toEqual({
      code: 'Internal',
      message: 'beklenmeyen',
    });
    expect(normalizeSaveFailure('düz metin hata')).toEqual({
      code: 'Internal',
      message: 'düz metin hata',
    });
    expect(normalizeSaveFailure(undefined)).toEqual({
      code: 'Internal',
      message: 'Beklenmeyen bir hata oluştu.',
    });
  });
});
