import { type ProcessBody, Simulation, timeout } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { ResourcePool, Service, Source } from './index.js';
import { containing, Recorder, simulationError } from './test-support/helpers.js';

/**
 * A process that asks for a unit at `requestAt`, holds it for `holdFor` and
 * logs when it got the unit. `requestPriority` orders its request among the
 * events of the same moment (larger is later).
 */
function* worker(
  sim: Simulation,
  pool: ResourcePool,
  log: string[],
  name: string,
  requestAt: number,
  holdFor: number,
  requestPriority = 0,
): ProcessBody {
  yield timeout(requestAt, { priority: requestPriority });
  yield* pool.seize();
  log.push(`${name} seized at ${String(sim.now)}`);
  yield timeout(holdFor);
  pool.release();
}

describe('ResourcePool', () => {
  it('hands out free units at once, without an event', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { name: 'tellers', capacity: 2 });
    const log: string[] = [];
    function* customer(): ProcessBody {
      yield* pool.seize();
      log.push(`seized at ${String(sim.now)}, busy ${String(pool.busy)}`);
      yield* pool.seize();
      log.push(`seized at ${String(sim.now)}, busy ${String(pool.busy)}`);
    }
    sim.process(customer());
    const { events } = sim.run();
    expect(log).toEqual(['seized at 0, busy 1', 'seized at 0, busy 2']);
    expect(events).toBe(1); // only the process start
    expect(pool.available).toBe(0);
  });

  it('serves waiting requests strictly in the order they were made', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { capacity: 1 });
    const log: string[] = [];
    sim.process(worker(sim, pool, log, 'holder', 0, 10));
    // Created in a scrambled order, but requesting at times 3, 1, 2.
    sim.process(worker(sim, pool, log, 'c', 3, 1));
    sim.process(worker(sim, pool, log, 'a', 1, 1));
    sim.process(worker(sim, pool, log, 'b', 2, 1));
    sim.run(5);
    expect(pool.waiting).toBe(3);
    sim.run();
    expect(log).toEqual(['holder seized at 0', 'a seized at 10', 'b seized at 11', 'c seized at 12']);
  });

  it('gives a released unit to the first waiting request, not to a newcomer at the same moment', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { capacity: 1 });
    const log: string[] = [];
    sim.process(worker(sim, pool, log, 'holder', 0, 5)); // releases at 5
    sim.process(worker(sim, pool, log, 'waiter', 1, 1));
    // The newcomer asks at 5 after the release (priority 1 puts it after the
    // other events of that moment): the unit is already the waiter's.
    sim.process(worker(sim, pool, log, 'newcomer', 5, 1, 1));
    sim.run();
    expect(log).toEqual(['holder seized at 0', 'waiter seized at 5', 'newcomer seized at 6']);
  });

  it('lets granted requests go on in the order the units were granted', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { capacity: 2 });
    const log: string[] = [];
    function* holder(): ProcessBody {
      yield* pool.seize();
      yield* pool.seize();
      yield timeout(5);
      pool.release(); // goes to the waiter, who has not gone on yet
      pool.release(); // becomes free
      yield* pool.seize(); // takes the free unit, but goes on after the waiter
      log.push(`holder seized again at ${String(sim.now)}`);
    }
    sim.process(holder());
    sim.process(worker(sim, pool, log, 'waiter', 1, 1));
    sim.run();
    expect(log).toEqual(['waiter seized at 5', 'holder seized again at 5']);
  });

  it('counts busy, available and waiting units', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { capacity: 2 });
    const log: string[] = [];
    for (const name of ['a', 'b', 'c']) sim.process(worker(sim, pool, log, name, 0, 4));
    sim.run(1);
    expect([pool.busy, pool.available, pool.waiting]).toEqual([2, 0, 1]);
    sim.run(4);
    // At 4 both units are released; one goes to the waiting request.
    expect([pool.busy, pool.available, pool.waiting]).toEqual([1, 1, 0]);
  });

  it('takes a free unit with trySeize, and never waits', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { capacity: 1 });
    expect(pool.trySeize()).toBe(true);
    expect(pool.trySeize()).toBe(false);
    expect(pool.busy).toBe(1);
    pool.release();
    expect(pool.available).toBe(1);
  });

  it('measures utilization as the time-average share of busy units', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { capacity: 2 });
    const log: string[] = [];
    sim.process(worker(sim, pool, log, 'long', 0, 6)); // busy on [0, 6)
    sim.process(worker(sim, pool, log, 'short', 4, 2)); // busy on [4, 6)
    sim.run(8);
    // Busy units: 1 on [0, 4), 2 on [4, 6), 0 on [6, 8): area 8 over 8 time units.
    expect(pool.stats.busy.mean).toBeCloseTo(1, 12);
    expect(pool.utilization).toBeCloseTo(0.5, 12);
    pool.resetStatistics();
    sim.run(10);
    expect(pool.utilization).toBe(0);
  });

  it('refuses to release a unit nobody holds', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { name: 'tellers', capacity: 1 });
    expect(() => {
      pool.release();
    }).toThrow(simulationError('INVALID_STATE', { message: containing('"tellers"') }));
  });

  it('refuses capacities that are not positive whole numbers', () => {
    const sim = new Simulation();
    for (const capacity of [0, -1, 1.5]) {
      expect(() => new ResourcePool(sim, { capacity })).toThrow(simulationError('INVALID_ARGUMENT'));
    }
    expect(() => new ResourcePool(sim, { capacity: Number.NaN })).toThrow(simulationError('NOT_A_NUMBER'));
    expect(() => new ResourcePool(sim, { capacity: Infinity })).toThrow(simulationError('NOT_FINITE'));
  });
});

/**
 * A Service fed by a source of entities at the given times: the entities ask
 * the pool for a unit on arrival, and `log` records when each starts service
 * (the service time is drawn then).
 */
function serviceArrivingAt(sim: Simulation, pool: ResourcePool, log: string[], times: readonly number[], duration = 1): Recorder {
  let previous = 0;
  const intervals = times.map((time) => {
    const interval = time - previous;
    previous = time;
    return interval;
  });
  let next = 0;
  const source = new Source(sim, { name: 'arrivals', interval: () => intervals[next++] ?? 0, limit: times.length });
  let started = 0;
  return source
    .connect(
      new Service(sim, {
        name: 'desk',
        pool,
        duration: () => {
          started++;
          log.push(`entity ${String(started)} seized at ${String(sim.now)}`);
          return duration;
        },
      }),
    )
    .connect(new Recorder(sim));
}

describe('ResourcePool shared by blocks and processes', () => {
  it('serves blocks and processes in one queue, in the order they asked', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { name: 'clerk', capacity: 1 });
    const log: string[] = [];
    sim.process(worker(sim, pool, log, 'holder', 0, 5)); // releases at 5
    serviceArrivingAt(sim, pool, log, [1, 2]); // the entities ask at 1 and 2
    sim.process(worker(sim, pool, log, 'process', 1.5, 1)); // the process asks between them
    sim.run();
    expect(log).toEqual([
      'holder seized at 0',
      'entity 1 seized at 5',
      'process seized at 6',
      'entity 2 seized at 7',
    ]);
  });

  it('gives a released unit to a waiting process, not to an entity arriving at the same moment', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { name: 'clerk', capacity: 1 });
    const log: string[] = [];
    sim.process(worker(sim, pool, log, 'holder', 0, 5)); // releases at 5
    sim.process(worker(sim, pool, log, 'waiter', 1, 1));
    serviceArrivingAt(sim, pool, log, [5]);
    sim.run();
    expect(log).toEqual(['holder seized at 0', 'waiter seized at 5', 'entity 1 seized at 6']);
  });

  it('gives a released unit to a waiting entity, not to a process asking at the same moment', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { name: 'clerk', capacity: 1 });
    const log: string[] = [];
    sim.process(worker(sim, pool, log, 'holder', 0, 5)); // releases at 5
    serviceArrivingAt(sim, pool, log, [1]);
    // The newcomer asks at 5 after the release (priority 1 puts it after the other events of that moment).
    sim.process(worker(sim, pool, log, 'newcomer', 5, 1, 1));
    sim.run();
    expect(log).toEqual(['holder seized at 0', 'entity 1 seized at 5', 'newcomer seized at 6']);
  });

  it('lets blocks and processes go on in the order their units were granted', () => {
    for (const processFirst of [true, false]) {
      const sim = new Simulation();
      const pool = new ResourcePool(sim, { name: 'clerks', capacity: 2 });
      const log: string[] = [];
      function* holder(): ProcessBody {
        yield* pool.seize();
        yield* pool.seize();
        yield timeout(5);
        pool.release();
        pool.release();
      }
      sim.process(holder());
      // Both wait from before 5 and get their units at 5: they go on in the order they asked.
      sim.process(worker(sim, pool, log, 'process', processFirst ? 1 : 3, 1));
      serviceArrivingAt(sim, pool, log, [2]);
      sim.run();
      expect(log).toEqual(processFirst ? ['process seized at 5', 'entity 1 seized at 5'] : ['entity 1 seized at 5', 'process seized at 5']);
    }
  });

  it('lets an entity that finds a free unit go on after a process granted one earlier at the same moment', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { name: 'clerks', capacity: 2 });
    const log: string[] = [];
    function* holder(): ProcessBody {
      yield* pool.seize();
      yield* pool.seize();
      yield timeout(5);
      pool.release(); // goes to the waiter, who has not gone on yet
      pool.release(); // becomes free
    }
    sim.process(holder());
    sim.process(worker(sim, pool, log, 'waiter', 1, 1));
    // Arrives at 5 after the releases and takes the free unit, but goes on after the waiter.
    serviceArrivingAt(sim, pool, log, [5]);
    sim.run();
    expect(log).toEqual(['waiter seized at 5', 'entity 1 seized at 5']);
  });
});
