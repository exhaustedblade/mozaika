import { describe, expect, it } from 'vitest';

import { type ProcessBody, timeout } from './process.js';
import { Random } from './random.js';
import { Simulation, type SimulationOptions } from './simulation.js';
import { describeEvent } from './test-helpers.js';
import { fingerprint } from './test-support/index.js';

interface ShopRun {
  /** Every fired event: time, priority, seq and label. */
  readonly trace: readonly string[];
  readonly arrivalTimes: readonly number[];
  readonly snapshots: readonly unknown[];
}

/**
 * A shop with two clerks: customers arrive at random, wait in a queue and are
 * served for a random time. Uses every kernel feature that affects the order of
 * events: processes, timeouts, a signal waking several processes, random streams.
 */
function runShop(options: SimulationOptions, { withNoise = false } = {}): ShopRun {
  const trace: string[] = [];
  const sim = new Simulation({ ...options, trace: (event) => trace.push(describeEvent(event)) });
  const arrivals = sim.random.stream('arrivals');
  const service = sim.random.stream('service');
  const queue: number[] = [];
  const arrivalTimes: number[] = [];
  const customerArrived = sim.signal('customer arrived');

  function* source(): ProcessBody {
    for (let customer = 1; customer <= 500; customer++) {
      yield timeout(arrivals.exponential(1));
      queue.push(customer);
      arrivalTimes.push(sim.now);
      customerArrived.notify();
    }
  }

  function* clerk(): ProcessBody {
    for (;;) {
      if (queue.shift() === undefined) {
        yield customerArrived.wait();
      } else {
        yield timeout(service.exponential(1.8));
      }
    }
  }

  // Another source of randomness with its own stream: it must not disturb the arrivals.
  function* noise(): ProcessBody {
    const random = sim.random.stream('noise');
    for (let i = 0; i < 100; i++) yield timeout(random.exponential(3));
  }

  sim.process(source(), { name: 'source' });
  sim.process(clerk(), { name: 'clerk-1' });
  sim.process(clerk(), { name: 'clerk-2' });
  if (withNoise) sim.process(noise(), { name: 'noise' });
  const recorder = sim.recordSnapshots({ every: 10, capture: () => ({ queue: queue.length }) });
  sim.run();

  return { trace, arrivalTimes, snapshots: recorder.take() };
}

describe('repeatability by seed', () => {
  it('gives an identical event trace for the same seed', () => {
    const first = runShop({ seed: 2026 });
    const second = runShop({ seed: 2026 });
    expect(first.trace.length).toBeGreaterThan(1_000);
    expect(second.trace).toEqual(first.trace);
    expect(second.snapshots).toEqual(first.snapshots);
  });

  it('gives a different trace for a different seed', () => {
    expect(runShop({ seed: 2027 }).trace).not.toEqual(runShop({ seed: 2026 }).trace);
  });

  it('fires the same events with the same numbers as the kernel of Ф0-4', () => {
    // Recorded with the kernel of commit 47903fe, before the event queue moved
    // to typed arrays (Ф0-4б): times, priorities, numbers and labels all match.
    const { trace } = runShop({ seed: 2026 });
    expect({ events: trace.length, fingerprint: fingerprint(trace) }).toEqual({
      events: 1097,
      fingerprint: '18f304dd',
    });
  });

  it('keeps arrivals unchanged when another part of the model draws random numbers', () => {
    const plain = runShop({ seed: 7 });
    const noisy = runShop({ seed: 7 }, { withNoise: true });
    expect(noisy.trace).not.toEqual(plain.trace);
    expect(noisy.arrivalTimes).toEqual(plain.arrivalTimes);
  });

  it('gives each replication of an experiment its own repeatable stream', () => {
    const replication = (k: number): ShopRun => runShop({ random: new Random(7, ['replication', String(k)]) });
    expect(replication(1).trace).toEqual(replication(1).trace);
    expect(replication(1).trace).not.toEqual(replication(2).trace);
  });
});
