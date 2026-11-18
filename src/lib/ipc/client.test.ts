import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInvokeCommand, type InvokeTransport } from './client';
import { AppError } from './errors';
import type { EntryInfo, WorkspaceInfo } from './types';

interface Call {
  command: string;
  args?: Record<string, unknown>;
}

/** Enjeksiyon: Tauri modülü mock'lanmaz, taşıyıcı doğrudan verilir. */
function resolvingTransport(result: unknown): {
  transport: InvokeTransport;
  calls: Call[];
} {
  const calls: Call[] = [];
  async function transport<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    calls.push({ command, args });
    // Test fikstürü: taşıyıcı imzası generic, sahte değer çağıranın beklediği
    // tipe daraltılır. Üretim kodunda böyle bir daraltma yok.
    return result as T;
  }
  return { transport, calls };
}

function rejectingTransport(reason: unknown): InvokeTransport {
  async function transport<T>(): Promise<T> {
    throw reason;
  }
  return transport;
}

describe('createInvokeCommand', () => {
  it('komut adını ve camelCase argümanları aynen iletir', async () => {
    const entries: EntryInfo[] = [
      { name: 'notlar.md', relativePath: 'gunluk/notlar.md', isDir: false, isSymlink: false },
    ];
    const { transport, calls } = resolvingTransport(entries);

    const result = await createInvokeCommand(transport)('list_workspace_dir', { path: 'gunluk' });

    expect(calls).toEqual([{ command: 'list_workspace_dir', args: { path: 'gunluk' } }]);
    expect(result).toEqual(entries);
  });

  it('argümansız komutları boş nesneyle gönderir', async () => {
    const workspace: WorkspaceInfo | null = null;
    const { transport, calls } = resolvingTransport(workspace);

    await expect(createInvokeCommand(transport)('current_workspace', {})).resolves.toBeNull();
    expect(calls).toEqual([{ command: 'current_workspace', args: {} }]);
  });

  it('void sonuçlu komutu olduğu gibi çözer', async () => {
    const { transport } = resolvingTransport(undefined);

    await expect(
      createInvokeCommand(transport)('fs_delete_entry', { rel: 'notlar.md' }),
    ).resolves.toBeUndefined();
  });

  it('reddi AppError olarak yeniden fırlatır', async () => {
    const transport = rejectingTransport({ code: 'PathEscape', message: 'kök dışına çıktı' });

    const call = createInvokeCommand(transport)('fs_write_file_atomic', {
      path: '../x.md',
      contents: 'x',
    });

    await expect(call).rejects.toBeInstanceOf(AppError);
    await expect(call).rejects.toMatchObject({
      name: 'AppError',
      code: 'PathEscape',
      message: 'kök dışına çıktı',
    });
  });

  it('eski kodlu reddi kanonik koda normalize eder', async () => {
    const transport = rejectingTransport({ code: 'ENTRY_EXISTS', message: 'zaten var' });

    const call = createInvokeCommand(transport)('fs_create_file', { parentRel: '', name: 'notlar' });

    await expect(call).rejects.toMatchObject({ code: 'ConflictDetected', message: 'zaten var' });
  });

  it('tipli olmayan reddi Internal yapar', async () => {
    const transport = rejectingTransport('bağlantı koptu');

    const call = createInvokeCommand(transport)('fs_delete_entry', { rel: 'notlar.md' });

    await expect(call).rejects.toMatchObject({ code: 'Internal', message: 'bağlantı koptu' });
  });

  it('fırlatılan Error örneğini de normalize eder', async () => {
    const transport = rejectingTransport(new Error('köprü kapandı'));

    const call = createInvokeCommand(transport)('fs_read_file', { path: 'a.md' });

    await expect(call).rejects.toMatchObject({ code: 'Internal', message: 'köprü kapandı' });
  });

  it('her çağrı için ayrı bir taşıyıcı kullanılabilir', async () => {
    const first = resolvingTransport('bir');
    const second = resolvingTransport('iki');

    await expect(
      createInvokeCommand(first.transport)('fs_read_file', { path: 'a.md' }),
    ).resolves.toBe('bir');
    await expect(
      createInvokeCommand(second.transport)('fs_read_file', { path: 'b.md' }),
    ).resolves.toBe('iki');
    expect(first.calls).toEqual([{ command: 'fs_read_file', args: { path: 'a.md' } }]);
    expect(second.calls).toEqual([{ command: 'fs_read_file', args: { path: 'b.md' } }]);
  });
});

/** `src` altındaki tüm TypeScript/Svelte kaynaklarını özyinelemeli toplar. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.isFile() && /\.(?:ts|js|svelte)$/.test(entry.name)) found.push(path);
  }
  return found;
}

describe('IPC sınırı', () => {
  it('Tauri köprüsü yalnızca client.ts üzerinden kullanılır', () => {
    // Tek normalizasyon katmanı ancak hiçbir modül `invoke`'u doğrudan
    // çağırmadığında korunur; bu test o sınırı kalıcı kılar.
    const srcRoot = join(process.cwd(), 'src');
    const allowed = join('src', 'lib', 'ipc', 'client.ts');

    const offenders = sourceFiles(srcRoot)
      .filter((file) => /@tauri-apps\/api\/core['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(process.cwd(), file).split(sep).join('/'))
      .filter((file) => file !== allowed.split(sep).join('/'));

    expect(offenders).toEqual([]);
  });
});
