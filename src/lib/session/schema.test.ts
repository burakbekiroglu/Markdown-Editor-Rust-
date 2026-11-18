import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SESSION_BYTES,
  SESSION_VERSION,
  createSessionData,
  isSafeRelativePath,
  parseSession,
  serializeSession,
  type SessionData,
} from './schema';

function validSession(overrides: Partial<SessionData> = {}): SessionData {
  return createSessionData({
    root: 'C:/notlar',
    tabs: [{ path: 'gunluk/bugun.md', cursor: { anchor: 3, head: 3 }, scroll: { top: 40, left: 0 } }],
    activePath: 'gunluk/bugun.md',
    viewMode: 'split',
    splitRatio: 0.6,
    sidebarWidth: 300,
    ...overrides,
  });
}

describe('parseSession', () => {
  it('serialize/parse turu tüm alanları korur', () => {
    const original = validSession();
    const parsed = parseSession(serializeSession(original));

    expect(parsed).toEqual(original);
  });

  it('eksik alanları güvenli varsayılanlara düşürür', () => {
    const parsed = parseSession(JSON.stringify({ version: SESSION_VERSION }));

    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      version: SESSION_VERSION,
      root: '',
      tabs: [],
      activePath: null,
      viewMode: 'split',
      splitRatio: 0.5,
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    });
  });

  it('bozuk JSON ve bilinmeyen sürüm reddedilir', () => {
    expect(parseSession('{ bu json değil')).toBeNull();
    expect(parseSession('')).toBeNull();
    expect(parseSession('[]')).toBeNull();
    expect(parseSession('null')).toBeNull();
    expect(parseSession(JSON.stringify({ version: 2, root: 'C:/x' }))).toBeNull();
    expect(parseSession(JSON.stringify({ root: 'C:/x' }))).toBeNull();
  });

  it('sınırı aşan ham metin reddedilir', () => {
    expect(parseSession('x'.repeat(MAX_SESSION_BYTES + 1))).toBeNull();
  });

  it('tanınmayan alanları düşürür', () => {
    const raw = JSON.stringify({
      version: SESSION_VERSION,
      root: 'C:/notlar',
      tabs: [],
      activePath: null,
      zararli: '<script>alert(1)</script>',
    });

    const parsed = parseSession(raw);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('zararli');
  });

  it('güvenli olmayan ve yinelenen sekme yollarını eler', () => {
    const parsed = parseSession(
      JSON.stringify({
        version: SESSION_VERSION,
        tabs: [
          { path: 'a.md' },
          { path: 'a.md' },
          { path: '/mutlak.md' },
          { path: 'C:/disari.md' },
          { path: '../kacis.md' },
          { path: 'ters\\bolu.md' },
          { path: '' },
          { path: 'b/c.md' },
          { path: 42 },
        ],
      }),
    );

    expect(parsed?.tabs.map((tab) => tab.path)).toEqual(['a.md', 'b/c.md']);
  });

  it('geçersiz imleç/scroll değerlerini null yapar', () => {
    const parsed = parseSession(
      JSON.stringify({
        version: SESSION_VERSION,
        tabs: [
          { path: 'a.md', cursor: { anchor: -1, head: 2 }, scroll: { top: -5, left: 0 } },
          { path: 'b.md', cursor: { anchor: 'x', head: 1 }, scroll: { top: 'y', left: 0 } },
        ],
      }),
    );

    expect(parsed?.tabs[0]).toMatchObject({ cursor: null, scroll: null });
    expect(parsed?.tabs[1]).toMatchObject({ cursor: null, scroll: null });
  });

  it('açık sekmelerde bulunmayan etkin yolu temizler', () => {
    const parsed = parseSession(
      JSON.stringify({
        version: SESSION_VERSION,
        tabs: [{ path: 'a.md' }],
        activePath: 'baska.md',
      }),
    );

    expect(parsed?.activePath).toBeNull();
  });

  it('görünüm modu ve ayırıcı oranını aralığa sıkıştırır', () => {
    const parsed = parseSession(
      JSON.stringify({
        version: SESSION_VERSION,
        viewMode: 'tanimsiz',
        splitRatio: 9,
        sidebarWidth: 9999,
      }),
    );

    expect(parsed?.viewMode).toBe('split');
    expect(parsed?.splitRatio).toBeLessThanOrEqual(0.8);
    expect(parsed?.sidebarWidth).toBeLessThanOrEqual(520);
  });
});

describe('isSafeRelativePath', () => {
  it('normal göreli yolları kabul eder', () => {
    expect(isSafeRelativePath('notlar/gunluk.md')).toBe(true);
    expect(isSafeRelativePath('a.md')).toBe(true);
  });

  it('mutlak, kaçış ve ters bölü yolları reddeder', () => {
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('C:/x.md')).toBe(false);
    expect(isSafeRelativePath('../x.md')).toBe(false);
    expect(isSafeRelativePath('a/../b.md')).toBe(false);
    expect(isSafeRelativePath('a\\b.md')).toBe(false);
    expect(isSafeRelativePath('')).toBe(false);
    expect(isSafeRelativePath(3)).toBe(false);
  });
});

describe('createSessionData', () => {
  it('geçersiz etkin yolu ve sekme yolunu eler', () => {
    const data = createSessionData({
      tabs: [{ path: '../x.md', cursor: null, scroll: null }],
      activePath: '../x.md',
    });

    expect(data.tabs).toEqual([]);
    expect(data.activePath).toBeNull();
  });
});
