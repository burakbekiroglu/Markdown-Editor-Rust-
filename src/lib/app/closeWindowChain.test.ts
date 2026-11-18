/**
 * GUI açmadan çalışan pencere kapatma regresyonu.
 *
 * İki iddia birlikte kapatma yolunun bozulmadığını kanıtlar:
 *
 * 1. Yetki (capability) dosyası beklenen minimum izin kümesini taşır; geniş
 *    `core:*` (özellikle `core:window:allow-close/destroy`) ve eklenti
 *    yetkileri (`fs:`, `shell:`, `process:`, `dialog:`, ...) yoktur. ACL'de
 *    bu geniş izinlerin geri gelmesi webview'e gereksiz yetki verirdi.
 * 2. Kapatma çağrı zinciri gerçek üretim modülleriyle (`closeRequest` ->
 *    `ipc/events` -> `ipc/client`), yalnızca Tauri köprüsü (`listen`,
 *    `invoke`) mock'lanarak uçtan uca çalışır: abonelik ACL reddi olmadan
 *    kurulur, olay işleyiciye iletilir ve `app_close_window` çağrısı
 *    izin reddi olmadan köprüye ulaşır.
 */

import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { invokeCommand } from '../ipc/client';
import { CLOSE_REQUESTED_EVENT, subscribeAppCloseRequested } from './closeRequest';

// --- capability dosyası ----------------------------------------------------

const capability = JSON.parse(
  readFileSync('src-tauri/capabilities/default.json', 'utf8'),
) as { permissions: Array<{ identifier: string }> };

const permissionIds = capability.permissions.map((entry) => entry.identifier);

describe('capability/izin dosyası', () => {
  it('beklenen minimum izin kümesini içerir', () => {
    expect([...permissionIds].sort()).toEqual([
      'core:event:allow-listen',
      'core:event:allow-unlisten',
      'opener:allow-open-url',
      'store:allow-get',
      'store:allow-load',
      'store:allow-save',
      'store:allow-set',
    ]);
  });

  it('geniş çekirdek (core:window/webview) yetkisi eklemez', () => {
    const coreIds = permissionIds.filter((id) => id.startsWith('core:'));
    expect(coreIds).toEqual(['core:event:allow-listen', 'core:event:allow-unlisten']);
  });

  it('webview için pencere yok etme/ kapama izni vermez', () => {
    // Kapatma ACL'ye tabi olmayan `app_close_window` komutuyla Rust'ta yapılır.
    expect(
      permissionIds.some((id) => id.startsWith('core:window:allow-close')),
      'core:window:allow-close eklendi',
    ).toBe(false);
    expect(
      permissionIds.some((id) => id.startsWith('core:window:allow-destroy')),
      'core:window:allow-destroy eklendi',
    ).toBe(false);
  });

  it('geniş eklenti yetkisi (fs/shell/process/dialog/http) eklemez', () => {
    const forbiddenPrefixes = [
      'fs:',
      'shell:',
      'process:',
      'dialog:',
      'http:',
      'websocket:',
      'clipboard-',
      'notification:',
      'global-shortcut:',
    ];
    for (const id of permissionIds) {
      for (const prefix of forbiddenPrefixes) {
        expect(id.startsWith(prefix), `${id} geniş yetki taşıyor`).toBe(false);
      }
    }
  });
});

// --- mock Tauri köprüsü üzerinden kapatma zinciri ---------------------------

const mockListen = vi.mocked(listen);
const mockInvoke = vi.mocked(invoke);

const unlisten: UnlistenFn = () => undefined;

describe('kapatma çağrı zinciri (mock Tauri köprüsü)', () => {
  beforeEach(() => {
    mockListen.mockReset();
    mockInvoke.mockReset();
    mockListen.mockResolvedValue(unlisten);
    mockInvoke.mockResolvedValue(undefined);
  });

  it('abonelik izin reddi olmadan kurulur ve Rust olayını işleyiciye iletir', async () => {
    let delivered = 0;
    const stop = await subscribeAppCloseRequested(() => {
      delivered += 1;
    });

    expect(mockListen).toHaveBeenCalledWith('app:close-requested', expect.any(Function));
    const [, handler] = mockListen.mock.calls[0]!;
    (handler as (event: { payload: unknown }) => void)({ payload: {} });
    expect(delivered).toBe(1);
    expect(CLOSE_REQUESTED_EVENT).toBe('app:close-requested');

    stop();
  });

  it('temiz kapanma yolu app_close_window komutunu izin reddi olmadan köprüye taşır', async () => {
    await expect(invokeCommand('app_close_window', {})).resolves.toBeUndefined();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('app_close_window', {});
  });

  it('izin reddi geldiğinde hata sessizce yutulmaz, AppError olarak yükselir', async () => {
    mockInvoke.mockRejectedValueOnce({ code: 'PermissionDenied', message: 'reddedildi' });

    await expect(invokeCommand('app_close_window', {})).rejects.toMatchObject({
      name: 'AppError',
      code: 'PermissionDenied',
    });
  });
});
