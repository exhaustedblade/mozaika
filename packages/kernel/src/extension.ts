/**
 * The extension API of the kernel (docs/ARCHITECTURE.md, "Очередь событий на
 * массивах"; П-37): kinds of events for packages built on the kernel, such as
 * the process blocks. A package registers a kind with a handler, then
 * schedules events of that kind that carry two numbers, so that an event
 * costs no object and no closure — as the kernel's own agent events do.
 *
 * It gives a package no more than Simulation.schedule() gives model code:
 * the events follow the rule for simultaneous events (П-8), their delays are
 * checked, and nothing else of the event queue is reachable — no cancelling,
 * no clock, no other events. Model code schedules its events with
 * schedule(); this module is not part of the main export of the kernel.
 *
 *     const ends = new EventKind(simulation, {
 *       fire: (row) => { this.#finish(row); },
 *       label: (row) => `${this.name}: ${this.#describe(row)} ends`,
 *     });
 *     ends.schedule(duration, row, 0);
 */
import { describeValue, eventFailure, requireDelay, SimulationError } from './errors.js';
import { DEFAULT_PRIORITY } from './event-queue.js';
import { type EventKindHandler, type Scheduler, schedulerOf } from './scheduler.js';
import { Simulation } from './simulation.js';

/** What a package does with the events of its kind. */
export interface EventHandler {
  /**
   * Fires one event, given the two numbers it was scheduled with. Whatever it
   * throws stops the run as EVENT_FAILED, named by label() — unless it is
   * already a PROCESS_FAILED or AGENT_FAILED error, which says what failed.
   */
  fire(target: number, data: number): void;
  /**
   * Name of an event in traces and error messages. It is computed only when
   * one is needed (П-29): before the event fires if the simulation has a
   * trace, otherwise after fire() has failed — so what it reads should still
   * be there when fire() throws.
   */
  label(target: number, data: number): string | undefined;
}

/** A kind of events that a package registers with one simulation. */
export class EventKind {
  readonly simulation: Simulation;
  readonly #scheduler: Scheduler;
  /** Number of the kind, which its events carry. */
  readonly #kind: number;

  constructor(simulation: Simulation, handler: EventHandler) {
    if (!(simulation instanceof Simulation)) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `EventKind needs a Simulation, got ${describeValue(simulation)}`,
      );
    }
    this.simulation = simulation;
    this.#scheduler = schedulerOf(simulation);
    this.#kind = this.#scheduler.registerKind(new PackageEvents(this.#scheduler, requireHandler(handler)));
  }

  /**
   * Schedules an event of this kind `delay` units of model time from now (0
   * means "now, after the events already due now"), with the default
   * priority. `target` and `data` are what the handler gets back: 32-bit
   * integers, such as the row of an entity in a block's table.
   */
  schedule(delay: number, target: number, data: number): void {
    // One cheap test for the usual case, which runs on every event; the checks
    // that name the problem run only when it fails.
    const valid =
      typeof delay === 'number' && delay >= 0 && delay < Infinity && (target | 0) === target && (data | 0) === data;
    if (!valid) refuseEvent(delay, target, data);
    const scheduler = this.#scheduler;
    scheduler.add(scheduler.now + delay, DEFAULT_PRIORITY, this.#kind, target, data);
  }
}

/** The kernel's side of a package's kind: it turns what the handler throws into the error of the event. */
class PackageEvents implements EventKindHandler {
  readonly #scheduler: Scheduler;
  readonly #handler: EventHandler;

  constructor(scheduler: Scheduler, handler: EventHandler) {
    this.#scheduler = scheduler;
    this.#handler = handler;
  }

  fire(target: number, data: number): void {
    try {
      this.#handler.fire(target, data);
    } catch (error) {
      throw eventFailure(this.#labelAfterFailure(target, data), this.#scheduler.now, error);
    }
  }

  label(target: number, data: number): string | undefined {
    return this.#handler.label(target, data);
  }

  /** The label of a failed event; a label that fails too must not hide the error of the event. */
  #labelAfterFailure(target: number, data: number): string | undefined {
    try {
      return this.#handler.label(target, data);
    } catch {
      return undefined;
    }
  }
}

function requireHandler(handler: unknown): EventHandler {
  const candidate = (typeof handler === 'object' && handler !== null ? handler : {}) as Partial<EventHandler>;
  if (typeof candidate.fire !== 'function' || typeof candidate.label !== 'function') {
    throw new SimulationError('INVALID_ARGUMENT', 'EventKind handler must have the methods fire() and label()');
  }
  return handler as EventHandler;
}

/** Throws the error that says what is wrong with an event schedule() refused. */
function refuseEvent(delay: number, target: number, data: number): never {
  requireDelay(delay, 'EventKind schedule() delay');
  requireInt32(target, 'EventKind schedule() target');
  requireInt32(data, 'EventKind schedule() data');
  throw new Error('EventKind: an event was refused without a reason');
}

/** The records keep `target` and `data` in Int32Array columns, which would silently cut anything else. */
function requireInt32(value: number, what: string): void {
  if ((value | 0) !== value) {
    throw new SimulationError('INVALID_ARGUMENT', `${what} must be a 32-bit integer, got ${String(value)}`);
  }
}
