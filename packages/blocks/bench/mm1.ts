/**
 * Speed of the blocks: the M/M/1 model built from blocks, Source → Service →
 * Sink, at ρ = 0.9. Prints a Markdown table, which CI also puts into the job
 * summary, below the kernel's.
 *
 * It measures the built packages (dist), as other packages run them. As in
 * the kernel benchmark, the threshold is deliberately low — about ten times
 * below the slower runs in CI — so a slow machine must not fail the build,
 * but a real regression must. The table also shows the entities per second
 * of the blocks on processes before Ф0-4в, as measured in CI.
 *
 * Run: pnpm bench
 */
import { ResourcePool, Service, Sink, Source } from '@mozaika/blocks';
import { Simulation } from '@mozaika/kernel';

const UTILIZATION = 0.9;
/**
 * Arrivals per run. Each takes about 2.9 kernel events: the arrival, the grant
 * of the server to the 90 % of entities that wait for it, and the end of
 * service — about 744 000 events in all. Before Ф0-4в, the blocks ran a
 * process per entity, whose start was one more event, so the same model made
 * a million. The table therefore also shows entities per second, which does
 * not depend on how many events an entity takes.
 */
const ARRIVALS = 256_000;
const RUNS = 5;
/** CI on the blocks on events: 4.0–7.8 million events per second, depending on the runner. */
const MIN_EVENTS_PER_SECOND = 400_000;
/** Entities per second of the blocks on processes before Ф0-4в, in CI: the median of 14 runs (21.10.2026). */
const ENTITIES_PER_SECOND_BEFORE = 675_000;

/** Builds M/M/1 with mean service time 1 and a source that stops after `arrivals`. */
function mm1Model(arrivals: number): Simulation {
  const sim = new Simulation({ seed: 1 });
  const server = new ResourcePool(sim, { name: 'server', capacity: 1 });
  const source = new Source(sim, {
    name: 'arrivals',
    interval: (random) => random.exponential(1 / UTILIZATION),
    limit: arrivals,
  });
  const service = new Service(sim, { name: 'service', pool: server, duration: (random) => random.exponential(1) });
  source.connect(service).connect(new Sink(sim, { name: 'exit' }));
  return sim;
}

interface Measurement {
  readonly events: number;
  readonly milliseconds: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function measure(): Measurement {
  mm1Model(ARRIVALS / 10).run(); // warm up the JIT compiler
  const durations: number[] = [];
  let events = 0;
  for (let run = 0; run < RUNS; run++) {
    const sim = mm1Model(ARRIVALS);
    const started = performance.now();
    events = sim.run().events; // the same seed gives the same count in every run
    durations.push(performance.now() - started);
  }
  return { events, milliseconds: median(durations) };
}

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const tableRow = (...cells: string[]): string => `| ${cells.join(' | ')} |`;

const { events, milliseconds } = measure();
const eventsPerSecond = (events / milliseconds) * 1000;
const entitiesPerSecond = (ARRIVALS / milliseconds) * 1000;
const tooSlow = eventsPerSecond < MIN_EVENTS_PER_SECOND;

const report = [
  '',
  '### Скорость блоков',
  '',
  tableRow(
    'Сценарий',
    'Событий',
    'Время, мс',
    'Событий в секунду',
    'Сущностей в секунду',
    'До Ф0-4в в CI, сущностей в секунду',
    'Быстрее, раз',
  ),
  tableRow('---', '---:', '---:', '---:', '---:', '---:', '---:'),
  tableRow(
    'M/M/1 на блоках, ρ = 0,9 (Source → Service → Sink)',
    number.format(events),
    number.format(milliseconds),
    number.format(eventsPerSecond),
    number.format(entitiesPerSecond),
    number.format(ENTITIES_PER_SECOND_BEFORE),
    decimal.format(entitiesPerSecond / ENTITIES_PER_SECOND_BEFORE),
  ),
  '',
  `${number.format(ARRIVALS)} приходов. Медиана из ${String(RUNS)} прогонов после разогрева. ` +
    `Порог: не меньше ${number.format(MIN_EVENTS_PER_SECOND)} событий в секунду.`,
  'С Ф0-4в на сущность приходится около 2,9 события вместо 3,9: у неё больше нет своего процесса, ' +
    'поэтому та же модель даёт меньше событий, а скорость модели лучше видна в сущностях в секунду. ' +
    '«До Ф0-4в» — блоки на процессах, медиана 14 прогонов CI; раннеры разные, отношение — ориентир (DECISIONS, П-41).',
];
if (tooSlow) report.push('', '**Ниже порога.**');
console.log(report.join('\n'));

if (tooSlow) {
  throw new Error(`The blocks are slower than ${String(MIN_EVENTS_PER_SECOND)} events per second`);
}
