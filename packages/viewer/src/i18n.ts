// User-facing texts. The interface is bilingual (Russian and English) from day one.

export const LOCALES = ['ru', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

const ru = {
  title: 'Мозаика',
  subtitle: 'Открытая среда имитационного моделирования',
  status:
    'Готовы ядро времени (Ф0-2), блоки процессов (Ф0-3), агенты с диаграммами состояний (Ф0-4), ядро на данных в массивах (Ф0-4б), блоки на событиях, где сущность — агент (Ф0-4в), и движение агентов со снимками для показа (Ф0-6а). 3D-сцена, системная динамика и управление через MCP появятся в следующих задачах Фазы\u00a00.',
  kernel: 'Ядро',
  build: 'Сборка',
  localBuild: 'локальная',
  switchLanguage: 'English',
  numberLocale: 'ru-RU',
  motionTitle: 'Проверка движения',
  motionAbout:
    'Ядро работает в Web Worker и ведёт модель «проход»: Source → Delay с движением → Delay → Sink. Люди входят в дверь слева, идут к свободному месту, ждут и уходят в дверь справа. Каждый кадр рисуется по отрезкам движения из снимка ядра: между снимками показ сам ведёт людей по их отрезкам.',
  stateEntering: 'идёт к месту',
  stateWaiting: 'ждёт',
  stateLeaving: 'уходит',
  modelTime: 'Модельное время',
  peopleInHall: 'Людей в зале',
  snapshotsPerSecond: 'Снимков в секунду',
  framesPerSecond: 'Кадров в секунду',
  arrivalsPerUnit: 'Приходов в единицу времени',
  walkingSpeed: 'Скорость, м в единицу времени',
  timeScale: 'Единиц модельного времени в секунду',
  pause: 'Пауза',
  resume: 'Продолжить',
  restart: 'Заново',
  motionError: 'Ядро остановилось с ошибкой:',
};

export type Messages = Readonly<Record<keyof typeof ru, string>>;

const en: Messages = {
  title: 'Mozaika',
  subtitle: 'Open simulation modelling environment',
  status:
    'The time kernel (F0-2), process blocks (F0-3), agents with statecharts (F0-4), the kernel on typed arrays (F0-4b), blocks on kernel events with agents as entities (F0-4c) and agents that move, with snapshots for a viewer (F0-6a), are ready. The 3D scene, system dynamics and MCP control arrive in the next Phase\u00a00 tasks.',
  kernel: 'Kernel',
  build: 'Build',
  localBuild: 'local',
  switchLanguage: 'Русский',
  numberLocale: 'en-US',
  motionTitle: 'Movement check',
  motionAbout:
    'The kernel runs in a Web Worker and drives the walkway model: Source → Delay with movement → Delay → Sink. People come in through the door on the left, walk to a free spot, wait and leave through the door on the right. Each frame is drawn from the segments of movement in the kernel’s snapshot: between snapshots the viewer leads people along their segments itself.',
  stateEntering: 'walking to a spot',
  stateWaiting: 'waiting',
  stateLeaving: 'leaving',
  modelTime: 'Model time',
  peopleInHall: 'People in the hall',
  snapshotsPerSecond: 'Snapshots per second',
  framesPerSecond: 'Frames per second',
  arrivalsPerUnit: 'Arrivals per unit of time',
  walkingSpeed: 'Speed, m per unit of time',
  timeScale: 'Units of model time per second',
  pause: 'Pause',
  resume: 'Resume',
  restart: 'Restart',
  motionError: 'The kernel stopped with an error:',
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
