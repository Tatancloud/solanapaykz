// tilda-server/tests/links/i18n.test.ts
import { describe, expect, it } from 'vitest';
import { en, pickLang, ru, t } from '../../src/links/i18n.js';

describe('i18n', () => {
  it('has the same keys in both dictionaries and no empty strings', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    for (const v of [...Object.values(en), ...Object.values(ru)]) expect(v.trim()).not.toBe('');
  });

  it('substitutes variables', () => {
    expect(t('en', 'invoice_title', { name: 'Shop' })).toContain('Shop');
  });

  it('picks the language from query, then Accept-Language, default English', () => {
    expect(pickLang('ru', 'en-US')).toBe('ru');
    expect(pickLang(null, 'ru-RU,ru;q=0.9')).toBe('ru');
    expect(pickLang(null, 'kk-KZ')).toBe('en');
    expect(pickLang('xx', undefined)).toBe('en');
  });
});
