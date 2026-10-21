/**
 * Helpers for the tests of the workspace packages: confidence intervals over
 * independent replications (A. M. Law, ch. 9) and fingerprints of traces.
 *
 * Tests of other packages import them as `@mozaika/kernel/test-support`. That
 * export exists only under the workspace source condition, and the package
 * build leaves this folder out, so nothing here ships with the kernel.
 */
export { type ConfidenceInterval, confidenceInterval, REPLICATIONS, T_QUANTILE_99_9 } from './confidence-interval.js';
export { expectFormulaInInterval, MAX_RELATIVE_HALF_WIDTH } from './interval-checks.js';
export { fingerprint } from './trace-fingerprint.js';
