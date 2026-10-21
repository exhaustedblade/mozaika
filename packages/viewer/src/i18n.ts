// User-facing texts. The interface is bilingual (Russian and English) from day one.

export const LOCALES = ['ru', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

const ru = {
  title: 'Мозаика',
  subtitle: 'Открытая среда имитационного моделирования',
  status:
    'Готово ядро времени (задача Ф0-2): очередь событий, процессы, случайные числа с seed. Блоки, сцена и управление через MCP появятся в следующих задачах Фазы\u00a00.',
  kernel: 'Ядро',
  build: 'Сборка',
  localBuild: 'локальная',
  switchLanguage: 'English',
};

export type Messages = Readonly<Record<keyof typeof ru, string>>;

const en: Messages = {
  title: 'Mozaika',
  subtitle: 'Open simulation modelling environment',
  status:
    'The time kernel is ready (task F0-2): event queue, processes, seeded random numbers. Blocks, the scene and MCP control arrive in the next Phase\u00a00 tasks.',
  kernel: 'Kernel',
  build: 'Build',
  localBuild: 'local',
  switchLanguage: 'Русский',
};

export const MESSAGES: Readonly<Record<Locale, Messages>> = { ru, en };

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** Returns the first supported locale among language tags such as "ru-RU"; English if none match. */
export function detectLocale(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const base = tag.toLowerCase().split('-')[0] ?? '';
    if (isLocale(base)) {
      return base;
    }
  }
  return 'en';
}
