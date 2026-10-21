/**
 * Moving agents benchmark (П-18, П-32): 100 000 and 1 000 000 agents that
 * walk from one random point of a unit square to the next, at a speed that
 * makes a walk last about one unit of model time; on arriving, an agent picks
 * the next point. Prints a Markdown table, which CI also puts into the job
 * summary: units of model time per second of real time, events per second,
 * the memory an agent takes, and the time to get the whole population at
 * once — its positions (population.positions()) and a snapshot for a viewer
 * (PopulationSnapshots: ids, states, creation times and segments in a
 * transferable buffer).
 *
 * The agents move as the kernel moves them since Ф0-6а: a segment in the
 * columns of the population and one arrival event per walk. The table also
 * shows the medians of CI before Ф0-6а, when a model had to keep the segment
 * in the agent's fields, make the arrival a timeout and read every agent for
 * a snapshot (the first version of this script, commit cfa0f16).
 *
 * Memory: the garbage collector runs before and after the population is
 * built; the difference of the heap plus array buffers is the population's
 * cost, its pending arrivals in the event queue included. Needs
 * `node --expose-gc`.
 *
 * It measures the built package (dist), as other packages run it. As in the
 * other benchmarks, the speed thresholds are about ten times below the slower
 * runs in CI, so that a slow machine passes but a real regression fails.
 *
 * Run: pnpm bench
 */
import { AgentPopulation, defineStatechart, PopulationSnapshots, Simulation } from '@mozaika/kernel';

/** Node's memory report; declared here so that the benchmark needs no @types/node. */
declare const process: { memoryUsage(): { heapUsed: number; arrayBuffers: number } };
/** Node's garbage collector, present with `node --expose-gc`. */
declare const gc: (() => void) | undefined;

/**
 * Mean distance between two random points of a unit square (≈ 0.5214): at
 * this speed a walk lasts one unit of model time on average, so each agent
 * makes about one arrival per unit, like the agents of agents.ts change state.
 */
const WALK = { speed: 0.5214 };
/** Snapshots taken for each measurement of their time; the median is shown. */
const SNAPSHOTS = 9;
const MAX_BYTES_PER_AGENT = 320;

interface Scenario {
  readonly agents: number;
  /** Model time of each measured run: about agents × runLength events. */
  readonly runLength: number;
  readonly runs: number;
  readonly minTimeUnitsPerSecond: number;
  /** Before Ф0-6а, in CI: the segment in the agent's fields (commit cfa0f16; medians of 5 runs). */
  readonly before: {
    readonly timeUnitsPerSecond: number;
    readonly bytesPerAgent: number;
    readonly positionsMilliseconds: number;
    readonly snapshotMilliseconds: number;
  };
}

const SCENARIOS: readonly Scenario[] = [
  {
    agents: 100_000,
    runLength: 4,
    runs: 5,
    minTimeUnitsPerSecond: 1.2,
    // CI before: 10.6–20.4 units per second, positions 1.03–1.9 ms, snapshot 2.0–2.9 ms.
    before: { timeUnitsPerSecond: 11.9, bytesPerAgent: 337, positionsMilliseconds: 1.56, snapshotMilliseconds: 2.56 },
  },
  // The goal of П-18. Shorter runs: each unit of model time is a million events.
  {
    agents: 1_000_000,
    runLength: 0.5,
    runs: 3,
    minTimeUnitsPerSecond: 0.1,
    // CI before: 0.9–1.31 units per second, positions 11.5–18.1 ms, snapshot 22–32 ms.
    before: { timeUnitsPerSecond: 0.95, bytesPerAgent: 321, positionsMilliseconds: 11.69, snapshotMilliseconds: 29.91 },
  },
];

/** Every agent starts at the origin and walks; each arrival re-enters `walking`, which starts the next walk. */
const walker = defineStatechart({
  id: 'walker',
  initial: 'walking',
  states: {
    walking: {
      entry: ({ agent, random }) => {
        agent.moveTo({ x: random.uniform(), y: random.uniform() }, WALK);
      },
      on: { 'agent.arrived': { target: 'walking', reenter: true } },
    },
  },
});

interface Model {
  readonly simulation: Simulation;
  readonly walkers: AgentPopulation;
}

function buildModel(agents: number): Model {
  const simulation = new Simulation({ seed: 1 });
  const walkers = new AgentPopulation(simulation, { name: 'walkers', statechart: walker });
  for (let i = 0; i < agents; i++) walkers.add();
  return { simulation, walkers };
}

/** A snapshot as a viewer gets it, given back at once as the viewer would after drawing it. */
function snapshot(snapshots: PopulationSnapshots): number {
  const taken = snapshots.take();
  if (taken === undefined) throw new Error('No free snapshot buffer: every snapshot is given back');
  snapshots.giveBack(taken);
  return taken.size;
}

function collectGarbage(): void {
  if (typeof gc !== 'function') throw new Error('Run the moving agents benchmark with node --expose-gc');
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

/** The median time of `repeat` calls of `action`, in milliseconds. */
function timeOf(action: () => void, repeat: number): number {
  const durations: number[] = [];
  for (let i = 0; i < repeat; i++) {
    const started = performance.now();
    action();
    durations.push(performance.now() - started);
  }
  return median(durations);
}

interface Measurement {
  readonly scenario: Scenario;
  readonly timeUnitsPerSecond: number;
  readonly eventsPerSecond: number;
  readonly creationMilliseconds: number;
  readonly bytesPerAgent: number;
  readonly megabytes: number;
  readonly positionsMilliseconds: number;
  readonly snapshotMilliseconds: number;
}

function measure(scenario: Scenario): Measurement {
  const { agents, runLength, runs } = scenario;
  const warmUp = buildModel(Math.min(agents / 10, 100_000)); // warm up the JIT compiler
  warmUp.simulation.run(runLength);
  warmUp.walkers.positions();
  snapshot(new PopulationSnapshots(warmUp.walkers));

  collectGarbage();
  const before = usedMemory();
  const started = performance.now();
  const model = buildModel(agents);
  const creationMilliseconds = performance.now() - started;
  model.simulation.run(runLength); // every agent is now on a walk, as in a long run
  collectGarbage();
  const bytes = usedMemory() - before;

  const durations: number[] = [];
  const events: number[] = [];
  for (let run = 0; run < runs; run++) {
    const runStarted = performance.now();
    events.push(model.simulation.run(model.simulation.now + runLength).events);
    durations.push(performance.now() - runStarted);
  }
  const milliseconds = median(durations);

  // Into one array, as a model that reads the positions often would: a new array per call
  // would measure the garbage collector rather than the positions.
  const positions = new Float64Array(2 * model.walkers.size);
  const positionsMilliseconds = timeOf(() => {
    model.walkers.positions(positions);
  }, SNAPSHOTS);
  const snapshots = new PopulationSnapshots(model.walkers);
  const snapshotMilliseconds = timeOf(() => {
    snapshot(snapshots);
  }, SNAPSHOTS);
  return {
    scenario,
    timeUnitsPerSecond: (runLength / milliseconds) * 1000,
    eventsPerSecond: (median(events) / milliseconds) * 1000,
    creationMilliseconds,
    bytesPerAgent: bytes / agents,
    megabytes: bytes / 2 ** 20,
    positionsMilliseconds,
    snapshotMilliseconds,
  };
}

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const tableRow = (...cells: string[]): string => `| ${cells.join(' | ')} |`;

const measurements = SCENARIOS.map(measure);
const problems: string[] = [];
for (const { scenario, timeUnitsPerSecond, bytesPerAgent } of measurements) {
  const agents = number.format(scenario.agents);
  if (timeUnitsPerSecond < scenario.minTimeUnitsPerSecond) problems.push(`${agents} агентов: скорость ниже порога`);
  if (bytesPerAgent > MAX_BYTES_PER_AGENT) problems.push(`${agents} агентов: память выше потолка`);
}

const columns = (pick: (measurement: Measurement) => string): string[] => measurements.map(pick);
const report = [
  '',
  '### Движущиеся агенты',
  '',
  tableRow('Показатель', ...columns((m) => `${number.format(m.scenario.agents)} агентов`)),
  tableRow('---', ...columns(() => '---:')),
  tableRow('Единиц модельного времени в секунду', ...columns((m) => decimal.format(m.timeUnitsPerSecond))),
  tableRow('Событий в секунду', ...columns((m) => number.format(m.eventsPerSecond))),
  tableRow('Создание агентов, мс', ...columns((m) => number.format(m.creationMilliseconds))),
  tableRow('Память на агента, байт', ...columns((m) => number.format(m.bytesPerAgent))),
  tableRow('Память всего, МБ', ...columns((m) => decimal.format(m.megabytes))),
  tableRow('Позиции всех агентов, мс', ...columns((m) => decimal.format(m.positionsMilliseconds))),
  tableRow('Снимок популяции, мс', ...columns((m) => decimal.format(m.snapshotMilliseconds))),
  tableRow('Порог, единиц времени в секунду', ...columns((m) => decimal.format(m.scenario.minTimeUnitsPerSecond))),
  tableRow(
    'До Ф0-6а в CI: единиц времени в секунду',
    ...columns((m) => decimal.format(m.scenario.before.timeUnitsPerSecond)),
  ),
  tableRow(
    'Быстрее, чем до Ф0-6а в CI, раз',
    ...columns((m) => decimal.format(m.timeUnitsPerSecond / m.scenario.before.timeUnitsPerSecond)),
  ),
  tableRow('До Ф0-6а в CI: байт на агента', ...columns((m) => number.format(m.scenario.before.bytesPerAgent))),
  tableRow('До Ф0-6а в CI: позиции, мс', ...columns((m) => decimal.format(m.scenario.before.positionsMilliseconds))),
  tableRow('До Ф0-6а в CI: снимок, мс', ...columns((m) => decimal.format(m.scenario.before.snapshotMilliseconds))),
  '',
  'Агент идёт по прямой из одной случайной точки единичного квадрата в другую, в среднем единицу времени, ' +
    'и, придя, выбирает следующую: `moveTo` и переход по `agent.arrived`. ' +
    'Скорость — медиана нескольких отрезков модельного времени после разогрева. ' +
    'Память — прирост кучи и буферов типизированных массивов после сборки мусора, ' +
    'вместе с ожидающими прибытиями в очереди событий. ' +
    'Позиции — `population.positions(into)` в один и тот же массив; снимок — номера, состояния, ' +
    `время создания и отрезки в одном буфере (\`PopulationSnapshots\`); медиана ${String(SNAPSHOTS)} раз.`,
  `Потолок памяти: ${number.format(MAX_BYTES_PER_AGENT)} байт на агента.`,
  '«До Ф0-6а» — движение в полях агента и прибытие таймаутом, снимок обходом агентов (коммит cfa0f16), ' +
    'медианы 5 прогонов CI. Раннеры GitHub разные, отношение — ориентир (DECISIONS, П-47).',
];
if (problems.length > 0) report.push('', `**${problems.join('; ')}.**`);
console.log(report.join('\n'));

if (problems.length > 0) throw new Error(`The moving agents benchmark failed: ${problems.join('; ')}`);
