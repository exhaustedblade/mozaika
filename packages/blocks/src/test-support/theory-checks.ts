/**
 * Checks of replication results against queueing formulas and Little's law.
 * Not part of the package build.
 */
import { expectFormulaInInterval } from '@mozaika/kernel/test-support';
import { expect } from 'vitest';

import type { QueueMeasures } from './queueing-formulas.js';
import type { ReplicationEstimates } from './queueing-model.js';

/**
 * Checks L, Lq, W, Wq and utilization against the formulas, each by its
 * 99.9 % interval. Run lengths keep the typical half-width at about half of
 * the bound MAX_RELATIVE_HALF_WIDTH.
 */
export function expectMeasuresInIntervals(formulas: QueueMeasures, replications: readonly ReplicationEstimates[]): void {
  const metrics = [
    ['L (mean number in system)', formulas.inSystem, (r: ReplicationEstimates) => r.inSystem],
    ['Lq (mean number waiting)', formulas.waiting, (r: ReplicationEstimates) => r.waiting],
    ['W (mean time in system)', formulas.timeInSystem, (r: ReplicationEstimates) => r.timeInSystem],
    ['Wq (mean wait)', formulas.waitTime, (r: ReplicationEstimates) => r.waitTime],
    ['utilization', formulas.utilization, (r: ReplicationEstimates) => r.utilization],
  ] as const;
  for (const [metric, formula, estimate] of metrics) {
    expectFormulaInInterval(metric, formula, replications.map(estimate));
  }
}

/**
 * Little's law L = λW on the same runs: the mean of L̂ over the replications
 * and the mean of λ̂Ŵ (λ̂: departures per unit of time in the window) agree
 * within LITTLE_TOLERANCE.
 *
 * Why not exactly: over a window [t₀, T], L̂ − λ̂Ŵ = (E(T) − E(t₀)) / (T − t₀),
 * where E(t) is the total time that the entities present at t have already
 * spent in the system (Little's sample-path argument; little.test.ts checks
 * the identity itself). E has a long tail. Sampled once per time unit in long
 * runs (2–4 million samples each), its 99.9 % quantile and maximum were:
 * M/M/1 at ρ = 0.5 — 56 and 199; at ρ = 0.9 — 2 060 and 5 770; M/M/3 at
 * ρ = 0.5 — 24 and 89; at ρ = 0.9 — 750 and 1 990. To shift the mean gap by
 * 0.5 % of L, E at the window edges would have to average 0.005 · L · (T − t₀)
 * over all 20 replications: 100, 6 300, 174 and 2 510 for these runs — above
 * the 99.99 % quantile in every replication at once, and in three cases above
 * the largest value ever seen. So the check cannot fail by chance, yet it
 * catches statistics that are kept or reset wrongly: for example, a Tally not
 * reset after the warm-up would add the warm-up's departures and shift λ̂Ŵ by
 * about warm-up / window, 0.75–10 % in these runs.
 */
export const LITTLE_TOLERANCE = 0.005;

export function expectLittlesLaw(replications: readonly ReplicationEstimates[]): void {
  const mean = (pick: (replication: ReplicationEstimates) => number): number =>
    replications.reduce((sum, replication) => sum + pick(replication), 0) / replications.length;
  const inSystem = mean((r) => r.inSystem);
  const flowTimesTime = mean((r) => r.throughput * r.timeInSystem);
  const gap = Math.abs(inSystem - flowTimesTime) / inSystem;
  expect(gap, `mean L̂ = ${String(inSystem)}, mean λ̂Ŵ = ${String(flowTimesTime)}`).toBeLessThanOrEqual(
    LITTLE_TOLERANCE,
  );
}
