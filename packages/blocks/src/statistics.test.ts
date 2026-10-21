import { Simulation } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { Tally, TimeAverage } from './statistics.js';
import { simulationError } from './test-support/helpers.js';

/** Runs `change` at each given time. */
function at(sim: Simulation, changes: readonly (readonly [number, () => void])[]): void {
  for (const [time, change] of changes) sim.scheduleAt(time, change);
}

describe('TimeAverage', () => {
  it('averages a piecewise constant value over time, up to the current moment', () => {
    const sim = new Simulation();
    const length = new TimeAverage(sim);
    // 0 on [0, 1), 2 on [1, 3), 1 from 3 on.
    at(sim, [
      [1, () => { length.set(2); }],
      [3, () => { length.set(1); }],
    ]);
    sim.run(3);
    expect(length.current).toBe(1);
    expect(length.mean).toBeCloseTo((0 * 1 + 2 * 2) / 3, 12);
    // The open interval [3, 4) counts too: the mean is honest at any moment.
    sim.run(4);
    expect(length.mean).toBeCloseTo((0 * 1 + 2 * 2 + 1 * 1) / 4, 12);
  });

  it('is readable inside events, before later events of the same moment', () => {
    const sim = new Simulation();
    const value = new TimeAverage(sim, 4);
    const seen: number[] = [];
    at(sim, [
      [2, () => { seen.push(value.mean); }],
      [2, () => { value.set(0); }],
      [2, () => { seen.push(value.mean); }],
    ]);
    sim.run();
    // Changing the value at t = 2 does not change the area up to t = 2.
    expect(seen).toEqual([4, 4]);
  });

  it('equals the current value over an empty interval', () => {
    const sim = new Simulation({ startTime: 5 });
    expect(new TimeAverage(sim, 3).mean).toBe(3);
  });

  it('adds increments', () => {
    const sim = new Simulation();
    const count = new TimeAverage(sim);
    at(sim, [
      [0, () => { count.add(1); }],
      [1, () => { count.add(1); }],
      [2, () => { count.add(-2); }],
    ]);
    sim.run(4);
    expect(count.current).toBe(0);
    expect(count.mean).toBeCloseTo((1 + 2) / 4, 12);
  });

  it('restarts the average at a reset, keeping the current value', () => {
    const sim = new Simulation();
    const value = new TimeAverage(sim);
    at(sim, [
      [0, () => { value.set(10); }],
      [2, () => { value.set(1); }],
      [5, () => { value.reset(); }],
      [6, () => { value.set(3); }],
    ]);
    sim.run(4);
    expect(value.mean).toBeCloseTo((10 * 2 + 1 * 2) / 4, 12);
    sim.run(8);
    expect(value.current).toBe(3);
    expect(value.mean).toBeCloseTo((1 * 1 + 3 * 2) / 3, 12);
  });

  it('can be read at snapshot times', () => {
    const sim = new Simulation();
    const value = new TimeAverage(sim);
    at(sim, [
      [0.5, () => { value.set(2); }],
      [1.5, () => { value.set(0); }],
    ]);
    const recorder = sim.recordSnapshots({ every: 1, capture: () => value.mean });
    sim.run(3);
    // Area: 0 on [0, 0.5), 2 on [0.5, 1.5), 0 after.
    expect(recorder.take()).toEqual([
      { time: 0, data: 0 },
      { time: 1, data: (2 * 0.5) / 1 },
      { time: 2, data: (2 * 1) / 2 },
      { time: 3, data: (2 * 1) / 3 },
    ]);
  });

  it('refuses values that are not finite numbers', () => {
    const sim = new Simulation();
    const value = new TimeAverage(sim);
    expect(() => {
      value.set(Number.NaN);
    }).toThrow(simulationError('NOT_A_NUMBER'));
    expect(() => {
      value.add(Infinity);
    }).toThrow(simulationError('NOT_FINITE'));
    expect(() => new TimeAverage(sim, Number.NaN)).toThrow(simulationError('NOT_A_NUMBER'));
  });
});

describe('Tally', () => {
  it('counts observations and averages them', () => {
    const tally = new Tally();
    expect(tally.count).toBe(0);
    expect(tally.mean).toBeNaN();
    tally.add(2);
    tally.add(0);
    tally.add(7);
    expect(tally.count).toBe(3);
    expect(tally.mean).toBe(3);
  });

  it('forgets everything at a reset', () => {
    const tally = new Tally();
    tally.add(5);
    tally.reset();
    expect(tally.count).toBe(0);
    expect(tally.mean).toBeNaN();
    tally.add(1);
    expect(tally.mean).toBe(1);
  });

  it('refuses observations that are not finite numbers', () => {
    const tally = new Tally();
    expect(() => {
      tally.add(Number.NaN);
    }).toThrow(simulationError('NOT_A_NUMBER'));
    expect(() => {
      tally.add(-Infinity);
    }).toThrow(simulationError('NOT_FINITE'));
  });
});
