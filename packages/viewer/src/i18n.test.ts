import { describe, expect, it } from 'vitest';

import { detectLocale, LOCALES, MESSAGES } from './i18n.js';

describe('viewer i18n', () => {
  it('has every message in Russian and English', () => {
    expect(LOCALES).toEqual(['ru', 'en']);
    const keys = Object.keys(MESSAGES.ru).sort();
    for (const locale of LOCALES) {
      const messages = MESSAGES[locale];
      expect(Object.keys(messages).sort()).toEqual(keys);
      for (const text of Object.values(messages)) {
        expect(text.trim()).not.toBe('');
      }
    }
  });

  it('picks the first supported browser language, else English', () => {
    expect(detectLocale(['ru-RU', 'en-US'])).toBe('ru');
    expect(detectLocale(['de-DE', 'EN-gb'])).toBe('en');
    expect(detectLocale(['de-DE'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });
});
