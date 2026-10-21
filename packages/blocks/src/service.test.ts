import { Random, Simulation } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { ResourcePool, Service, Sink, Source } from './index.js';
import { containing, Recorder, simulationError } from './test-support/helpers.js';

/** Source (arrivals at 1, 2, 3) → Service with one server and service time 1.5 → Recorder. */
function oneServer() {
  const sim = new Simulation();
  const servers = new ResourcePool(sim, { name: 'servers', capacity: 1 });
  const source = new Source(sim, { name: 'arrivals', interval: 1, limit: 3 });
  const service = source.connect(new Service(sim, { name: 'desk', pool: servers, duration: 1.5 }));
  const recorder = service.connect(new Recorder(sim));
  return { sim, servers, source, service, recorder };
}

describe('Service', () => {
  it('queues, seizes a unit, serves and releases it, in this order', () => {
    const { sim, service, servers, recorder } = oneServer();
    sim.run();
    // Service on [1, 2.5), [2.5, 4), [4, 5.5): entities 2 and 3 wait 0.5 and 1.
    expect(recorder.visits).toEqual([
      { id: 1, time: 2.5 },
      { id: 2, time: 4 },
      { id: 3, time: 5.5 },
    ]);
    expect(service.stats.waitTime.count).toBe(3);
    expect(service.stats.waitTime.mean).toBeCloseTo((0 + 0.5 + 1) / 3, 12);
    expect(servers.busy).toBe(0);
  });

  it('measures queue length, content and utilization over time', () => {
    const { sim, service, servers } = oneServer();
    sim.run();
    const end = sim.now; // 5.5
    // Waiting: one entity on [2, 2.5) and on [3, 4): area 1.5.
    expect(service.stats.queueLength.mean).toBeCloseTo(1.5 / end, 12);
    // In the block: times in it are 1.5, 2 and 2.5, area 6.
    expect(service.stats.content.mean).toBeCloseTo(6 / end, 12);
    // The server is busy on [1, 5.5).
    expect(servers.utilization).toBeCloseTo(4.5 / end, 12);
  });

  it('reports statistics read at snapshot times', () => {
    const { sim, service } = oneServer();
    const recorder = sim.recordSnapshots({
      every: 1,
      capture: () => ({ waiting: service.stats.queueLength.current, meanWaiting: service.stats.queueLength.mean }),
    });
    sim.run(4);
    expect(recorder.take()).toEqual([
      { time: 0, data: { waiting: 0, meanWaiting: 0 } },
      { time: 1, data: { waiting: 0, meanWaiting: 0 } },
      { time: 2, data: { waiting: 1, meanWaiting: 0 } },
      { time: 3, data: { waiting: 1, meanWaiting: 0.5 / 3 } },
      { time: 4, data: { waiting: 0, meanWaiting: 1.5 / 4 } },
    ]);
  });

  it('draws the service time from its own stream when service starts', () => {
    const seed = 11;
    const sim = new Simulation({ seed });
    const servers = new ResourcePool(sim, { capacity: 1 });
    const source = new Source(sim, { name: 'arrivals', interval: 0.25, limit: 4 });
    const service = source.connect(
      new Service(sim, { name: 'desk', pool: servers, duration: (random) => random.exponential(2) }),
    );
    const recorder = service.connect(new Recorder(sim));
    sim.run();
    // One server, first come first served: a service starts at the later of the
    // arrival and the previous departure, and takes the next number of the stream.
    const stream = new Random(seed, ['blocks', 'desk']);
    let departure = 0;
    const expected = [0.25, 0.5, 0.75, 1].map(
      (arrival) => (departure = Math.max(arrival, departure) + stream.exponential(2)),
    );
    expect(recorder.visits.map((visit) => visit.time)).toEqual(expected);
  });

  it('serves several blocks that share one pool in the order they asked', () => {
    const sim = new Simulation();
    const clerk = new ResourcePool(sim, { name: 'clerk', capacity: 1 });
    const recorder = new Recorder(sim);
    const morning = new Source(sim, { name: 'morning', interval: 2, limit: 2 }); // 2, 4
    const evening = new Source(sim, { name: 'evening', interval: 3, limit: 2 }); // 3, 6
    morning.connect(new Service(sim, { name: 'desk A', pool: clerk, duration: 2.5 })).connect(recorder);
    evening.connect(new Service(sim, { name: 'desk B', pool: clerk, duration: 2.5 })).connect(recorder);
    sim.run();
    // Ids follow creation: 1 at 2 (morning), 2 at 3 (evening), 3 at 4 (morning), 4 at 6 (evening).
    // One clerk serves them in the order they asked: [2, 4.5), [4.5, 7), [7, 9.5), [9.5, 12).
    expect(recorder.visits).toEqual([
      { id: 1, time: 4.5 },
      { id: 2, time: 7 },
      { id: 3, time: 9.5 },
      { id: 4, time: 12 },
    ]);
  });

  it('holds its capacity of waiting and served entities; a source loses arrivals beyond it', () => {
    const sim = new Simulation();
    const servers = new ResourcePool(sim, { capacity: 1 });
    const source = new Source(sim, { name: 'arrivals', interval: 1, limit: 5 });
    const service = source.connect(new Service(sim, { name: 'desk', pool: servers, duration: 10, capacity: 2 }));
    const recorder = service.connect(new Recorder(sim));
    sim.run(5);
    // Entity 1 in service, entity 2 waiting; 3, 4 and 5 are lost.
    expect(service.stats.content.current).toBe(2);
    expect(service.stats.queueLength.current).toBe(1);
    expect(source.lost).toBe(3);
    sim.run();
    expect(recorder.ids).toEqual([1, 2]);
  });

  it('keeps the unit while the next block has no room', () => {
    const sim = new Simulation();
    const cutters = new ResourcePool(sim, { name: 'cutters', capacity: 1 });
    const painters = new ResourcePool(sim, { name: 'painters', capacity: 1 });
    const source = new Source(sim, { name: 'parts', interval: 1, limit: 3 });
    const cut = source.connect(new Service(sim, { name: 'cut', pool: cutters, duration: 1 }));
    const paint = cut.connect(new Service(sim, { name: 'paint', pool: painters, duration: 5, capacity: 1 }));
    const recorder = paint.connect(new Recorder(sim));
    sim.run();
    // Part 1: cut [1, 2), paint [2, 7). Part 2: cut [2, 3), then holds the cutter
    // until paint is free at 7, paint [7, 12). Part 3 waits for the cutter until 7:
    // cut [7, 8), holds it until 12, paint [12, 17).
    expect(recorder.visits).toEqual([
      { id: 1, time: 7 },
      { id: 2, time: 12 },
      { id: 3, time: 17 },
    ]);
    expect(cut.stats.waitTime.mean).toBeCloseTo((0 + 0 + 4) / 3, 12);
    // The cutter is busy on [1, 12): cutting or holding a part paint cannot take.
    expect(cutters.stats.busy.mean * sim.now).toBeCloseTo(11, 12);
  });

  it('refuses invalid options', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { capacity: 1 });
    const otherPool = new ResourcePool(new Simulation(), { capacity: 1 });
    expect(() => new Service(sim, { name: 'a', pool, duration: -2 })).toThrow(simulationError('NEGATIVE_DELAY'));
    expect(() => new Service(sim, { name: 'b', pool, duration: 1, capacity: 0 })).toThrow(
      simulationError('INVALID_ARGUMENT'),
    );
    expect(() => new Service(sim, { name: 'c', pool: otherPool, duration: 1 })).toThrow(
      simulationError('INVALID_ARGUMENT'),
    );
  });

  it('fails when a served entity has nowhere to go', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { capacity: 1 });
    const source = new Source(sim, { name: 'arrivals', interval: 1, limit: 1 });
    source.connect(new Service(sim, { name: 'desk', pool, duration: 1 }));
    expect(() => sim.run()).toThrow(
      simulationError('PROCESS_FAILED', {
        cause: simulationError('INVALID_STATE', { message: containing('"desk"') }),
      }),
    );
  });

  it('sends entities to a sink, which counts them', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { capacity: 2 });
    const source = new Source(sim, { name: 'arrivals', interval: 1, limit: 4 });
    const sink = source.connect(new Service(sim, { name: 'desk', pool, duration: 3 })).connect(new Sink(sim, { name: 'exit' }));
    sim.run();
    expect(sink.count).toBe(4);
  });
});
