import { type EventInfo, type ProcessBody, Simulation, timeout } from '@mozaika/kernel';
import { fingerprint } from '@mozaika/kernel/test-support';
import { describe, expect, it } from 'vitest';

import { Delay, type EntityReceiver, Queue, ResourcePool, Service, Sink, Source } from './index.js';
import { Recorder } from './test-support/helpers.js';

/**
 * A flow that uses every block and the kernel features under them: random
 * intervals and durations, a full Queue and Delay (blocking), two units of a
 * pool handed over in FIFO order, lost arrivals. `end` builds the block the
 * flow ends in. Returns the blocks, to read their statistics.
 */
function buildFlow<End extends EntityReceiver>(sim: Simulation, end: (sim: Simulation) => End) {
  const clerks = new ResourcePool(sim, { name: 'clerks', capacity: 2 });
  const source = new Source(sim, { name: 'door', interval: (random) => random.exponential(0.6) });
  const hall = source.connect(new Queue(sim, { name: 'hall', capacity: 4 }));
  const desk = hall.connect(
    new Service(sim, { name: 'desk', pool: clerks, duration: (random) => random.exponential(1.1), capacity: 2 }),
  );
  const corridor = desk.connect(
    new Delay(sim, { name: 'corridor', duration: (random) => random.uniform(0, 3), capacity: 3 }),
  );
  const exit = corridor.connect(end(sim));
  return { clerks, source, hall, desk, corridor, exit };
}

/** The trace of every event of the flow as "time priority #seq label". */
function traceOfFlow(seed: number): string[] {
  const trace: string[] = [];
  const traceLine = (event: EventInfo): string =>
    `${String(event.time)} ${String(event.priority)} #${String(event.seq)} ${event.label ?? ''}`;
  const sim = new Simulation({ seed, trace: (event) => trace.push(traceLine(event)) });
  buildFlow(sim, () => new Sink(sim, { name: 'exit' }));
  sim.run(300);
  return trace;
}

/**
 * What happened in the flow, rather than which events made it happen: who
 * left when, the losses and every statistic, as lines. Numbers are printed
 * in full, so equal lines mean equal bits.
 */
function outcomesOfFlow(seed: number): string[] {
  const sim = new Simulation({ seed });
  const { clerks, source, hall, desk, corridor, exit } = buildFlow(sim, () => new Recorder(sim, 'exit'));
  sim.run(300);
  return [
    ...exit.visits.map((visit) => `${String(visit.id)} ${String(visit.time)}`),
    `arrivals ${String(source.arrivals)} lost ${String(source.lost)}`,
    `hall ${String(hall.stats.length.mean)} ${String(hall.stats.waitTime.mean)} ${String(hall.stats.waitTime.count)}`,
    `desk ${String(desk.stats.queueLength.mean)} ${String(desk.stats.content.mean)} ${String(desk.stats.waitTime.mean)} ${String(desk.stats.waitTime.count)}`,
    `clerks ${String(clerks.utilization)} ${String(clerks.busy)}`,
    `corridor ${String(corridor.stats.content.mean)} ${String(corridor.stats.content.current)}`,
  ];
}

/**
 * Two sources and a process of the model share a pool of two clerks: walk-ins
 * at random, calls every time unit to a desk that holds three, and a manager
 * who takes a clerk every two time units. Integer and half-integer times
 * make many events simultaneous. Returns who left when, the manager's tasks,
 * the losses and the pool, as lines.
 */
function outcomesOfSharedPool(seed: number): string[] {
  const sim = new Simulation({ seed });
  const clerks = new ResourcePool(sim, { name: 'clerks', capacity: 2 });
  const tasks: string[] = [];
  const exit = new Recorder(sim, 'exit');
  const walkIns = new Source(sim, { name: 'walk-ins', interval: (random) => random.exponential(1.5) });
  const calls = new Source(sim, { name: 'calls', interval: 1, limit: 150 });
  walkIns
    .connect(new Service(sim, { name: 'counter', pool: clerks, duration: (random) => random.exponential(1) }))
    .connect(exit);
  calls.connect(new Service(sim, { name: 'phone', pool: clerks, duration: 0.5, capacity: 3 })).connect(exit);
  const paperwork = sim.random.stream('paperwork');
  function* manager(): ProcessBody {
    for (let task = 1; task <= 60; task++) {
      yield timeout(2);
      yield* clerks.seize();
      tasks.push(`task ${String(task)} at ${String(sim.now)}`);
      yield timeout(paperwork.exponential(0.8));
      clerks.release();
    }
  }
  sim.process(manager(), { name: 'manager' });
  sim.run(200);
  return [
    ...exit.visits.map((visit) => `${String(visit.id)} ${String(visit.time)}`),
    ...tasks,
    `walk-ins ${String(walkIns.arrivals)} ${String(walkIns.lost)} calls ${String(calls.arrivals)} ${String(calls.lost)}`,
    `clerks ${String(clerks.utilization)} ${String(clerks.busy)} ${String(clerks.waiting)}`,
  ];
}

describe('blocks on the kernel', () => {
  it('give an identical trace for the same seed and a different one for another seed', () => {
    const first = traceOfFlow(2026);
    expect(first.length).toBeGreaterThan(1_000);
    expect(traceOfFlow(2026)).toEqual(first);
    expect(traceOfFlow(2027)).not.toEqual(first);
  });

  it('fire the events recorded for the blocks on kernel events', () => {
    // Recorded when the blocks moved to kernel events (Ф0-4в). The blocks on
    // processes fired 2 200 events here (fingerprint e267f3ce): 511 of the
    // source and 1 689 of the processes of the entities. Now 1 791: the
    // source's 511 are as before, the 409 starts of entity processes (one per
    // arrival that got in) are gone, and the other entity events remain one
    // for one as events of the blocks — 403 ends of service, 401 ends of
    // delay, 348 places at the desk and 128 in the corridor granted to waiting
    // entities. Their numbers are lower by the starts that no longer take one.
    const trace = traceOfFlow(2026);
    expect({ events: trace.length, fingerprint: fingerprint(trace) }).toEqual({
      events: 1791,
      fingerprint: 'c004c997',
    });
    expect(trace.slice(0, 6)).toEqual([
      '0 0 #0 door',
      '0.24420428898192564 0 #1 door',
      '0.41928868011488407 0 #3 door',
      '0.4429266748670181 0 #5 door',
      '0.46523077629104115 0 #4 desk: door#2 service ends',
      '0.46523077629104115 0 #7 desk places → door#3 at hall',
    ]);
  });

  it('give the same outcomes as the blocks on processes before Ф0-4в', () => {
    // Recorded with the blocks of commit d533e30, which ran every entity as a
    // kernel process: the same exits at the same times, the same losses and
    // statistics, bit for bit, although the events that make them differ.
    const flow = outcomesOfFlow(2026);
    expect({ lines: flow.length, fingerprint: fingerprint(flow) }).toEqual({ lines: 406, fingerprint: '35832b97' });
    const sharedPool = outcomesOfSharedPool(2026);
    expect({ lines: sharedPool.length, fingerprint: fingerprint(sharedPool) }).toEqual({
      lines: 342,
      fingerprint: 'a15b60a4',
    });
  });
});
