/**
 * A pool of identical resource units (clerks, machines, desks) that processes
 * seize and release, served strictly first-come, first-served.
 */
import { type ProcessBody, type Signal, SimulationError, type Simulation, timeout } from '@mozaika/kernel';

import { Fifo } from './fifo.js';
import { TimeAverage } from './statistics.js';
import { requireWholeNumber } from './validation.js';

export interface ResourcePoolOptions {
  /** Number of units: a whole number, at least 1. */
  readonly capacity: number;
  /** Name for error messages; default "pool". */
  readonly name?: string;
}

/** Wakes a process again at the current time, after the events already due now. */
const RIGHT_NOW = timeout(0);

/**
 * A pool of `capacity` identical units.
 *
 * Requests are served strictly in the order they were made (FIFO), and a
 * released unit cannot be taken by a newcomer while others wait:
 * - `release()` hands the unit straight to the first waiting request; it never
 *   becomes free, so a process asking at the same moment cannot take it. The
 *   request's process goes on as an event at the current time, like a process
 *   woken by a signal.
 * - Requests go on in the order their units were granted: while a granted
 *   request has not gone on yet, a new request takes a free unit but also goes
 *   on through an event, after it.
 */
export class ResourcePool {
  readonly simulation: Simulation;
  readonly name: string;
  readonly capacity: number;
  readonly stats: {
    /** Number of busy units over time. A unit is busy from seize (or handover) to release. */
    readonly busy: TimeAverage;
  };
  /** One signal per waiting request, in the order of the requests. */
  readonly #waiting = new Fifo<Signal>();
  #busy = 0;
  /** Units granted to requests whose processes have not gone on yet. */
  #grantsInFlight = 0;

  constructor(simulation: Simulation, options: ResourcePoolOptions) {
    this.simulation = simulation;
    this.name = options.name ?? 'pool';
    this.capacity = requireWholeNumber(options.capacity, `ResourcePool "${this.name}" capacity`, 1);
    this.stats = { busy: new TimeAverage(simulation) };
  }

  /** Units in use now. */
  get busy(): number {
    return this.#busy;
  }

  /** Units free now. */
  get available(): number {
    return this.capacity - this.#busy;
  }

  /** Requests waiting for a unit now. */
  get waiting(): number {
    return this.#waiting.size;
  }

  /** Time-average share of busy units: mean busy units / capacity. */
  get utilization(): number {
    return this.stats.busy.mean / this.capacity;
  }

  /** Seizes one unit, waiting in FIFO order if none is free: `yield* pool.seize()`. */
  *seize(): ProcessBody {
    if (this.#busy === this.capacity) {
      yield* this.#waitForHandover();
      return;
    }
    this.#setBusy(this.#busy + 1);
    if (this.#grantsInFlight > 0) yield* this.#goOnAfterEarlierGrants();
  }

  /**
   * Seizes a free unit now and returns true, or returns false if there is
   * none; never waits. The caller goes on at once, so it is meant for code that
   * then continues in a new event, as a Source does when it starts an entity.
   */
  trySeize(): boolean {
    if (this.#busy === this.capacity) return false;
    this.#setBusy(this.#busy + 1);
    return true;
  }

  /** Releases one unit: hands it to the first waiting request, or frees it. */
  release(): void {
    if (this.#busy === 0) {
      throw new SimulationError('INVALID_STATE', `ResourcePool "${this.name}": release() with no unit seized`);
    }
    const firstWaiting = this.#waiting.shift();
    if (firstWaiting === undefined) {
      this.#setBusy(this.#busy - 1);
      return;
    }
    // The unit stays busy: it now belongs to the waiting request.
    this.#grantsInFlight++;
    firstWaiting.notify();
  }

  /** Starts the statistics again from now (e.g. after a warm-up). */
  resetStatistics(): void {
    this.stats.busy.reset();
  }

  /** Waits until release() hands a unit to this request. */
  *#waitForHandover(): ProcessBody {
    const handover = this.simulation.signal(this.name);
    this.#waiting.push(handover);
    yield handover.wait();
    this.#grantsInFlight--; // counted by release()
  }

  /** Goes on through an event at the current time, which fires after those of the earlier grants. */
  *#goOnAfterEarlierGrants(): ProcessBody {
    this.#grantsInFlight++;
    yield RIGHT_NOW;
    this.#grantsInFlight--;
  }

  #setBusy(busy: number): void {
    this.#busy = busy;
    this.stats.busy.set(busy);
  }
}
