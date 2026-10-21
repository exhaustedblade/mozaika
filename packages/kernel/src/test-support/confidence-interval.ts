/**
 * Confidence intervals for the mean of independent replications
 * (A. M. Law, "Simulation Modeling and Analysis", 5th ed., ch. 9).
 * Shared by the statistical tests of the kernel (agents) and the blocks.
 */

/**
 * Number of independent replications in the statistical tests.
 * Twenty keeps the Student t quantile moderate (3.88, versus 4.78 for ten)
 * and gives each test a few seconds of run time.
 */
export const REPLICATIONS = 20;

/**
 * Two-sided 99.9 % quantile of Student's t distribution with
 * REPLICATIONS − 1 = 19 degrees of freedom, t(19; 0.9995), as in standard
 * tables; checked by numerical integration of the t density.
 *
 * Why 99.9 % and not the usual 95 %: the statistical tests of the blocks
 * check 26 intervals (mm1, mmc and mm1k tests). At 95 % one of them would miss
 * almost always (1 − 0.95²⁶ ≈ 74 %), so the tests would pass only for a lucky
 * seed. At 99.9 % the Bonferroni bound on a false failure of any of them is
 * 26 × 0.1 % = 2.6 %. Checked on 40 seeds: none of the 1 040 intervals missed.
 * The agents' test (kernel, agents/two-state.test.ts) checks 3 intervals:
 * a bound of 0.3 %.
 */
export const T_QUANTILE_99_9 = 3.8834;

export interface ConfidenceInterval {
  /** Mean of the replication estimates. */
  readonly mean: number;
  /** Half the interval width: t · s / √n. */
  readonly halfWidth: number;
}

/** t-interval for the mean of REPLICATIONS independent, roughly normal estimates. */
export function confidenceInterval(estimates: readonly number[]): ConfidenceInterval {
  if (estimates.length !== REPLICATIONS) {
    throw new RangeError(`Expected ${String(REPLICATIONS)} estimates, got ${String(estimates.length)}`);
  }
  const count = estimates.length;
  const mean = estimates.reduce((sum, value) => sum + value, 0) / count;
  const squaredDeviations = estimates.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const standardDeviation = Math.sqrt(squaredDeviations / (count - 1));
  return { mean, halfWidth: (T_QUANTILE_99_9 * standardDeviation) / Math.sqrt(count) };
}
