import { beforeAll, describe, it } from 'vitest';

import { mmc } from './test-support/queueing-formulas.js';
import { type ReplicationEstimates, runReplications, type RunLength } from './test-support/queueing-model.js';
import { expectLittlesLaw, expectMeasuresInIntervals } from './test-support/theory-checks.js';

/**
 * M/M/c on blocks (Source → Service with a pool of c servers → Sink) against
 * the Erlang C formulas, by the same replication/deletion method as M/M/1
 * (see mm1.test.ts).
 *
 * Time unit: the mean service time (μ = 1). With c servers the queue relaxes
 * faster than M/M/1 at the same ρ: its relaxation time is about
 * 1 / (cμ (1 − √ρ)²), so the warm-up here (the M/M/1 value) is c times longer
 * than needed.
 */
const SEED = 20_261_021;
const SERVICE_RATE = 1;
const SERVERS = 3;

interface Scenario {
  readonly utilization: number;
  readonly runLength: RunLength;
}

const SCENARIOS: readonly Scenario[] = [
  { utilization: 0.5, runLength: { warmUp: 150, window: 20_000 } },
  { utilization: 0.9, runLength: { warmUp: 5_000, window: 50_000 } },
];

describe.each(SCENARIOS)(`M/M/${String(SERVERS)} at ρ = $utilization`, ({ utilization, runLength }) => {
  const parameters = {
    arrivalRate: utilization * SERVERS * SERVICE_RATE,
    serviceRate: SERVICE_RATE,
    servers: SERVERS,
  };
  let replications: ReplicationEstimates[] = [];

  beforeAll(() => {
    replications = runReplications(parameters, runLength, SEED);
  }, 60_000);

  it('matches L, Lq, W, Wq (Erlang C) and utilization within the 99.9 % confidence interval', () => {
    expectMeasuresInIntervals(mmc(parameters.arrivalRate, parameters.serviceRate, SERVERS), replications);
  });

  it("obeys Little's law L = λW, on average over the replications", () => {
    expectLittlesLaw(replications);
  });
});
