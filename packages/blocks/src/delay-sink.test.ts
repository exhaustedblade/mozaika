import { Random, Simulation } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { Delay, Sink, Source } from './index.js';
import { containing, Recorder, simulationError } from './test-support/helpers.js';

describe('Delay', () => {
  it('delays every entity on its own, however many there are', () => {
    const sim = new Simulation();
    const source = new Source(sim, { name: 'arrivals', interval: 1, limit: 3 });
    const delay = source.connect(new Delay(sim, { name: 'walk', duration: 5 }));
    const recorder = delay.connect(new Recorder(sim));
    sim.run();
    expect(recorder.visits).toEqual([
      { id: 1, time: 6 },
      { id: 2, time: 7 },
      { id: 3, time: 8 },
    ]);
    // Three entities, 5 time units each, over 8 time units.
    expect(delay.stats.content.mean).toBeCloseTo(15 / 8, 12);
  });

  it('draws each delay from its own stream when the entity enters', () => {
    const seed = 5;
    const sim = new Simulation({ seed });
    const source = new Source(sim, { name: 'arrivals', interval: 1, limit: 3 });
    const delay = source.connect(new Delay(sim, { name: 'walk', duration: (random) => random.uniform(0, 0.5) }));
    const recorder = delay.connect(new Recorder(sim));
    sim.run();
    // Delays shorter than the interval keep the entities in order.
    const stream = new Random(seed, ['blocks', 'walk']);
    expect(recorder.visits.map((visit) => visit.time)).toEqual([1, 2, 3].map((arrival) => arrival + stream.uniform(0, 0.5)));
  });

  it('holds at most its capacity', () => {
    const sim = new Simulation();
    const source = new Source(sim, { name: 'arrivals', interval: 1, limit: 4 });
    const delay = source.connect(new Delay(sim, { name: 'walk', duration: 2.5, capacity: 2 }));
    const recorder = delay.connect(new Recorder(sim));
    sim.run();
    // In the delay: 1 on [1, 3.5), 2 on [2, 4.5); entity 3 at 3 finds it full,
    // entity 4 at 4 finds a place left by entity 1.
    expect(recorder.ids).toEqual([1, 2, 4]);
    expect(source.lost).toBe(1);
  });

  it('refuses a drawn delay that is not a finite number', () => {
    const sim = new Simulation();
    const source = new Source(sim, { name: 'arrivals', interval: 1, limit: 1 });
    source.connect(new Delay(sim, { name: 'walk', duration: () => Infinity })).connect(new Recorder(sim));
    expect(() => sim.run()).toThrow(
      simulationError('PROCESS_FAILED', {
        cause: simulationError('NOT_FINITE', { message: containing('"walk"') }),
      }),
    );
  });
});

describe('Sink', () => {
  it('counts the entities that leave and measures their time in the system', () => {
    const sim = new Simulation();
    const source = new Source(sim, { name: 'arrivals', interval: 2, limit: 3 });
    const delay = source.connect(new Delay(sim, { name: 'walk', duration: 1 }));
    const sink = delay.connect(new Sink(sim, { name: 'exit' }));
    sim.run(5);
    expect(sink.count).toBe(2);
    sim.run();
    expect(sink.count).toBe(3);
    expect(sink.stats.timeInSystem.count).toBe(3);
    expect(sink.stats.timeInSystem.mean).toBe(1);
  });

  it('keeps counting after a reset of its statistics', () => {
    const sim = new Simulation();
    const source = new Source(sim, { name: 'arrivals', interval: 1, limit: 4 });
    const sink = source.connect(new Sink(sim, { name: 'exit' }));
    sim.run(2);
    sink.resetStatistics();
    sim.run();
    expect(sink.count).toBe(4);
    expect(sink.stats.timeInSystem.count).toBe(2);
  });
});
