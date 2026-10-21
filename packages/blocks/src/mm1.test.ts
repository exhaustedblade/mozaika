import { beforeAll, describe, it } from 'vitest';

import { mm1 } from './test-support/queueing-formulas.js';
import { type ReplicationEstimates, runReplications, type RunLength } from './test-support/queueing-model.js';
import { expectLittlesLaw, expectMeasuresInIntervals } from './test-support/theory-checks.js';

/**
 * M/M/1 on blocks (Source → Service with one server → Sink) against the
 * formulas of queueing theory, by replication/deletion (Law, ch. 9):
 * 20 independent replications, each with its own random stream
 * new Random(SEED, ['replication', k]); each starts empty, discards a warm-up
 * and measures over a window; the formula must lie in the 99.9 % t-interval of
 * the 20 window averages (see test-support/confidence-interval.ts).
 *
 * Time unit: the mean service time (μ = 1).
 *
 * Warm-up: an M/M/1 queue started empty approaches the steady state roughly
 * like exp(−t/τ), with relaxation time τ = 1 / (μ (1 − √ρ)²) (P. M. Morse, 1955):
 * τ ≈ 12 at ρ = 0.5 and τ ≈ 380 at ρ = 0.9. The warm-up is about 13τ, so the
 * initial bias is below e⁻¹³ ≈ 2 · 10⁻⁶ of the transient: negligible.
 *
 * Window: long enough that the typical half-width is about 5 % of the value,
 * half the bound MAX_RELATIVE_HALF_WIDTH that the checks enforce (theory-checks.ts).
 */
const SEED = 20_261_021;
const SERVICE_RATE = 1;

interface Scenario {
  readonly utilization: number;
  readonly runLength: RunLength;
}

const SCENARIOS: readonly Scenario[] = [
  { utilization: 0.5, runLength: { warmUp: 150, window: 20_000 } },
  // Heavy traffic is noisy: the window is 7 times longer for the same precision.
  { utilization: 0.9, runLength: { warmUp: 5_000, window: 140_000 } },
];

describe.each(SCENARIOS)('M/M/1 at ρ = $utilization', ({ utilization, runLength }) => {
  const parameters = { arrivalRate: utilization * SERVICE_RATE, serviceRate: SERVICE_RATE, servers: 1 };
  let replications: ReplicationEstimates[] = [];

  beforeAll(() => {
    replications = runReplications(parameters, runLength, SEED);
  }, 60_000);

  it('matches L, Lq, W, Wq and utilization within the 99.9 % confidence interval', () => {
    expectMeasuresInIntervals(mm1(parameters.arrivalRate, parameters.serviceRate), replications);
  });

  it("obeys Little's law L = λW, on average over the replications", () => {
    expectLittlesLaw(replications);
  });
});
