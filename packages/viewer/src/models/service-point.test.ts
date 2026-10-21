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
  EXIT_MINUTES,
  SERVICE_POINT_DEFAULTS,
  servicePoint,
  type ServicePointParameters,
  type ServicePointRecord,
} from './service-point.js';
import { EXIT, lineSpot, windowSpot } from './service-point-layout.js';
import { checkLaws } from './service-point-laws.js';

/**
 * The demo "service point" (Ф0-6б): Source → Queue → Service with a pool of
 * windows → Delay (the way out) → Sink, on the blocks, with people that walk.
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
];

function samePoint(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Where each person of a snapshot is going (the end of the segment), by state. */
function targetsByState(
  snapshot: PopulationSnapshot,
  stateNames: readonly string[],
): Map<string, { x: number; y: number }[]> {
  const targets = new Map<string, { x: number; y: number }[]>(stateNames.map((name) => [name, []]));
  for (let row = 0; row < snapshot.size; row++) {
    const state = stateNames[snapshot.states[row] ?? 0] ?? '?';
    const x = snapshot.segments[6 * row + 2] ?? Number.NaN;
    const y = snapshot.segments[6 * row + 3] ?? Number.NaN;
    targets.get(state)?.push({ x, y });
  }
  return targets;
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
    const open = Array.from({ length: parameters.windows }, (_, window) => inFloat32(windowSpot(window)));
    const seen = new Set<string>();
    for (let time = 0.5; time <= 240; time += 0.5) {
      model.simulation.run(time);
      const snapshot = snapshots.take();
      if (snapshot === undefined) throw new Error('no snapshot');
      const targets = targetsByState(snapshot, stateNames);
      const inLine = [...(targets.get('entering') ?? []), ...(targets.get('waiting') ?? [])];
      const atWindows = [...(targets.get('toWindow') ?? []), ...(targets.get('served') ?? [])];

      // The k-th person of the line stands at (or walks to) the k-th place, in the order they came.
      const places = Array.from({ length: model.line.stats.length.current }, (_, place) => inFloat32(lineSpot(place)));
      expect(sorted(inLine)).toEqual(sorted(places));
      // Each person served has a window of their own, one of those open.
      expect(atWindows).toHaveLength(model.windows.busy);
      for (const target of atWindows) expect(open.some((spot) => samePoint(spot, target))).toBe(true);
      expect(new Set(atWindows.map(({ x, y }) => `${String(x)},${String(y)}`)).size).toBe(atWindows.length);
      // Those served go out through the exit.
      for (const target of targets.get('leaving') ?? []) expect(target).toEqual(inFloat32(EXIT));

      for (const [state, list] of targets) if (list.length > 0) seen.add(state);
      snapshots.giveBack(snapshot);
    }
    // Every stage of the way is seen; on a light flow nobody needs to wait in line.
    const load = (parameters.arrivalsPerMinute * parameters.serviceMinutes) / parameters.windows;
    const expected = load >= 0.5 ? stateNames : stateNames.filter((state) => !['entering', 'waiting'].includes(state));
    expect([...seen].sort()).toEqual([...expected].sort());
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
 * way; the way out adds a constant to the time in the system. Replication and
 * deletion as in the tests of the blocks (packages/blocks/src/mmc.test.ts).
 */
describe('service point against M/M/c', () => {
  const parameters = SERVICE_POINT_DEFAULTS;
  const runLength: RunLength = { warmUp: 1_000, window: 30_000 };

  function replication(random: Random): ReplicationEstimates {
    const { simulation, line, service, windows, exit, sink } = buildServicePoint(new Simulation({ random }), parameters);
    simulation.run(runLength.warmUp);
    for (const block of [line, service, windows, exit, sink]) block.resetStatistics();
    simulation.run(runLength.warmUp + runLength.window);
    return {
      inSystem: line.stats.length.mean + service.stats.content.mean,
      waiting: line.stats.length.mean,
      timeInSystem: sink.stats.timeInSystem.mean - EXIT_MINUTES,
      waitTime: line.stats.waitTime.mean,
      utilization: windows.utilization,
      throughput: sink.stats.timeInSystem.count / runLength.window,
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
