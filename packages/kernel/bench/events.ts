/**
 * Kernel speed benchmark: fires 1 000 000 events in each scenario and prints a
 * Markdown table, which CI also puts into the job summary.
 *
 * It measures the built package (dist), as other packages run it. The threshold
 * is deliberately low: a slow CI machine must not fail the build, but a real
 * regression, such as a queue that degrades to linear time, must.
 *
 * Run: pnpm bench
 */
import { type ProcessBody, Simulation, timeout } from '@mozaika/kernel';

const EVENTS = 1_000_000;
/** Events waiting in the queue at any moment: the size of the heap. */
const PENDING = 1_000;
const RUNS = 5;
const MIN_EVENTS_PER_SECOND = 250_000;

interface Scenario {
  /** Shown to the project owner in the job summary, so in Russian. */
  readonly title: string;
  /** Builds a model that fires exactly `events` events. */
  readonly build: (events: number) => Simulation;
}

interface Measurement {
  readonly scenario: Scenario;
  readonly milliseconds: number;
  readonly eventsPerSecond: number;
}

/**
 * The classic "hold" benchmark for event queues: each event schedules the next
 * one with a random delay, so the queue keeps a constant size.
 */
function holdModel(events: number): Simulation {
  const sim = new Simulation({ seed: 1 });
  const delays = sim.random.stream('delays');
  let left = events - PENDING;
  const hold = (): void => {
    if (left > 0) {
      left--;
      sim.schedule(delays.exponential(1), hold);
    }
  };
  for (let i = 0; i < PENDING; i++) sim.schedule(delays.exponential(1), hold);
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
  { title: 'Очередь событий (hold-модель, 1000 событий в очереди)', build: holdModel },
  { title: 'Процессы (1000 процессов, yield timeout)', build: processModel },
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function measure(scenario: Scenario): Measurement {
  scenario.build(EVENTS / 10).run(); // warm up the JIT compiler
  const durations: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const sim = scenario.build(EVENTS);
    const started = performance.now();
    const { events } = sim.run();
    durations.push(performance.now() - started);
    if (events !== EVENTS) {
      throw new Error(`${scenario.title}: fired ${String(events)} events instead of ${String(EVENTS)}`);
    }
  }
  const milliseconds = median(durations);
  return { scenario, milliseconds, eventsPerSecond: (EVENTS / milliseconds) * 1000 };
}

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const tableRow = (...cells: string[]): string => `| ${cells.join(' | ')} |`;

const measurements = SCENARIOS.map(measure);
const tooSlow = measurements
  .filter((measurement) => measurement.eventsPerSecond < MIN_EVENTS_PER_SECOND)
  .map((measurement) => measurement.scenario.title);

const report = [
  '### Скорость ядра',
  '',
  tableRow('Сценарий', 'Событий', 'Время, мс', 'Событий в секунду'),
  tableRow('---', '---:', '---:', '---:'),
  ...measurements.map(({ scenario, milliseconds, eventsPerSecond }) =>
    tableRow(scenario.title, number.format(EVENTS), number.format(milliseconds), number.format(eventsPerSecond)),
  ),
  '',
  `Медиана из ${String(RUNS)} прогонов после разогрева. ` +
    `Порог: не меньше ${number.format(MIN_EVENTS_PER_SECOND)} событий в секунду в каждом сценарии.`,
];
if (tooSlow.length > 0) report.push('', `**Ниже порога:** ${tooSlow.join('; ')}.`);
console.log(report.join('\n'));

if (tooSlow.length > 0) {
  throw new Error(`The kernel is slower than ${String(MIN_EVENTS_PER_SECOND)} events per second`);
}
