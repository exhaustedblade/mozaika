import { Simulation } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { crowd, CROWD_DEFAULTS, crowdSide } from './crowd.js';

/** The model of the scene benchmark (Ф0-6б): a crowd that never stops walking. */
describe('crowd', () => {
  it('keeps every agent walking between random points of its square, in two alternating states', () => {
    const simulation = new Simulation({ seed: 3 });
    const parameters = { ...CROWD_DEFAULTS, agents: 2_000 };
    const [walkers] = crowd.build({ simulation, parameters }).populations;
    if (walkers === undefined) throw new Error('the crowd has no population');
    const side = crowdSide(parameters.agents);
    for (const until of [0, 60, 600.5]) {
      simulation.run(until);
      expect(walkers.size).toBe(2_000);
      expect(walkers.agents.every((agent) => agent.moving)).toBe(true);
      const positions = walkers.positions();
      expect(positions.every((value) => value >= 0 && value <= side)).toBe(true);
    }
    // After many walks, about as many agents are on their way out as on their way back.
    expect(walkers.count('outbound')).toBeGreaterThan(800);
    expect(walkers.count('inbound')).toBeGreaterThan(800);
  });

  it('gives a crowd the same density whatever its size', () => {
    expect(crowdSide(100_000) ** 2 / 100_000).toBeCloseTo(crowdSide(1_000_000) ** 2 / 1_000_000);
    expect(crowdSide(100_000)).toBeGreaterThan(100);
  });
});
