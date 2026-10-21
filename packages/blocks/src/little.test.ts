import { type Random, Simulation } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { Delay, Queue, ResourcePool, Service, Sink, Source } from './index.js';

/**
 * Little's law on a single sample path (J. D. C. Little, 1961): if the system
 * is empty at the start and at the end of an interval of length T, the area
 * under the number of entities equals the sum of their times in the system.
 * So L̂ = λ̂ Ŵ holds exactly, up to rounding, for the whole system and for
 * every block. This checks the bookkeeping of all statistics at once.
 */

/** Rounding over ~10⁴ additions of doubles stays far below this relative error. */
const ROUNDING = 1e-9;

function expectSame(actual: number, expected: number): void {
  expect(Math.abs(actual - expected) / expected).toBeLessThan(ROUNDING);
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/** Wraps an exponential distribution so that the test sees every value drawn. */
function recorded(mean: number, drawn: number[]): (random: Random) => number {
  return (random) => {
    const value = random.exponential(mean);
    drawn.push(value);
    return value;
  };
}

describe("Little's law on one sample path", () => {
  it('holds exactly for the whole system and for each block', () => {
    const sim = new Simulation({ seed: 42 });
    const serviceTimes: number[] = [];
    const walkTimes: number[] = [];
    const servers = new ResourcePool(sim, { name: 'servers', capacity: 2 });
    // λ = 1, two servers with mean service time 1.8 (ρ = 0.9), room for 4 in
    // the service and 3 in the queue before it: entities wait in both places
    // and some arrivals are lost.
    const source = new Source(sim, { name: 'arrivals', interval: (random) => random.exponential(1), limit: 20_000 });
    const queue = source.connect(new Queue(sim, { name: 'line', capacity: 3 }));
    const service = queue.connect(
      new Service(sim, { name: 'desk', pool: servers, duration: recorded(1.8, serviceTimes), capacity: 4 }),
    );
    const walk = service.connect(new Delay(sim, { name: 'walk', duration: recorded(0.7, walkTimes) }));
    const sink = walk.connect(new Sink(sim, { name: 'exit' }));

    sim.run(); // all arrivals done and the system empty again
    const elapsed = sim.now;
    const departures = sink.stats.timeInSystem.count;

    // Every entity either left through the sink or was lost on arrival, and the
    // test really exercises waiting and losses.
    expect(source.arrivals).toBe(20_000);
    expect(departures + source.lost).toBe(source.arrivals);
    expect(source.lost).toBeGreaterThan(100);
    expect(queue.stats.waitTime.mean).toBeGreaterThan(0.1);
    expect(service.stats.waitTime.mean).toBeGreaterThan(0.1);

    // Whole system: L̂ = λ̂ Ŵ.
    const inSystem = queue.stats.length.mean + service.stats.content.mean + walk.stats.content.mean;
    expectSame(inSystem, (departures / elapsed) * sink.stats.timeInSystem.mean);

    // Each place: time-average number = (sum of the times spent there) / T.
    const { waitTime: queueWait } = queue.stats;
    const { waitTime: serviceWait } = service.stats;
    expectSame(queue.stats.length.mean * elapsed, queueWait.mean * queueWait.count);
    expectSame(service.stats.queueLength.mean * elapsed, serviceWait.mean * serviceWait.count);
    expectSame(servers.stats.busy.mean * elapsed, sum(serviceTimes));
    expectSame(service.stats.content.mean * elapsed, serviceWait.mean * serviceWait.count + sum(serviceTimes));
    expectSame(walk.stats.content.mean * elapsed, sum(walkTimes));
  });
});
