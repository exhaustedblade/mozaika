/**
 * A crowd in one block (П-18, П-31): 100 000 entities at once in a Delay.
 * Source (Poisson arrivals, 100 000 per unit of model time) → Delay
 * (exponential, mean 1) → Sink, the M/M/∞ queue: in the steady state about
 * 100 000 entities are in the Delay, and every unit of model time 100 000 come
 * in and 100 000 leave. Prints a Markdown table, which CI also puts into the
 * job summary: units of model time per second of real time, events per
 * second, and the memory each entity in the Delay takes.
 *
 * Memory: the garbage collector runs before the model is built and once it is
 * full; the difference of the heap plus array buffers, divided by the number
 * of entities in the Delay, is what one entity costs — its object, whatever
 * the blocks keep for it and its pending event. Needs `node --expose-gc`.
 *
 * It measures the built packages (dist), as other packages run them. As in
 * the other benchmarks, the speed threshold is about ten times below the
 * slower runs in CI, so that a slow machine passes but a real regression
 * fails. The memory ceiling is the goal of Ф0-4в: a third of what the blocks
 * on processes took. Memory hardly depends on the machine.
 *
 * The table also shows the blocks on processes before Ф0-4в, as measured in
 * CI, and how many times better the blocks on events are. GitHub's runners
 * differ by up to two times on this scenario, so the ratio is only a guide;
 * compare several runs (docs/DECISIONS.md, П-41).
 *
 * Run: pnpm bench
 */
import { Delay, Sink, Source } from '@mozaika/blocks';
import { Simulation } from '@mozaika/kernel';

/** Node's memory report; declared here so that the benchmark needs no @types/node. */
declare const process: { memoryUsage(): { heapUsed: number; arrayBuffers: number } };
/** Node's garbage collector, present with `node --expose-gc`. */
declare const gc: (() => void) | undefined;

/** Entities in the Delay on average: arrivals per unit of time × mean delay (Little's law). */
const CROWD = 100_000;
/**
 * Model time before the measurement: the number in an M/M/∞ queue started
 * empty approaches its mean like 1 − exp(−t) for a mean delay of 1, so after
 * 8 units it is within 0.04 % of it.
 */
const FILL_TIME = 8;
/** Model time of each measured run: about 2–3 events per entity, 100 000 entities per unit. */
const RUN_LENGTH = 1;
const RUNS = 5;
/** CI on the blocks on events: 7–16 units per second, depending on the runner. */
const MIN_TIME_UNITS_PER_SECOND = 0.7;
const MAX_BYTES_PER_ENTITY = 220;
/** The blocks on processes before Ф0-4в, in CI: the median of 5 runs (commits 7aac769–8a59f3a, 21.10.2026). */
const BEFORE = { timeUnitsPerSecond: 3.26, bytesPerEntity: 663 };

interface CrowdModel {
  readonly simulation: Simulation;
  readonly delay: Delay;
}

function buildModel(crowd: number): CrowdModel {
  const simulation = new Simulation({ seed: 1 });
  const source = new Source(simulation, { name: 'arrivals', interval: (random) => random.exponential(1 / crowd) });
  const delay = source.connect(new Delay(simulation, { name: 'crowd', duration: (random) => random.exponential(1) }));
  delay.connect(new Sink(simulation, { name: 'exit' }));
  return { simulation, delay };
}

function collectGarbage(): void {
  if (typeof gc !== 'function') throw new Error('Run the crowded delay benchmark with node --expose-gc');
  // Twice: the first pass may leave objects that only become garbage once others are gone.
  gc();
  gc();
}

function usedMemory(): number {
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

interface Measurement {
  readonly timeUnitsPerSecond: number;
  readonly eventsPerSecond: number;
  readonly inDelay: number;
  readonly bytesPerEntity: number;
  readonly megabytes: number;
}

function measure(): Measurement {
  buildModel(CROWD / 10).simulation.run(FILL_TIME); // warm up the JIT compiler

  collectGarbage();
  const before = usedMemory();
  const { simulation, delay } = buildModel(CROWD);
  simulation.run(FILL_TIME);
  collectGarbage();
  const bytes = usedMemory() - before;
  const inDelay = delay.stats.content.current;

  const durations: number[] = [];
  const events: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const started = performance.now();
    events.push(simulation.run(simulation.now + RUN_LENGTH).events);
    durations.push(performance.now() - started);
  }
  const milliseconds = median(durations);
  return {
    timeUnitsPerSecond: (RUN_LENGTH / milliseconds) * 1000,
    eventsPerSecond: (median(events) / milliseconds) * 1000,
    inDelay,
    bytesPerEntity: bytes / inDelay,
    megabytes: bytes / 2 ** 20,
  };
}

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const tableRow = (...cells: string[]): string => `| ${cells.join(' | ')} |`;

const measurement = measure();
const problems: string[] = [];
if (measurement.timeUnitsPerSecond < MIN_TIME_UNITS_PER_SECOND) problems.push('скорость ниже порога');
if (measurement.bytesPerEntity > MAX_BYTES_PER_ENTITY) problems.push('память выше потолка');

const report = [
  '',
  '### 100 000 сущностей одновременно в Delay',
  '',
  tableRow('Показатель', 'Значение'),
  tableRow('---', '---:'),
  tableRow('Единиц модельного времени в секунду', decimal.format(measurement.timeUnitsPerSecond)),
  tableRow('Событий в секунду', number.format(measurement.eventsPerSecond)),
  tableRow('Сущностей в Delay при замере памяти', number.format(measurement.inDelay)),
  tableRow('Память на сущность, байт', number.format(measurement.bytesPerEntity)),
  tableRow('Память всего, МБ', decimal.format(measurement.megabytes)),
  tableRow('До Ф0-4в в CI: единиц времени в секунду', decimal.format(BEFORE.timeUnitsPerSecond)),
  tableRow('Быстрее, чем до Ф0-4в в CI, раз', decimal.format(measurement.timeUnitsPerSecond / BEFORE.timeUnitsPerSecond)),
  tableRow('До Ф0-4в в CI: байт на сущность', number.format(BEFORE.bytesPerEntity)),
  tableRow('Меньше памяти, чем до Ф0-4в, раз', decimal.format(BEFORE.bytesPerEntity / measurement.bytesPerEntity)),
  '',
  'Source (пуассоновский поток, 100 000 в единицу времени) → Delay (экспоненциальная задержка, среднее 1) → Sink: ' +
    'в Delay в среднем 100 000 сущностей, за единицу времени 100 000 входят и 100 000 выходят. ' +
    `Скорость — медиана ${String(RUNS)} отрезков модельного времени после заполнения. ` +
    'Память — прирост кучи и буферов типизированных массивов после сборки мусора на одну сущность в Delay, ' +
    'вместе с её ожидающим событием.',
  `Порог: не меньше ${decimal.format(MIN_TIME_UNITS_PER_SECOND)} единицы времени в секунду; ` +
    `потолок памяти: ${number.format(MAX_BYTES_PER_ENTITY)} байт на сущность.`,
  '«До Ф0-4в» — блоки на процессах, медиана 5 прогонов CI (коммиты 7aac769–8a59f3a). Раннеры GitHub разные: ' +
    'на этом сценарии один и тот же код работает на них с разницей до двух раз, поэтому отношение — ориентир; ' +
    'сравнение по нескольким прогонам — в DECISIONS, П-41.',
];
if (problems.length > 0) report.push('', `**${problems.join('; ')}.**`);
console.log(report.join('\n'));

if (problems.length > 0) throw new Error(`The crowded delay benchmark failed: ${problems.join('; ')}`);
