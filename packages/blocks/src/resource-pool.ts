/**
 * A pool of identical resource units (clerks, machines, desks) that blocks
 * and model processes seize and release, served strictly first-come,
 * first-served (docs/BLOCKS.md, section 2).
 */
import { type ProcessBody, Signal, SimulationError, type Simulation, timeout } from '@mozaika/kernel';
import { EventKind } from '@mozaika/kernel/extension';

import type { RequestOutcome, UnitRequester } from './block.js';
import { GrantTable, RequestQueue } from './requests.js';
import { TimeAverage } from './statistics.js';
import { requireWholeNumber } from './validation.js';

export interface ResourcePoolOptions {
  /** Number of units: a whole number, at least 1. */
  readonly capacity: number;
  /** Name for traces and error messages; default "pool". */
  readonly name?: string;
}

/** Wakes a process again at the current time, after the events already due now. */
const RIGHT_NOW = timeout(0);

/**
 * A pool of `capacity` identical units.
 *
 * Requests of blocks (request) and of model processes (seize) wait in one
 * queue and are served strictly in the order they were made, and a released
 * unit cannot be taken by a newcomer while others wait (П-15):
 * - `release()` hands the unit straight to the first waiting request; it never
 *   becomes free, so a request made at the same moment cannot take it. The
 *   request goes on as an event at the current time: a process is woken by
 *   its signal, a block gets the pool's grant event.
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
  readonly #waiting = new RequestQueue();
  /** Units granted to blocks that go on in a grant event; the event carries the row. */
  readonly #grants = new GrantTable();
  readonly #grantEvents: EventKind;
  #busy = 0;
  /** Units granted to requests, of blocks and processes, that have not gone on yet. */
  #grantsInFlight = 0;

  constructor(simulation: Simulation, options: ResourcePoolOptions) {
    this.simulation = simulation;
    this.name = options.name ?? 'pool';
    this.capacity = requireWholeNumber(options.capacity, `ResourcePool "${this.name}" capacity`, 1);
    this.stats = { busy: new TimeAverage(simulation) };
    this.#grantEvents = new EventKind(simulation, {
      fire: (row) => {
        this.#goOn(row);
      },
      label: (row) => `${this.name} → ${this.#grants.requester(row)?.describeRequest(this.#grants.ticket(row)) ?? '?'}`,
    });
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

  /** Seizes one unit for a model process, waiting in FIFO order if none is free: `yield* pool.seize()`. */
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
   * none; never waits. The caller goes on at once, whatever was granted
   * before it, so it is meant for model code that then continues in a new event.
   */
  trySeize(): boolean {
    if (this.#busy === this.capacity) return false;
    this.#setBusy(this.#busy + 1);
    return true;
  }

  /**
   * Seizes one unit for a block, or for a model's own EntityReceiver, on
   * behalf of an entity: 'granted' if it goes on now, or 'pending' if it
   * waits — then `requester.unitGranted(this, ticket)` comes in the pool's
   * grant event, at the moment the unit is the requester's.
   */
  request(requester: UnitRequester, ticket: number): RequestOutcome {
    if (this.#busy === this.capacity) {
      this.#waiting.push(requester, ticket);
      return 'pending';
    }
    return this.#takeFreeUnit(requester, ticket);
  }

  /** Like request(), but never waits for a busy pool: 'refused' if no unit is free. Used for the arrivals of a Source. */
  tryRequest(requester: UnitRequester, ticket: number): RequestOutcome {
    if (this.#busy === this.capacity) return 'refused';
    return this.#takeFreeUnit(requester, ticket);
  }

  /** Releases one unit: hands it to the first waiting request, or frees it. */
  release(): void {
    if (this.#busy === 0) {
      throw new SimulationError('INVALID_STATE', `ResourcePool "${this.name}": release() with no unit seized`);
    }
    const ticket = this.#waiting.firstTicket;
    const firstWaiting = this.#waiting.shift();
    if (firstWaiting === undefined) {
      this.#setBusy(this.#busy - 1);
      return;
    }
    // The unit stays busy: it now belongs to the waiting request.
    if (firstWaiting instanceof Signal) {
      this.#grantsInFlight++; // the process counts itself out when it wakes
      firstWaiting.notify();
    } else {
      this.#grantToBlock(firstWaiting, ticket);
    }
  }

  /** Starts the statistics again from now (e.g. after a warm-up). */
  resetStatistics(): void {
    this.stats.busy.reset();
  }

  /** A unit is free: the request takes it, and goes on now unless earlier grants have not gone on yet. */
  #takeFreeUnit(requester: UnitRequester, ticket: number): RequestOutcome {
    this.#setBusy(this.#busy + 1);
    if (this.#grantsInFlight === 0) return 'granted';
    this.#grantToBlock(requester, ticket);
    return 'pending';
  }

  /** The block goes on in a grant event at the current time, after the events already due now. */
  #grantToBlock(requester: UnitRequester, ticket: number): void {
    this.#grantsInFlight++;
    this.#grantEvents.schedule(0, this.#grants.add(requester, ticket), 0);
  }

  /** The grant event of a block: the block goes on with its entity. */
  #goOn(row: number): void {
    const requester = this.#grants.requester(row);
    if (requester === undefined) throw new Error(`ResourcePool "${this.name}": grant ${String(row)} has no requester`);
    this.#grantsInFlight--;
    requester.unitGranted(this, this.#grants.ticket(row));
    // Freed after the block went on: the label of this event reads the row if the block fails.
    this.#grants.release(row);
  }

  /** Waits until release() hands a unit to this process. */
  *#waitForHandover(): ProcessBody {
    const handover = this.simulation.signal(this.name);
    this.#waiting.push(handover, 0);
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
