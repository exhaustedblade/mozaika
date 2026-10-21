import { Simulation } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { Delay, Queue, ResourcePool, Service, Sink, Source } from './index.js';
import { Recorder, simulationError } from './test-support/helpers.js';

/**
 * Source → Queue → Service with room for one entity → Recorder: the Service
 * takes an entity only when it is empty, so the others wait in the Queue.
 * Arrivals at 1, 2, 3…; each service takes `serviceTime`.
 */
function queueBeforeOneServer(arrivals: number, serviceTime: number, queueCapacity = Infinity) {
  const sim = new Simulation();
  const servers = new ResourcePool(sim, { capacity: 1 });
  const source = new Source(sim, { name: 'arrivals', interval: 1, limit: arrivals });
  const queue = source.connect(new Queue(sim, { name: 'line', capacity: queueCapacity }));
  const service = queue.connect(
    new Service(sim, { name: 'desk', pool: servers, duration: serviceTime, capacity: 1 }),
  );
  const recorder = service.connect(new Recorder(sim));
  return { sim, source, queue, service, recorder };
}

describe('Queue', () => {
  it('lets entities out strictly in the order they came in', () => {
    const { sim, queue, recorder } = queueBeforeOneServer(5, 3);
    sim.run();
    // Service starts at 1, 4, 7, 10, 13 and ends 3 later.
    expect(recorder.visits).toEqual([
      { id: 1, time: 4 },
      { id: 2, time: 7 },
      { id: 3, time: 10 },
      { id: 4, time: 13 },
      { id: 5, time: 16 },
    ]);
    // Waits: 0 (the desk is free at 1), then 4 − 2, 7 − 3, 10 − 4, 13 − 5.
    expect(queue.stats.waitTime.count).toBe(5);
    expect(queue.stats.waitTime.mean).toBe((0 + 2 + 4 + 6 + 8) / 5);
  });

  it('measures the time-average length up to the current moment', () => {
    const { sim, queue } = queueBeforeOneServer(5, 3);
    sim.run(8);
    // Lengths: 1 on [2, 3), 2 on [3, 4), 2 on [4, 5) (one left, one came),
    // 3 on [5, 7), 2 on [7, 8): area 1 + 2 + 2 + 6 + 2 = 13 over 8 time units.
    expect(queue.stats.length.current).toBe(2);
    expect(queue.stats.length.mean).toBeCloseTo(13 / 8, 12);
    sim.run();
    // Over the whole run the area is the sum of the waits (Little's law on one path).
    expect(queue.stats.length.mean).toBeCloseTo(20 / 16, 12);
  });

  it('lets entities through at once when the next block always has room', () => {
    const sim = new Simulation();
    const source = new Source(sim, { name: 'arrivals', interval: 1, limit: 3 });
    const queue = source.connect(new Queue(sim, { name: 'line' }));
    const recorder = queue.connect(new Delay(sim, { name: 'walk', duration: 10 })).connect(new Recorder(sim));
    sim.run();
    expect(recorder.ids).toEqual([1, 2, 3]);
    expect(queue.stats.waitTime.mean).toBe(0);
    expect(queue.stats.length.mean).toBe(0);
  });

  it('holds at most its capacity; arrivals from a source that find it full are lost', () => {
    const { sim, source, queue, recorder } = queueBeforeOneServer(6, 10, 2);
    sim.run(6);
    // Entity 1 is at the desk, 2 and 3 fill the queue, 4, 5 and 6 are lost.
    expect(queue.stats.length.current).toBe(2);
    expect(source.lost).toBe(3);
    sim.run();
    expect(recorder.ids).toEqual([1, 2, 3]);
    expect(source.arrivals).toBe(6);
  });

  it('keeps an entity in the previous block while it is full', () => {
    const sim = new Simulation();
    const servers = new ResourcePool(sim, { capacity: 1 });
    const source = new Source(sim, { name: 'arrivals', interval: 1, limit: 3 });
    const walk = source.connect(new Delay(sim, { name: 'walk', duration: 0.5 }));
    const queue = walk.connect(new Queue(sim, { name: 'line', capacity: 1 }));
    const desk = queue.connect(new Service(sim, { name: 'desk', pool: servers, duration: 4, capacity: 1 }));
    const sink = desk.connect(new Sink(sim, { name: 'exit' }));
    sim.run(5);
    // Entity 1 is at the desk until 5.5, entity 2 fills the queue, so entity 3
    // finished walking at 3.5 but still waits in the delay.
    expect(walk.stats.content.current).toBe(1);
    expect(queue.stats.length.current).toBe(1);
    sim.run();
    // Desk: entity 1 on [1.5, 5.5), entity 2 on [5.5, 9.5), entity 3 on [9.5, 13.5).
    expect(sink.count).toBe(3);
    expect(sink.stats.timeInSystem.mean).toBeCloseTo((4.5 + 7.5 + 10.5) / 3, 12);
    // Time in the delay: 0.5, 0.5 and 2.5 (blocked from 3.5 until 5.5).
    expect(walk.stats.content.mean * sim.now).toBeCloseTo(3.5, 12);
    // Time in the queue: 0, 3 (2.5 → 5.5) and 4 (5.5 → 9.5).
    expect(queue.stats.waitTime.mean).toBeCloseTo(7 / 3, 12);
  });

  it('starts its statistics again at a reset, keeping the entities it holds', () => {
    const { sim, queue } = queueBeforeOneServer(5, 3);
    sim.run(8);
    queue.resetStatistics();
    expect(queue.stats.waitTime.count).toBe(0);
    sim.run(9);
    // Length 2 on [8, 9).
    expect(queue.stats.length.mean).toBe(2);
  });

  it('refuses invalid options', () => {
    const sim = new Simulation();
    expect(() => new Queue(sim, { name: 'a', capacity: 0 })).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => new Queue(sim, { name: 'b', capacity: 2.5 })).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => new Queue(sim, { name: 'c', capacity: Number.NaN })).toThrow(simulationError('NOT_A_NUMBER'));
  });

  it('can be connected only once, to a block of the same simulation', () => {
    const sim = new Simulation();
    const queue = new Queue(sim, { name: 'line' });
    expect(() => queue.connect(new Sink(new Simulation(), { name: 'exit' }))).toThrow(
      simulationError('INVALID_ARGUMENT'),
    );
    queue.connect(new Sink(sim, { name: 'exit' }));
    expect(() => queue.connect(new Sink(sim, { name: 'other exit' }))).toThrow(simulationError('INVALID_STATE'));
  });
});
