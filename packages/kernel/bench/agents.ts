/**
 * Agents benchmark (П-18): 100 000 agents with a simple statechart — two
 * states, A → B and B → A at rate 1 — so every agent changes state about once
 * per unit of model time. Prints a Markdown table, which CI also puts into the
 * job summary: how many units of model time pass per second of real time,
 * events per second, the time to create the agents, and the memory they take.
 *
 * Memory: the garbage collector runs before and after the population is
 * built; the difference of the heap plus array buffers (where typed arrays
 * live) is the population's cost, its pending timeouts in the event queue
 * included. Needs `node --expose-gc`.
 *
 * It measures the built package (dist), as other packages run it. As in the
 * other benchmarks, the speed threshold is about ten times below the measured
 * speed, so that a slow CI machine passes but a real regression fails; the
 * memory ceiling is about ten times above the measured size.
 *
 * Run: pnpm bench
 */
import { AgentPopulation, defineStatechart, rate, Simulation } from '@mozaika/kernel';

/** Node's memory report; declared here so that the benchmark needs no @types/node. */
declare const process: { memoryUsage(): { heapUsed: number; arrayBuffers: number } };
/** Node's garbage collector, present with `node --expose-gc`. */
declare const gc: (() => void) | undefined;

const AGENTS = 100_000;
/** Model time of each measured run: about AGENTS × RUN_LENGTH events. */
const RUN_LENGTH = 4;
const RUNS = 5;
const MIN_TIME_UNITS_PER_SECOND = 0.5;
const MAX_BYTES_PER_AGENT = 5_000;

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
  readonly creationMilliseconds: number;
  readonly bytes: number;
  readonly runMilliseconds: number;
  readonly runEvents: number;
}

function measure(): Measurement {
  buildModel(AGENTS / 10).run(RUN_LENGTH); // warm up the JIT compiler

  collectGarbage();
  const before = usedMemory();
  const started = performance.now();
  const sim = buildModel(AGENTS);
  const creationMilliseconds = performance.now() - started;
  sim.run(1); // every agent now waits on one timeout, as in a long run
  collectGarbage();
  const bytes = usedMemory() - before;

  const durations: number[] = [];
  const events: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const runStarted = performance.now();
    events.push(sim.run(sim.now + RUN_LENGTH).events);
    durations.push(performance.now() - runStarted);
  }
  return { creationMilliseconds, bytes, runMilliseconds: median(durations), runEvents: median(events) };
}

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const tableRow = (...cells: string[]): string => `| ${cells.join(' | ')} |`;

const { creationMilliseconds, bytes, runMilliseconds, runEvents } = measure();
const timeUnitsPerSecond = (RUN_LENGTH / runMilliseconds) * 1000;
const eventsPerSecond = (runEvents / runMilliseconds) * 1000;
const bytesPerAgent = bytes / AGENTS;
const problems: string[] = [];
if (timeUnitsPerSecond < MIN_TIME_UNITS_PER_SECOND) problems.push('скорость ниже порога');
if (bytesPerAgent > MAX_BYTES_PER_AGENT) problems.push('память выше потолка');

const report = [
  '',
  `### Агенты: ${number.format(AGENTS)} с диаграммой из двух состояний`,
  '',
  tableRow('Показатель', 'Значение'),
  tableRow('---', '---:'),
  tableRow('Единиц модельного времени в секунду', decimal.format(timeUnitsPerSecond)),
  tableRow('Событий в секунду', number.format(eventsPerSecond)),
  tableRow(`Создание ${number.format(AGENTS)} агентов, мс`, number.format(creationMilliseconds)),
  tableRow('Память на агента, байт', number.format(bytesPerAgent)),
  tableRow('Память всего, МБ', decimal.format(bytes / 2 ** 20)),
  '',
  'Переходы A → B и B → A с интенсивностью 1: каждый агент меняет состояние в среднем раз за единицу времени. ' +
    `Скорость — медиана из ${String(RUNS)} отрезков по ${String(RUN_LENGTH)} ед. модельного времени после разогрева. ` +
    'Память — прирост кучи и буферов типизированных массивов после сборки мусора, ' +
    'вместе с ожидающими таймаутами в очереди событий.',
  `Порог: не меньше ${decimal.format(MIN_TIME_UNITS_PER_SECOND)} единицы времени в секунду; ` +
    `потолок памяти: ${number.format(MAX_BYTES_PER_AGENT)} байт на агента.`,
];
if (problems.length > 0) report.push('', `**${problems.join('; ')}.**`);
console.log(report.join('\n'));

if (problems.length > 0) throw new Error(`The agents benchmark failed: ${problems.join('; ')}`);
