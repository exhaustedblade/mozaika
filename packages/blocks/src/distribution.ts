/** Times that blocks draw: intervals between arrivals, service and delay times. */
import { type Random, SimulationError } from '@mozaika/kernel';

import { requireDuration } from './validation.js';

/**
 * A time given as a fixed number, or as a function that draws it from the
 * block's own random stream, e.g. `(random) => random.exponential(2)`.
 * Values must be finite and not negative.
 */
export type Distribution = number | ((random: Random) => number);

/** Draws the times of one block from its distribution and checks every value. */
export class TimeSampler {
  readonly #distribution: Distribution;
  readonly #random: Random;
  /** Names the time in error messages, e.g. 'Service "desk" duration'. */
  readonly #what: string;

  constructor(distribution: Distribution, random: Random, what: string) {
    this.#distribution = requireDistribution(distribution, what);
    this.#random = random;
    this.#what = what;
  }

  /** The next time. */
  next(): number {
    const distribution = this.#distribution;
    if (typeof distribution === 'number') return distribution;
    return requireDuration(distribution(this.#random), `${this.#what} drawn from its distribution`);
  }
}

/** A fixed time that is finite and not negative, or a function. */
function requireDistribution(value: unknown, what: string): Distribution {
  if (typeof value === 'number') return requireDuration(value, what);
  if (typeof value === 'function') return value as (random: Random) => number;
  throw new SimulationError('INVALID_ARGUMENT', `${what} must be a number or a function of the random stream`);
}
