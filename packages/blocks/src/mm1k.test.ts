import { expectFormulaInInterval } from '@mozaika/kernel/test-support';
import { beforeAll, describe, it } from 'vitest';

import { mm1k } from './test-support/queueing-formulas.js';
import { type ReplicationEstimates, runReplications, type RunLength } from './test-support/queueing-model.js';

/**
 * M/M/1/K on blocks: a Service with one server and capacity K right after the
 * Source. An arrival that finds K entities in the Service is lost, so the
 * share of lost arrivals estimates the blocking probability P_K (Poisson
 * arrivals see time averages). Same replication/deletion method as M/M/1
 * (see mm1.test.ts); with a small K the queue forgets its start within a few
 * dozen service times, so a short warm-up is enough.
 */
const SEED = 20_261_021;
const SERVICE_RATE = 1;

interface Scenario {
  readonly utilization: number;
  readonly capacity: number;
  readonly runLength: RunLength;
}

const SCENARIOS: readonly Scenario[] = [
  { utilization: 0.9, capacity: 5, runLength: { warmUp: 200, window: 20_000 } },
  // Overloaded (λ > μ): stable only because of the capacity limit.
  { utilization: 1.5, capacity: 3, runLength: { warmUp: 200, window: 20_000 } },
];

describe.each(SCENARIOS)('M/M/1/$capacity at λ/μ = $utilization', ({ utilization, capacity, runLength }) => {
  const parameters = { arrivalRate: utilization * SERVICE_RATE, serviceRate: SERVICE_RATE, servers: 1, capacity };
  let replications: ReplicationEstimates[] = [];

  beforeAll(() => {
    replications = runReplications(parameters, runLength, SEED);
  }, 60_000);

  it('loses the share of arrivals the formula predicts, with matching L and utilization', () => {
    const formulas = mm1k(parameters.arrivalRate, parameters.serviceRate, capacity);
    const estimates = (pick: (replication: ReplicationEstimates) => number): number[] => replications.map(pick);
    expectFormulaInInterval('P_K (loss probability)', formulas.lossProbability, estimates((r) => r.lossFraction));
    expectFormulaInInterval('L (mean number in system)', formulas.inSystem, estimates((r) => r.inSystem));
    expectFormulaInInterval('utilization', formulas.utilization, estimates((r) => r.utilization));
  });
});
