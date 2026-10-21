/**
 * Moving agents benchmark (П-18, П-32): 100 000 and 1 000 000 agents that
 * walk from one random point of a unit square to the next, at a speed that
 * makes a walk last about one unit of model time; on arriving, an agent picks
 * the next point. Prints a Markdown table, which CI also puts into the job
 * summary: units of model time per second of real time, events per second,
 * the memory an agent takes, and the time of a snapshot of the whole
 * population — its positions alone, and every column a viewer gets.
 *
 * This first version moves the agents as a model has to without movement in
 * the kernel: the segment of the walk is kept in the agent's fields, the
 * arrival is a timeout, and a snapshot reads every agent's fields. It is the
 * measurement "before" Ф0-6а, taken by CI with the same script.
 *
 * Memory: the garbage collector runs before and after the population is
 * built; the difference of the heap plus array buffers is the population's
 * cost, its pending arrivals in the event queue included. Needs
 * `node --expose-gc`.
 *
 * It measures the built package (dist), as other packages run it.
 *
 * Run: pnpm bench
 */
import { AgentPopulation, defineStatechart, Simulation } from '@mozaika/kernel';

/** Node's memory report; declared here so that the benchmark needs no @types/node. */
declare const process: { memoryUsage(): { heapUsed: number; arrayBuffers: number } };
/** Node's garbage collector, present with `node --expose-gc`. */
declare const gc: (() => void) | undefined;

/**
 * Mean distance between two random points of a unit square (≈ 0.5214): at
 * this speed a walk lasts one unit of model time on average, so each agent
 * makes about one arrival per unit, like the agents of agents.ts change state.
 */
const SPEED = 0.5214;
/** Snapshots taken for each measurement of their time; the median is shown. */
const SNAPSHOTS = 9;

interface Scenario {
  readonly agents: number;
  /** Model time of each measured run: about agents × runLength events. */
  readonly runLength: number;
  readonly runs: number;
}

const SCENARIOS: readonly Scenario[] = [
  { agents: 100_000, runLength: 4, runs: 5 },
  // The goal of П-18. Shorter runs: each unit of model time is a million events.
  { agents: 1_000_000, runLength: 0.5, runs: 3 },
];

/** The walk an agent is on, in its fields: from where, to where, when it started and when it arrives. */
interface Walk {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  start: number;
  arrival: number;
}

/** Where a walker is at `time`: on the straight line of its walk, or at its end once it has arrived. */
function walkerX(walk: Walk, time: number): number {
  if (time >= walk.arrival) return walk.toX;
  return walk.fromX + (walk.toX - walk.fromX) * ((time - walk.start) / (walk.arrival - walk.start));
}

function walkerY(walk: Walk, time: number): number {
  if (time >= walk.arrival) return walk.toY;
  return walk.fromY + (walk.toY - walk.fromY) * ((time - walk.start) / (walk.arrival - walk.start));
}

/** Every agent starts at the origin and walks; each arrival re-enters `walking`, which starts the next walk. */
const walker = defineStatechart<Walk>(
  {
    id: 'walker',
    initial: 'walking',
    context: { fromX: 0, fromY: 0, toX: 0, toY: 0, start: 0, arrival: 0 },
    states: {
      walking: {
        entry: ({ context: walk, now, random }) => {
          const x = walkerX(walk, now);
          const y = walkerY(walk, now);
          walk.fromX = x;
          walk.fromY = y;
          walk.toX = random.uniform();
          walk.toY = random.uniform();
          walk.start = now;
          walk.arrival = now + Math.hypot(walk.toX - x, walk.toY - y) / SPEED;
        },
        after: { arrival: { target: 'walking', reenter: true } },
      },
    },
  },
  { delays: { arrival: ({ context: walk, now }) => walk.arrival - now } },
);

interface Model {
  readonly simulation: Simulation;
  readonly walkers: AgentPopulation<Walk>;
}

function buildModel(agents: number): Model {
  const simulation = new Simulation({ seed: 1 });
  const walkers = new AgentPopulation(simulation, { name: 'walkers', statechart: walker });
  for (let i = 0; i < agents; i++) walkers.add();
  return { simulation, walkers };
}

/** The positions of all agents now, x and y of each in turn, as a viewer would draw them. */
function positions(model: Model, into: Float32Array): void {
  const now = model.simulation.now;
  let cell = 0;
  for (const agent of model.walkers.agents) {
    into[cell++] = walkerX(agent.context, now);
    into[cell++] = walkerY(agent.context, now);
  }
}

/** Every column a viewer gets: ids, states, creation times and positions. */
function snapshot(model: Model, positionsInto: Float32Array): number {
  const ids = model.walkers.ids();
  const states = model.walkers.stateCodes();
  const createdAt = new Float64Array(model.walkers.size);
  model.walkers.agents.forEach((agent, row) => {
    createdAt[row] = agent.createdAt;
  });
  positions(model, positionsInto);
  return ids.length + states.length + createdAt.length;
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
  snapshot(warmUp, new Float32Array(2 * warmUp.walkers.size));

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

  const into = new Float32Array(2 * model.walkers.size);
  const positionsMilliseconds = timeOf(() => {
    positions(model, into);
  }, SNAPSHOTS);
  const snapshotMilliseconds = timeOf(() => {
    snapshot(model, into);
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
  '',
  'Агент идёт по прямой из одной случайной точки единичного квадрата в другую, в среднем единицу времени, ' +
    'и, придя, выбирает следующую. Движение — в полях агента, прибытие — таймаут: так модель двигала агентов ' +
    'до Ф0-6а. Скорость — медиана нескольких отрезков модельного времени после разогрева. ' +
    'Память — прирост кучи и буферов типизированных массивов после сборки мусора, ' +
    'вместе с ожидающими прибытиями в очереди событий. ' +
    `Снимок — номера, состояния, время создания и позиции (x, y во Float32Array); медиана ${String(SNAPSHOTS)} снимков.`,
];
console.log(report.join('\n'));
