import {
  expectLittlesLaw,
  expectMeasuresInIntervals,
  mmc,
  type ReplicationEstimates,
  type RunLength,
} from '@mozaika/blocks/test-support';
import { type PopulationSnapshot, PopulationSnapshots, Random, Simulation, type Snapshot } from '@mozaika/kernel';
import { REPLICATIONS } from '@mozaika/kernel/test-support';
import { KernelHost, type KernelReply } from '@mozaika/kernel/worker';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildServicePoint,
  PERSON_STATES,
  SERVICE_POINT_DEFAULTS,
  servicePoint,
  type ServicePointParameters,
  type ServicePointRecord,
} from './service-point.js';
import { EXIT, lineSpot, windowSpot } from './service-point-layout.js';
import { checkLaws } from './service-point-laws.js';

/**
 * The demo "service point" (Ф0-6б): Source → Queue → Service with a pool of
 * windows → Sink, on the blocks, with people that walk in, to the windows and out.
 * The tests check what the scene shows (the places of the line, the windows,
 * the way out), the laws of the model on every record (its self-check), and
 * the M/M/c formulas, as the tests of the blocks do.
 */

const SEED = 20_261_021;

interface Scenario {
  readonly name: string;
  readonly parameters: ServicePointParameters;
}

const SCENARIOS: readonly Scenario[] = [
  { name: 'the defaults (ρ = 0.8)', parameters: SERVICE_POINT_DEFAULTS },
  { name: 'one window', parameters: { arrivalsPerMinute: 0.3, windows: 1, serviceMinutes: 2.5 } },
  // More arrive than the windows serve: the line grows past the places in the hall.
  { name: 'an overload (ρ = 3)', parameters: { arrivalsPerMinute: 2.4, windows: 2, serviceMinutes: 2.5 } },
  { name: 'all the windows, a light flow', parameters: { arrivalsPerMinute: 0.4, windows: 8, serviceMinutes: 4 } },
  // Service shorter than the walk to the window: most are served on the way and walk on to the window first.
  { name: 'a quick service', parameters: { arrivalsPerMinute: 3, windows: 2, serviceMinutes: 0.1 } },
];

function samePoint(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}

interface Walk {
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
}

/** Where each person of a snapshot walks from and to (its segment), by state. */
function walksByState(snapshot: PopulationSnapshot, stateNames: readonly string[]): Map<string, Walk[]> {
  const walks = new Map<string, Walk[]>(stateNames.map((name) => [name, []]));
  const at = (cell: number): number => snapshot.segments[cell] ?? Number.NaN;
  for (let row = 0; row < snapshot.size; row++) {
    const state = stateNames[snapshot.states[row] ?? 0] ?? '?';
    const cell = 6 * row;
    walks.get(state)?.push({ from: { x: at(cell), y: at(cell + 1) }, to: { x: at(cell + 2), y: at(cell + 3) } });
  }
  return walks;
}

/** Points in a fixed order, so that two lists of the same points compare equal. */
function sorted(points: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  return [...points].sort((a, b) => a.x - b.x || a.y - b.y);
}

/** Float32 copies of points, as a snapshot holds them. */
function inFloat32(point: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.fround(point.x), y: Math.fround(point.y) };
}

describe.each(SCENARIOS)('service point: $name', ({ parameters }) => {
  it('has people walk to the places of the line, to free windows and out, as the blocks move them', () => {
    const model = buildServicePoint(new Simulation({ seed: SEED }), parameters);
    const snapshots = new PopulationSnapshots(model.people);
    const stateNames = model.people.statechart.stateNames;
    const open = Array.from({ length: parameters.windows }, (_, index) => inFloat32(windowSpot(index)));
    const atAWindow = (point: { x: number; y: number }): boolean => open.some((spot) => samePoint(spot, point));
    const seen = new Set<string>();
    for (let time = 0.5; time <= 240; time += 0.5) {
      model.simulation.run(time);
      const snapshot = snapshots.take();
      if (snapshot === undefined) throw new Error('no snapshot');
      const walks = walksByState(snapshot, stateNames);
      const targets = (...states: string[]): { x: number; y: number }[] =>
        states.flatMap((state) => (walks.get(state) ?? []).map((walk) => walk.to));

      // The k-th person of the line stands at (or walks to) the k-th place, in the order they came.
      const places = Array.from({ length: model.line.stats.length.current }, (_, place) => inFloat32(lineSpot(place)));
      expect(sorted(targets('entering', 'waiting'))).toEqual(sorted(places));
      // Each person served has a window of their own, one of those open.
      const atWindows = targets('toWindow', 'served');
      expect(atWindows).toHaveLength(model.windows.busy);
      expect(atWindows.every(atAWindow)).toBe(true);
      expect(new Set(atWindows.map(({ x, y }) => `${String(x)},${String(y)}`)).size).toBe(atWindows.length);
      // Served on the way, a person still walks on to the window; everyone leaves from a window, through the exit.
      expect(targets('finishing').every(atAWindow)).toBe(true);
      for (const walk of walks.get('leaving') ?? []) {
        expect(walk.to).toEqual(inFloat32(EXIT));
        expect(atAWindow(walk.from)).toBe(true);
      }

      for (const [state, list] of walks) if (list.length > 0) seen.add(state);
      snapshots.giveBack(snapshot);
    }
    // Every stage of the way is seen, the line on a busy flow, being served on the way when the service is
    // quick; a person who is gone is no longer in the population.
    const load = (parameters.arrivalsPerMinute * parameters.serviceMinutes) / parameters.windows;
    const expected = ['toWindow', 'served', 'leaving'];
    if (load >= 0.5) expected.push('entering', 'waiting');
    if (parameters.serviceMinutes < 0.5) expected.push('finishing');
    for (const state of expected) expect(seen, state).toContain(state);
    expect(seen).not.toContain('gone');
  });

  it('keeps its laws on every record: balance, Little on the sample path, windows busy within bounds', () => {
    const model = buildServicePoint(new Simulation({ seed: SEED }), parameters);
    model.simulation.run(600);
    const records = model.records.take();
    expect(records).toHaveLength(601);
    for (const record of records) {
      const failed = checkLaws(record).filter((check) => !check.holds);
      expect(failed, `t = ${String(record.time)}`).toEqual([]);
    }
    const last = records.at(-1)?.data;
    expect(last?.left).toBeGreaterThan(100);
    if (parameters.arrivalsPerMinute * parameters.serviceMinutes > parameters.windows) {
      expect(last?.inLine).toBeGreaterThan(200);
    }
  });
});

describe('service point', () => {
  it('names the states of a person as its statechart does, in the same order', () => {
    const model = buildServicePoint(new Simulation({ seed: SEED }), SERVICE_POINT_DEFAULTS);
    expect(model.people.statechart.stateNames).toEqual(PERSON_STATES);
  });
});

describe('service point laws', () => {
  /** A record that keeps every law, from the defaults run for a while. */
  function goodRecord(): Snapshot<ServicePointRecord> {
    const model = buildServicePoint(new Simulation({ seed: SEED }), SERVICE_POINT_DEFAULTS);
    model.simulation.run(120);
    const record = model.records.take().at(-1);
    if (record === undefined) throw new Error('no record');
    return record;
  }

  it('catch a record that has lost a person, time in the system or a window', () => {
    const record = goodRecord();
    const broken = (change: Partial<ServicePointRecord>): string[] =>
      checkLaws({ time: record.time, data: { ...record.data, ...change } })
        .filter((check) => !check.holds)
        .map((check) => check.law);
    expect(broken({})).toEqual([]);
    expect(broken({ left: record.data.left + 1 })).toEqual(['balance']);
    expect(broken({ inLine: record.data.inLine + 1 })).toEqual(['balance']);
    expect(broken({ timeOfLeft: record.data.timeOfLeft * 1.001 })).toEqual(['little']);
    expect(broken({ busy: record.data.windows + 1, atWindows: record.data.windows + 1 })).toContain('utilization');
    expect(broken({ busyArea: record.data.windows * record.time * 1.01 })).toEqual(['utilization']);
  });
});

/**
 * M/M/c on the demo: with exponential times between arrivals and of service,
 * the line and the windows are an M/M/c queue, whatever the people do on the
 * way. Replication and deletion as in the tests of the blocks
 * (packages/blocks/src/mmc.test.ts).
 */
describe('service point against M/M/c', () => {
  const parameters = SERVICE_POINT_DEFAULTS;
  const runLength: RunLength = { warmUp: 1_000, window: 30_000 };

  function replication(random: Random): ReplicationEstimates {
    const { simulation, line, service, windows, out } = buildServicePoint(new Simulation({ random }), parameters);
    simulation.run(runLength.warmUp);
    for (const block of [line, service, windows, out]) block.resetStatistics();
    simulation.run(runLength.warmUp + runLength.window);
    return {
      inSystem: line.stats.length.mean + service.stats.content.mean,
      waiting: line.stats.length.mean,
      timeInSystem: out.stats.timeInSystem.mean,
      waitTime: line.stats.waitTime.mean,
      utilization: windows.utilization,
      throughput: out.stats.timeInSystem.count / runLength.window,
      lossFraction: 0,
    };
  }

  let replications: ReplicationEstimates[] = [];

  beforeAll(() => {
    replications = Array.from({ length: REPLICATIONS }, (_, k) =>
      replication(new Random(SEED, ['replication', String(k)])),
    );
  }, 120_000);

  it('matches L, Lq, W, Wq (Erlang C) and utilization within the 99.9 % confidence interval', () => {
    const { arrivalsPerMinute, serviceMinutes, windows } = parameters;
    expectMeasuresInIntervals(mmc(arrivalsPerMinute, 1 / serviceMinutes, windows), replications);
  });

  it("obeys Little's law L = λW, on average over the replications", () => {
    expectLittlesLaw(replications);
  });
});

describe('service point in the kernel host', () => {
  function recordsOf(reply: KernelReply): Snapshot<ServicePointRecord>[] {
    if (reply.type !== 'ran') throw new Error(`expected a run, got ${JSON.stringify(reply)}`);
    return (reply.records ?? []) as Snapshot<ServicePointRecord>[];
  }

  it('changes the flow while it runs, and opens as many windows as it is built with', () => {
    const host = new KernelHost({ servicePoint });
    host.handle({
      type: 'build',
      id: 1,
      model: 'servicePoint',
      seed: SEED,
      parameters: { arrivalsPerMinute: 0.5, windows: 3 },
    });
    const calm = recordsOf(host.handle({ type: 'run', id: 2, until: 200 }).reply).at(-1)?.data;
    host.handle({ type: 'set', id: 3, parameter: 'arrivalsPerMinute', value: 4 });
    const busy = recordsOf(host.handle({ type: 'run', id: 4, until: 400 }).reply).at(-1)?.data;
    expect(calm?.windows).toBe(3);
    // Poisson counts: 100 and 800 expected; the bounds are about four standard deviations wide.
    expect(calm?.arrived).toBeGreaterThan(60);
    expect(calm?.arrived).toBeLessThan(140);
    const later = (busy?.arrived ?? 0) - (calm?.arrived ?? 0);
    expect(later).toBeGreaterThan(690);
    expect(later).toBeLessThan(910);
  });

  it('runs the same in the host as without it, by the seed', () => {
    const host = new KernelHost({ servicePoint });
    host.handle({ type: 'build', id: 1, model: 'servicePoint', seed: SEED });
    const viaHost = [55.5, 130, 180].flatMap((until, index) =>
      recordsOf(host.handle({ type: 'run', id: index + 2, until }).reply),
    );
    const alone = buildServicePoint(new Simulation({ seed: SEED }), SERVICE_POINT_DEFAULTS);
    alone.simulation.run(180);
    expect(viaHost).toEqual(alone.records.take());
  });
});
