import { describe, expect, it } from 'vitest';

import { ViewClock } from './view-clock.js';

/**
 * The clock of the frames (docs/ARCHITECTURE.md, "Показ"): model time runs at
 * the chosen scale, but never further ahead of the latest snapshot than the
 * lead allows, and a long pause between frames does not make it jump.
 */
describe('view clock', () => {
  const options = { timeScale: 4, maxLead: 0.25, maxStep: 0.1 };

  it('runs model time at the chosen units per second of real time', () => {
    const clock = new ViewClock(options);
    expect(clock.tick(0.05, 0)).toBeCloseTo(0.2);
    expect(clock.tick(0.05, 0.2)).toBeCloseTo(0.4);
    clock.timeScale = 10;
    expect(clock.tick(0.02, 0.4)).toBeCloseTo(0.6);
  });

  it('waits for the kernel: frames run at most the lead ahead of the latest snapshot', () => {
    const clock = new ViewClock(options);
    // No snapshot yet: the clock stays at the start until the first one comes.
    expect(clock.tick(0.05, undefined)).toBe(0);
    for (let frame = 0; frame < 10; frame++) clock.tick(0.05, 0);
    // A lead of 0.25 s at 4 units per second: one unit ahead of the snapshot at 0.
    expect(clock.time).toBeCloseTo(1);
    expect(clock.tick(0.05, 3)).toBeCloseTo(1.2);
  });

  it('moves at most maxStep of real time in one frame, so a tab hidden for a while does not jump', () => {
    const clock = new ViewClock(options);
    expect(clock.tick(30, 100)).toBeCloseTo(0.4);
  });

  it('stands still while paused, and starts again from a given moment', () => {
    const clock = new ViewClock(options);
    clock.tick(0.05, 10);
    clock.paused = true;
    expect(clock.tick(0.05, 10)).toBeCloseTo(0.2);
    clock.paused = false;
    clock.reset(0);
    expect(clock.time).toBe(0);
    expect(clock.tick(0.05, undefined)).toBe(0);
  });
});
