/**
 * The check shared by the statistical tests: a formula value must lie in the
 * confidence interval of the replication estimates, and the interval must be narrow.
 */
import { expect } from 'vitest';

import { confidenceInterval } from './confidence-interval.js';

/**
 * Largest half-width of an interval, relative to the formula value. Without
 * this check a run too short, and so too noisy, would pass whatever it
 * computed; with it, an error of 10 % or more cannot hide in a wide interval.
 */
export const MAX_RELATIVE_HALF_WIDTH = 0.1;

/**
 * Checks that the formula value lies in the 99.9 % confidence interval of the
 * replication estimates, and that the interval is narrow (MAX_RELATIVE_HALF_WIDTH).
 */
export function expectFormulaInInterval(metric: string, formula: number, estimates: readonly number[]): void {
  const { mean, halfWidth } = confidenceInterval(estimates);
  const summary = `${metric}: formula ${formula.toFixed(4)}, simulation ${mean.toFixed(4)} ± ${halfWidth.toFixed(4)}`;
  expect(Math.abs(mean - formula), summary).toBeLessThanOrEqual(halfWidth);
  expect(halfWidth / formula, `${summary}: the interval is too wide`).toBeLessThanOrEqual(MAX_RELATIVE_HALF_WIDTH);
}
