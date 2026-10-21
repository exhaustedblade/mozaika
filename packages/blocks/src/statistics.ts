/**
 * Statistics of the blocks, of the two kinds in A. M. Law, "Simulation
 * Modeling and Analysis" (ch. 1): averages over time and averages over observations.
 */
import type { Simulation } from '@mozaika/kernel';

import { requireFinite } from './validation.js';

/**
 * Time average of a value that changes in steps and holds between events, such
 * as the length of a queue or the number of busy units:
 *
 *     mean = (1 / (t − t₀)) · ∫ from t₀ to t of value(s) ds,
 *
 * where t is the current model time and t₀ the creation or the last reset.
 * The integral includes the interval since the last change, so the mean is
 * exact at any moment, including inside a snapshot (which is taken with the
 * clock at the snapshot time).
 */
export class TimeAverage {
  readonly #simulation: Simulation;
  #value: number;
  /** t₀: the start of the averaging period. */
  #since: number;
  #lastChange: number;
  /** ∫ value dt from #since to #lastChange. */
  #area = 0;

  constructor(simulation: Simulation, initial = 0) {
    this.#simulation = simulation;
    this.#value = requireFinite(initial, 'TimeAverage initial value');
    this.#since = simulation.now;
    this.#lastChange = simulation.now;
  }

  /** The value now. */
  get current(): number {
    return this.#value;
  }

  /** Time average from t₀ up to now; over an empty interval (now = t₀), the current value. */
  get mean(): number {
    const now = this.#simulation.now;
    const elapsed = now - this.#since;
    if (elapsed === 0) return this.#value;
    return (this.#area + this.#value * (now - this.#lastChange)) / elapsed;
  }

  /** Sets the value from now on. */
  set(value: number): void {
    this.#change(requireFinite(value, 'TimeAverage value'));
  }

  /** Changes the value by `delta` from now on. */
  add(delta: number): void {
    this.#change(this.#value + requireFinite(delta, 'TimeAverage change'));
  }

  /** Starts averaging again from now, keeping the current value (e.g. at the end of a warm-up). */
  reset(): void {
    const now = this.#simulation.now;
    this.#since = now;
    this.#lastChange = now;
    this.#area = 0;
  }

  /** Closes the interval since the last change, adding its area, and starts one with `value`. */
  #change(value: number): void {
    const now = this.#simulation.now;
    this.#area += this.#value * (now - this.#lastChange);
    this.#lastChange = now;
    this.#value = value;
  }
}

/** Number and mean of observations, such as the waiting times of entities. */
export class Tally {
  #count = 0;
  #sum = 0;

  get count(): number {
    return this.#count;
  }

  /** Mean of the observations; NaN while there are none. */
  get mean(): number {
    return this.#count === 0 ? Number.NaN : this.#sum / this.#count;
  }

  add(value: number): void {
    this.#sum += requireFinite(value, 'Tally observation');
    this.#count++;
  }

  /** Forgets all observations (e.g. at the end of a warm-up). */
  reset(): void {
    this.#count = 0;
    this.#sum = 0;
  }
}
