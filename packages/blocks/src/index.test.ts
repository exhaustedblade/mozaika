import { PACKAGE_NAME as KERNEL_PACKAGE_NAME, Simulation } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import * as blocks from './index.js';

describe('@mozaika/blocks', () => {
  it('exposes its package name and builds on the kernel', () => {
    expect(blocks.PACKAGE_NAME).toBe('@mozaika/blocks');
    expect(blocks.DEPENDS_ON).toContain(KERNEL_PACKAGE_NAME);
  });

  it('exports the public API and nothing internal', () => {
    expect(Object.keys(blocks).sort()).toEqual([
      'DEPENDS_ON',
      'Delay',
      'PACKAGE_NAME',
      'Queue',
      'ResourcePool',
      'Service',
      'Sink',
      'Source',
      'Tally',
      'TimeAverage',
    ]);
  });

  it('runs a small model end to end', () => {
    const sim = new Simulation({ seed: 1 });
    const clerks = new blocks.ResourcePool(sim, { name: 'clerks', capacity: 2 });
    const door = new blocks.Source(sim, { name: 'door', interval: (random) => random.exponential(1), limit: 100 });
    const exit = door
      .connect(new blocks.Queue(sim, { name: 'hall', capacity: 10 }))
      .connect(new blocks.Service(sim, { name: 'desk', pool: clerks, duration: 1.5, capacity: 2 }))
      .connect(new blocks.Delay(sim, { name: 'walk out', duration: 0.5 }))
      .connect(new blocks.Sink(sim, { name: 'exit' }));
    sim.run();
    expect(door.arrivals).toBe(100);
    expect(exit.count + door.lost).toBe(100);
    expect(clerks.busy).toBe(0);
  });
});
