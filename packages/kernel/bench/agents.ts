/**
 * Agents benchmark (П-18): 100 000 and 1 000 000 agents with a simple
 * statechart — two states, A → B and B → A at rate 1 — so every agent changes
 * state about once per unit of model time. Prints a Markdown table, which CI
 * also puts into the job summary: how many units of model time pass per second
 * of real time, events per second, the time to create the agents, and the
 * memory they take.
 *
 * Memory: the garbage collector runs before and after the population is
 * built; the difference of the heap plus array buffers (where typed arrays
 * live) is the population's cost, its pending timeouts in the event queue
 * included. Needs `node --expose-gc`.
 *
 * It measures the built package (dist), as other packages run it. As in the
 * other benchmarks, the speed thresholds are about ten times below the speed
 * measured in CI, so that a slow machine passes but a real regression fails.
 * The memory ceiling is the goal of the kernel on typed arrays (Ф0-4б, П-27):
 * at most 250 bytes per agent. Memory hardly depends on the machine.
 *
 * The table also shows the kernel before Ф0-4б, as measured in CI, and how
 * many times faster the kernel is now; the ratio is meaningful in CI only.
 *
 * Run: pnpm bench
 */
import { AgentPopulation, defineStatechart, rate, Simulation } from '@mozaika/kernel';

/** Node's memory report; declared here so that the benchmark needs no @types/node. */
declare const process: { memoryUsage(): { heapUsed: number; arrayBuffers: number } };
/** Node's garbage collector, present with `node --expose-gc`. */
declare const gc: (() => void) | undefined;

const MAX_BYTES_PER_AGENT = 250;

interface Scenario {
  readonly agents: number;
  /** Model time of each measured run: about agents × runLength events. */
  readonly runLength: number;
  readonly runs: number;
  readonly minTimeUnitsPerSecond: number;
  /** The kernel of objects before Ф0-4б, in CI (commit 47903fe, 21.10.2026). */
  readonly before: { readonly timeUnitsPerSecond: number; readonly bytesPerAgent: number };
}

const SCENARIOS: readonly Scenario[] = [
  {
    agents: 100_000,
    runLength: 4,
    runs: 5,
    // CI on the kernel of typed arrays: 14–22 units per second, depending on the runner.
    minTimeUnitsPerSecond: 1.5,
    before: { timeUnitsPerSecond: 6.51, bytesPerAgent: 344 },
  },
  // The goal of П-18. Shorter runs: each unit of model time is a million events.
  {
    agents: 1_000_000,
    runLength: 0.5,
    runs: 3,
    // CI: 0.8–1.0 units per second.
    minTimeUnitsPerSecond: 0.08,
    before: { timeUnitsPerSecond: 0.31, bytesPerAgent: 345 },
  },
];

const flip = defineStatechart(
  { id: 'flip', initial: 'A', states: { A: { after: { toB: 'B' } }, B: { after: { toA: 'A' } } } },
  { delays: { toB: rate(1), toA: rate(1) } },
);

function buildModel(agents: number): Simulation {
  const sim = new Simulation({ seed: 1 });
  const population = new AgentPopulation(sim, { name: 'flips', statechart: flip });
  for (let i = 0; i < agents; i++) population.add();
  return sim;
}

function collectGarbage(): void {
  if (typeof gc !== 'function') throw new Error('Run the agents benchmark with node --expose-gc');
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
  readonly scenario: Scenario;
  readonly timeUnitsPerSecond: number;
  readonly eventsPerSecond: number;
  readonly creationMilliseconds: number;
  readonly bytesPerAgent: number;
  readonly megabytes: number;
}

function measure(scenario: Scenario): Measurement {
  const { agents, runLength, runs } = scenario;
  buildModel(Math.min(agents / 10, 100_000)).run(runLength); // warm up the JIT compiler

  collectGarbage();
  const before = usedMemory();
  const started = performance.now();
  const sim = buildModel(agents);
  const creationMilliseconds = performance.now() - started;
  sim.run(runLength); // every agent now waits on one timeout, as in a long run
  collectGarbage();
  const bytes = usedMemory() - before;

  const durations: number[] = [];
  const events: number[] = [];
  for (let run = 0; run < runs; run++) {
    const runStarted = performance.now();
    events.push(sim.run(sim.now + runLength).events);
    durations.push(performance.now() - runStarted);
  }
  const milliseconds = median(durations);
  return {
    scenario,
    timeUnitsPerSecond: (runLength / milliseconds) * 1000,
    eventsPerSecond: (median(events) / milliseconds) * 1000,
    creationMilliseconds,
    bytesPerAgent: bytes / agents,
    megabytes: bytes / 2 ** 20,
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
  '### Агенты с диаграммой из двух состояний',
  '',
  tableRow('Показатель', ...columns((m) => `${number.format(m.scenario.agents)} агентов`)),
  tableRow('---', ...columns(() => '---:')),
  tableRow('Единиц модельного времени в секунду', ...columns((m) => decimal.format(m.timeUnitsPerSecond))),
  tableRow('Событий в секунду', ...columns((m) => number.format(m.eventsPerSecond))),
  tableRow('Создание агентов, мс', ...columns((m) => number.format(m.creationMilliseconds))),
  tableRow('Память на агента, байт', ...columns((m) => number.format(m.bytesPerAgent))),
  tableRow('Память всего, МБ', ...columns((m) => decimal.format(m.megabytes))),
  tableRow('Порог, единиц времени в секунду', ...columns((m) => decimal.format(m.scenario.minTimeUnitsPerSecond))),
  tableRow(
    'До Ф0-4б в CI: единиц времени в секунду',
    ...columns((m) => decimal.format(m.scenario.before.timeUnitsPerSecond)),
  ),
  tableRow(
    'Быстрее, чем до Ф0-4б в CI, раз',
    ...columns((m) => decimal.format(m.timeUnitsPerSecond / m.scenario.before.timeUnitsPerSecond)),
  ),
  tableRow('До Ф0-4б в CI: байт на агента', ...columns((m) => number.format(m.scenario.before.bytesPerAgent))),
  '',
  'Переходы A → B и B → A с интенсивностью 1: каждый агент меняет состояние в среднем раз за единицу времени. ' +
    'Скорость — медиана нескольких отрезков модельного времени после разогрева. ' +
    'Память — прирост кучи и буферов типизированных массивов после сборки мусора, ' +
    'вместе с ожидающими таймаутами в очереди событий.',
  `Потолок памяти: ${number.format(MAX_BYTES_PER_AGENT)} байт на агента.`,
];
if (problems.length > 0) report.push('', `**${problems.join('; ')}.**`);
console.log(report.join('\n'));

if (problems.length > 0) throw new Error(`The agents benchmark failed: ${problems.join('; ')}`);
