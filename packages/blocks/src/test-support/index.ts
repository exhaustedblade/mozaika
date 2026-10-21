/**
 * Helpers for the tests of the workspace packages that build models on the
 * blocks: the formulas of queueing theory, the replications of a queueing
 * model and the checks of their results.
 *
 * Tests of other packages import them as `@mozaika/blocks/test-support`. That
 * export exists only under the workspace source condition, and the package
 * build leaves this folder out, so nothing here ships with the blocks.
 */
export { erlangC, type LossSystemMeasures, mm1, mm1k, mmc, type QueueMeasures } from './queueing-formulas.js';
export type { ReplicationEstimates, RunLength } from './queueing-model.js';
export { expectLittlesLaw, expectMeasuresInIntervals, LITTLE_TOLERANCE } from './theory-checks.js';
