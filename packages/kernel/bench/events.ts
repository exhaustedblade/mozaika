/**
 * Kernel speed benchmark: fires a fixed number of events in each scenario and
 * prints a Markdown table, which CI also puts into the job summary.
 *
 * It measures the built package (dist), as other packages run it. The
 * thresholds are deliberately low: a slow CI machine must not fail the build,
 * but a real regression, such as a queue that degrades to linear time, must.
 *
 * Run: pnpm bench
 */
import { type ProcessBody, Simulation, timeout } from '@mozaika/kernel';

const EVENTS = 1_000_000;
/** Events waiting in the queue at any moment: the size of the queue. */
const PENDING = 1_000;
/** A queue as large as a population of 100 000 agents keeps it: one pending timeout per agent. */
const LARGE_PENDING = 100_000;
/** The queue of a population of a million agents (П-18). */
const MILLION_PENDING = 1_000_000;
/** Each of the million pending events fires about twice per run. */
const MILLION_EVENTS = 2_000_000;
const RUNS = 5;
const MIN_EVENTS_PER_SECOND = 250_000;
/** About ten times below the 4-ary heap in CI (Ф0-4д): a queue of a million does not fit in the cache. */
const MIN_MILLION_EVENTS_PER_SECOND = 100_000;

interface Scenario {
  /** Shown to the project owner in the job summary, so in Russian. */
  readonly title: string;
  /** Events fired in each measured run. */
  readonly events: number;
  /** Builds a model that fires exactly `events` events. */
  readonly build: (events: number) => Simulation;
  readonly minEventsPerSecond: number;
  /**
   * Events per second of the kernel of objects before Ф0-4б, in CI (commit
   * 47903fe, 21.10.2026); undefined for scenarios added later.
   */
  readonly before: number | undefined;
}

interface Measurement {
  readonly scenario: Scenario;
  readonly milliseconds: number;
  readonly eventsPerSecond: number;
}

/**
 * The classic "hold" benchmark for event queues: each event schedules the next
 * one with a random delay, so the queue keeps a constant size, `pending`, until
 * the last `pending` events drain it.
 */
function holdModel(events: number, pending: number): Simulation {
  const sim = new Simulation({ seed: 1 });
  const delays = sim.random.stream('delays');
  let left = events - pending;
  const hold = (): void => {
    if (left > 0) {
      left--;
      sim.schedule(delays.exponential(1), hold);
    }
  };
  for (let i = 0; i < pending; i++) sim.schedule(delays.exponential(1), hold);
  return sim;
}

/**
 * The hold model without the drain: every event schedules the next one and the
 * run stops after `events` events, so all of them fire from a queue of
 * `pending`. For a queue of a million, draining it as `holdModel` does would
 * make a third of the run a shrinking queue.
 */
function steadyHoldModel(events: number, pending: number): Simulation {
  const sim = new Simulation({ seed: 1 });
  const delays = sim.random.stream('delays');
  let left = events;
  const hold = (): void => {
    left--;
    if (left === 0) sim.stop();
    sim.schedule(delays.exponential(1), hold);
  };
  for (let i = 0; i < pending; i++) sim.schedule(delays.exponential(1), hold);
  return sim;
}

/** The same load through processes: every start and every timeout is one event. */
function processModel(events: number): Simulation {
  const sim = new Simulation({ seed: 1 });
  const delays = sim.random.stream('delays');
  let left = events - PENDING;
  function* worker(): ProcessBody {
    while (left > 0) {
      left--;
      yield timeout(delays.exponential(1));
    }
  }
  for (let i = 0; i < PENDING; i++) sim.process(worker());
  return sim;
}

const SCENARIOS: readonly Scenario[] = [
  {
    title: 'Очередь событий (hold-модель, 1000 событий в очереди)',
    events: EVENTS,
    build: (events) => holdModel(events, PENDING),
    minEventsPerSecond: MIN_EVENTS_PER_SECOND,
    before: 3_978_853,
  },
  {
    title: 'Большая очередь событий (hold-модель, 100 000 событий в очереди)',
    events: EVENTS,
    build: (events) => holdModel(events, LARGE_PENDING),
    minEventsPerSecond: MIN_EVENTS_PER_SECOND,
    before: 1_499_359,
  },
  {
    title: 'Очередь на миллион событий (hold-модель без опустошения, 1 000 000 событий в очереди)',
    events: MILLION_EVENTS,
    build: (events) => steadyHoldModel(events, MILLION_PENDING),
    minEventsPerSecond: MIN_MILLION_EVENTS_PER_SECOND,
    before: undefined,
  },
  {
    title: 'Процессы (1000 процессов, yield timeout)',
    events: EVENTS,
    build: processModel,
    minEventsPerSecond: MIN_EVENTS_PER_SECOND,
    before: 3_303_698,
  },
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function measure(scenario: Scenario): Measurement {
  scenario.build(scenario.events / 10).run(); // warm up the JIT compiler
  const durations: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const sim = scenario.build(scenario.events);
    const started = performance.now();
    const { events } = sim.run();
    durations.push(performance.now() - started);
    if (events !== scenario.events) {
      throw new Error(`${scenario.title}: fired ${String(events)} events instead of ${String(scenario.events)}`);
    }
  }
  const milliseconds = median(durations);
  return { scenario, milliseconds, eventsPerSecond: (scenario.events / milliseconds) * 1000 };
}

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const tableRow = (...cells: string[]): string => `| ${cells.join(' | ')} |`;

const measurements = SCENARIOS.map(measure);
const tooSlow = measurements
  .filter((measurement) => measurement.eventsPerSecond < measurement.scenario.minEventsPerSecond)
  .map((measurement) => measurement.scenario.title);

const report = [
  '### Скорость ядра',
  '',
  tableRow('Сценарий', 'Событий', 'Время, мс', 'Событий в секунду', 'До Ф0-4б в CI', 'Быстрее, раз'),
  tableRow('---', '---:', '---:', '---:', '---:', '---:'),
  ...measurements.map(({ scenario, milliseconds, eventsPerSecond }) =>
    tableRow(
      scenario.title,
      number.format(scenario.events),
      number.format(milliseconds),
      number.format(eventsPerSecond),
      scenario.before === undefined ? '—' : number.format(scenario.before),
      scenario.before === undefined ? '—' : decimal.format(eventsPerSecond / scenario.before),
    ),
  ),
  '',
  `Медиана из ${String(RUNS)} прогонов после разогрева. ` +
    `Порог: не меньше ${number.format(MIN_EVENTS_PER_SECOND)} событий в секунду, ` +
    `у очереди на миллион — ${number.format(MIN_MILLION_EVENTS_PER_SECOND)}.`,
  '«До Ф0-4б» — ядро из объектов в одном прогоне CI (коммит 47903fe). Раннеры GitHub разные: ' +
    'один и тот же код на них работает с разницей до 1,6 раза, поэтому отношение — ориентир; ' +
    'сравнение по нескольким прогонам — в DECISIONS, П-36. Очередь на миллион появилась в Ф0-4д.',
];
if (tooSlow.length > 0) report.push('', `**Ниже порога:** ${tooSlow.join('; ')}.`);
console.log(report.join('\n'));

if (tooSlow.length > 0) throw new Error(`The kernel is below its speed threshold: ${tooSlow.join('; ')}`);
