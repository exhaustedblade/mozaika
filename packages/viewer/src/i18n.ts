// User-facing texts. The interface is bilingual (Russian and English) from day one.

export const LOCALES = ['ru', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

const ru = {
  title: 'Мозаика',
  subtitle: 'Открытая среда имитационного моделирования',
  status:
    'Готовы ядро времени (Ф0-2), блоки процессов (Ф0-3), агенты с диаграммами состояний (Ф0-4), ядро на данных в массивах (Ф0-4б), блоки на событиях, где сущность — агент (Ф0-4в), движение агентов со снимками для показа (Ф0-6а) и 3D-сцена с демо «пункт обслуживания» (Ф0-6б). Оболочки десктопа, системная динамика и управление через MCP появятся в следующих задачах Фазы\u00a00.',
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
  benchTitle: 'Замер сцены',
  benchAbout:
    'Ядро в Web Worker ведёт толпу, которая не останавливается: каждый идёт к случайной точке площади. Видеокарта рисует всех инстансингом и сама ведёт по отрезкам из снимков ядра. Первые 3 секунды — разогрев, потом 10 секунд замера.',
  benchHowTo:
    'Как замерить: откройте страницу в Chrome или Edge на Windows и в Chrome и Safari на macOS, разверните окно на весь экран, не трогайте мышь 15 секунд, нажмите «Скопировать итог» и пришлите текст. Потом то же для 1 000 000. Цель — не ниже 30 кадров в секунду на 100 000 (П-18).',
  benchAgents: 'Агентов',
  benchRenderer: 'Видеокарта',
  benchProgressWarmUp: 'разогрев…',
  benchProgressMeasuring: 'замер…',
  benchProgressDone: 'готово',
  benchFps: 'Кадров в секунду',
  benchFrameInterval: 'Интервал кадров, мс (медиана / 95 %)',
  benchFrameWork: 'Работа кадра в главном потоке, мс',
  benchSnapshot: 'Снимок в Worker, мс',
  benchRun: 'Прогон ядра до кадра в Worker, мс',
  benchUpload: 'Загрузка снимка на видеокарту, мс',
  benchSnapshotsPerSecond: 'Снимков в секунду',
  benchCopy: 'Скопировать итог',
  benchCopied: 'Скопировано',
  backHome: 'На главную',
  noWebgl:
    'Этот браузер не умеет WebGL 2, поэтому 3D-сцену показать нельзя. Обновите браузер или включите аппаратное ускорение графики в его настройках.',
  pagesTitle: 'Страницы превью',
  demoLink: 'Демо: пункт обслуживания',
  demoLinkAbout: '3D-сцена, люди в очереди и у окон, параметры, графики и самопроверка модели.',
  benchLink: 'Замер сцены',
  benchLinkAbout: '100 000 идущих агентов (и миллион): кадры в секунду, время кадра и снимка. Как прогнать и что прислать — на самой странице.',
  demoTitle: 'Пункт обслуживания',
  demoAbout:
    'Люди приходят, встают в очередь, идут к свободному окну, обслуживаются и уходят. Модель на блоках: Source → Queue → Service (окна — ResourcePool) → Sink; ядро считает её в Web Worker, видеокарта ведёт людей по отрезкам из снимков.',
  demoLegend: 'Где человек',
  stateToLine: 'идёт к очереди',
  stateInLine: 'ждёт в очереди',
  stateToWindow: 'идёт к окну',
  stateServed: 'у окна',
  stateOut: 'уходит',
  demoParameters: 'Параметры',
  arrivalsPerMinute: 'Приходов в минуту',
  serviceMinutes: 'Обслуживание в среднем, мин',
  windows: 'Окон открыто',
  windowsNote: 'Число окон меняет устройство модели: она собирается заново.',
  minutesPerSecond: 'Минут модели в секунду',
  load: 'Загрузка ρ = λ·s / c',
  overload: 'больше 1: очередь растёт без предела',
  demoFigures: 'Сейчас',
  inLine: 'В очереди',
  windowsBusy: 'Занято окон',
  servedTotal: 'Обслужено',
  demoLaws: 'Самопроверка модели',
  lawBalance: 'Баланс: пришли = обслужены + в системе',
  lawLittle: 'Закон Литтла: площадь под числом людей = сумма их времени в системе',
  lawUtilization: 'Загрузка окон не больше 1',
  lawHolds: 'выполняется',
  lawBroken: 'нарушен',
  demoCharts: 'Графики',
  chartQueue: 'Длина очереди, человек',
  chartUtilization: 'Загрузка окон',
  chartTimeInSystem: 'Время в системе, мин',
  seriesLastMinute: 'за последнюю минуту',
  seriesSinceStart: 'в среднем с начала',
  chartTime: 'минута модели',
};

export type Messages = Readonly<Record<keyof typeof ru, string>>;

const en: Messages = {
  title: 'Mozaika',
  subtitle: 'Open simulation modelling environment',
  status:
    'The time kernel (F0-2), process blocks (F0-3), agents with statecharts (F0-4), the kernel on typed arrays (F0-4b), blocks on kernel events with agents as entities (F0-4c), agents that move, with snapshots for a viewer (F0-6a), and the 3D scene with the demo of a service point (F0-6b) are ready. Desktop shells, system dynamics and MCP control arrive in the next Phase\u00a00 tasks.',
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
  benchTitle: 'Scene benchmark',
  benchAbout:
    'The kernel in a Web Worker drives a crowd that never stops: each person walks to a random point of the square. The graphics card draws them all by instancing and leads them along the segments of the kernel’s snapshots itself. The first 3 seconds warm up, then 10 seconds are measured.',
  benchHowTo:
    'How to measure: open the page in Chrome or Edge on Windows and in Chrome and Safari on macOS, make the window full screen, leave the mouse alone for 15 seconds, press “Copy the result” and send the text. Then the same for 1 000 000. The goal: at least 30 frames per second at 100 000 (P-18).',
  benchAgents: 'Agents',
  benchRenderer: 'Graphics card',
  benchProgressWarmUp: 'warming up…',
  benchProgressMeasuring: 'measuring…',
  benchProgressDone: 'done',
  benchFps: 'Frames per second',
  benchFrameInterval: 'Frame interval, ms (median / 95 %)',
  benchFrameWork: 'Frame work on the main thread, ms',
  benchSnapshot: 'Snapshot in the worker, ms',
  benchRun: 'Kernel run to the frame in the worker, ms',
  benchUpload: 'Snapshot upload to the graphics card, ms',
  benchSnapshotsPerSecond: 'Snapshots per second',
  benchCopy: 'Copy the result',
  benchCopied: 'Copied',
  backHome: 'Home',
  noWebgl:
    'This browser has no WebGL 2, so the 3D scene cannot be shown. Update the browser or turn on hardware acceleration of graphics in its settings.',
  pagesTitle: 'Preview pages',
  demoLink: 'Demo: a service point',
  demoLinkAbout: 'A 3D scene with people in the line and at the windows, parameters, charts and the model’s self-check.',
  benchLink: 'Scene benchmark',
  benchLinkAbout: '100 000 walking agents (and a million): frames per second, frame and snapshot times. How to run it and what to send: on the page itself.',
  demoTitle: 'Service point',
  demoAbout:
    'People come in, join the line, walk to a free window, are served and leave. A model on blocks: Source → Queue → Service (the windows are a ResourcePool) → Sink; the kernel runs it in a Web Worker, the graphics card leads the people along the segments of its snapshots.',
  demoLegend: 'Where a person is',
  stateToLine: 'walking to the line',
  stateInLine: 'waiting in the line',
  stateToWindow: 'walking to a window',
  stateServed: 'at a window',
  stateOut: 'leaving',
  demoParameters: 'Parameters',
  arrivalsPerMinute: 'Arrivals per minute',
  serviceMinutes: 'Mean service time, min',
  windows: 'Windows open',
  windowsNote: 'The number of windows changes how the model is built: it is built anew.',
  minutesPerSecond: 'Model minutes per second',
  load: 'Load ρ = λ·s / c',
  overload: 'above 1: the line grows without end',
  demoFigures: 'Now',
  inLine: 'In the line',
  windowsBusy: 'Windows busy',
  servedTotal: 'Served',
  demoLaws: 'The model’s self-check',
  lawBalance: 'Balance: arrived = served + in the system',
  lawLittle: 'Little’s law: the area under the number of people = the sum of their times in the system',
  lawUtilization: 'Windows busy at most all the time',
  lawHolds: 'holds',
  lawBroken: 'broken',
  demoCharts: 'Charts',
  chartQueue: 'Length of the line, people',
  chartUtilization: 'Utilization of the windows',
  chartTimeInSystem: 'Time in the system, min',
  seriesLastMinute: 'over the last minute',
  seriesSinceStart: 'mean since the start',
  chartTime: 'model minute',
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
