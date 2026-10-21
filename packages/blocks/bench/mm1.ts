/**
 * Speed of the blocks: the M/M/1 model built from blocks, Source → Service →
 * Sink, at ρ = 0.9 — about one million kernel events per run. Prints a
 * Markdown table, which CI also puts into the job summary, below the kernel's.
 *
 * It measures the built packages (dist), as other packages run them. As in
 * the kernel benchmark, the threshold is deliberately low: a slow CI machine
 * must not fail the build, but a real regression must.
 *
 * Run: pnpm bench
 */
import { ResourcePool, Service, Sink, Source } from '@mozaika/blocks';
import { Simulation } from '@mozaika/kernel';

const UTILIZATION = 0.9;
/**
 * Arrivals per run. Each takes about 3.9 kernel events: the arrival, the start
 * of the entity's process, the wake-up after waiting for the server (90 % of
 * entities wait) and the end of service. So 256 000 arrivals make about a million events.
 */
const ARRIVALS = 256_000;
const RUNS = 5;
const MIN_EVENTS_PER_SECOND = 150_000;

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
const tableRow = (...cells: string[]): string => `| ${cells.join(' | ')} |`;

const { events, milliseconds } = measure();
const eventsPerSecond = (events / milliseconds) * 1000;
const tooSlow = eventsPerSecond < MIN_EVENTS_PER_SECOND;

const report = [
  '',
  '### Скорость блоков',
  '',
  tableRow('Сценарий', 'Событий', 'Время, мс', 'Событий в секунду'),
  tableRow('---', '---:', '---:', '---:'),
  tableRow(
    'M/M/1 на блоках, ρ = 0,9 (Source → Service → Sink)',
    number.format(events),
    number.format(milliseconds),
    number.format(eventsPerSecond),
  ),
  '',
  `Медиана из ${String(RUNS)} прогонов после разогрева. ` +
    `Порог: не меньше ${number.format(MIN_EVENTS_PER_SECOND)} событий в секунду.`,
];
if (tooSlow) report.push('', '**Ниже порога.**');
console.log(report.join('\n'));

if (tooSlow) {
  throw new Error(`The blocks are slower than ${String(MIN_EVENTS_PER_SECOND)} events per second`);
}
