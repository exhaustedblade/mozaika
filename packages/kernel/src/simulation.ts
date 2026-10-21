/**
 * The simulation clock and run loop.
 *
 * Time is a plain number of model-time units (minutes, hours… — the model
 * decides) that starts at `startTime` and only moves forward, from one event to
 * the next. Events are simultaneous only if their times are exactly equal, so
 * times that must coincide should be computed the same way, or with steps that
 * are exact in binary (0.25 rather than 0.1). Simultaneous events fire in the
 * order defined in event-queue.ts.
 *
 * The kernel renders nothing and reads no wall-clock time: a run depends only
 * on the model and its seed.
 */

import {
  DEFAULT_PRIORITY,
  type EventHandle,
  type EventInfo,
  EventQueue,
  type ScheduledEvent,
} from './event-queue.js';
import { messageOf, requireDelay, requireFinite, requireFunction, SimulationError } from './errors.js';
import { Process, type ProcessBody, type ProcessOptions } from './process.js';
import { Random } from './random.js';
import { Signal } from './signal.js';
import { type JsonValue, type SnapshotOptions, type SnapshotRecorder, SnapshotSchedule } from './snapshots.js';

export interface SimulationOptions {
  /** Seed of `simulation.random`; default 0. Give either `seed` or `random`. */
  readonly seed?: number;
  /**
   * The random stream of this run, e.g. one stream per replication of an
   * experiment: `new Random(seed, ['replication', String(k)])`.
   */
  readonly random?: Random;
  /** Model time at the start; default 0. */
  readonly startTime?: number;
  /** Called with every event just before it fires; for traces and debugging. */
  readonly trace?: (event: EventInfo) => void;
}

export interface ScheduleOptions {
  /** Smaller fires earlier among events at the same time; default 0. */
  readonly priority?: number;
  /** Name of the event in traces and error messages. */
  readonly label?: string | undefined;
}

/**
 * Why run() returned:
 * - until: the clock reached the requested time;
 * - empty: no events are left (run without a time limit);
 * - stopped: stop() was called from inside an event.
 */
export type RunEndReason = 'until' | 'empty' | 'stopped';

export interface RunResult {
  readonly reason: RunEndReason;
  /** Model time when the run returned. */
  readonly time: number;
  /** Number of events fired during this run. */
  readonly events: number;
}

export class Simulation {
  readonly random: Random;
  readonly #queue = new EventQueue();
  readonly #recorders: SnapshotSchedule<JsonValue>[] = [];
  readonly #trace: ((event: EventInfo) => void) | undefined;
  #now: number;
  #eventsProcessed = 0;
  #processCount = 0;
  #running = false;
  #stopRequested = false;
  /** Earliest time any recorder wants a snapshot; Infinity if none. */
  #nextSnapshotTime = Infinity;

  constructor(options: SimulationOptions = {}) {
    if (options.seed !== undefined && options.random !== undefined) {
      throw new SimulationError('INVALID_ARGUMENT', 'Simulation takes either a seed or a random stream, not both');
    }
    this.random = options.random ?? new Random(options.seed ?? 0);
    this.#now = requireFinite(options.startTime ?? 0, 'Simulation startTime');
    this.#trace = options.trace === undefined ? undefined : requireFunction(options.trace, 'Simulation trace');
  }

  /** Current model time. */
  get now(): number {
    return this.#now;
  }

  /** Number of events waiting to fire (cancelled ones excluded). */
  get pendingEvents(): number {
    return this.#queue.size;
  }

  /** Number of events fired since the simulation was created. */
  get eventsProcessed(): number {
    return this.#eventsProcessed;
  }

  /** True while run() or step() is firing events. */
  get running(): boolean {
    return this.#running;
  }

  /** Time of the next event, or Infinity if there is none. */
  nextEventTime(): number {
    return this.#queue.peek()?.time ?? Infinity;
  }

  /** Schedules `action` to fire `delay` time units from now (0 means "now, after what is already due"). */
  schedule(delay: number, action: () => void, options?: ScheduleOptions): EventHandle {
    requireDelay(delay, 'schedule() delay');
    return this.#add(this.#now + delay, action, options, 'schedule()');
  }

  /** Schedules `action` to fire at model time `time`, which must not be in the past. */
  scheduleAt(time: number, action: () => void, options?: ScheduleOptions): EventHandle {
    requireFinite(time, 'scheduleAt() time');
    if (time < this.#now) {
      throw new SimulationError(
        'EVENT_IN_PAST',
        `scheduleAt() time ${String(time)} is in the past: the clock is already at ${String(this.#now)}`,
      );
    }
    return this.#add(time, action, options, 'scheduleAt()');
  }

  /**
   * Starts a process. It does not run immediately: its start is an event at the
   * current time, after the events already due now.
   */
  process<TResult>(body: ProcessBody<TResult>, options?: ProcessOptions): Process<TResult> {
    const process = new Process(this, body, this.#processCount + 1, options);
    this.#processCount++;
    return process;
  }

  /** Creates a signal that processes can wait for. */
  signal(name?: string): Signal {
    return new Signal(this, name);
  }

  /** Starts taking snapshots of the model state every `every` time units (see snapshots.ts). */
  recordSnapshots<T extends JsonValue>(options: SnapshotOptions<T>): SnapshotRecorder<T> {
    const recorder = new SnapshotSchedule(options, this.#now);
    this.#recorders.push(recorder);
    this.#nextSnapshotTime = Math.min(this.#nextSnapshotTime, recorder.nextTime);
    return recorder;
  }

  /** Fires the next event; returns false if there was none. */
  step(): boolean {
    this.#beginFiring('step()');
    try {
      const event = this.#queue.pop();
      if (event === undefined) return false;
      this.#fire(event);
      return true;
    } finally {
      this.#running = false;
    }
  }

  /**
   * Fires events in order until the clock would pass `until` (events at exactly
   * `until` do fire), the queue is empty, or stop() is called. With a finite
   * `until`, the clock then stands at `until`. Without one, it stays at the last
   * event, and a model that keeps scheduling events runs until stop() is called.
   */
  run(until = Infinity): RunResult {
    if (requireTimeLimit(until, 'run() until') < this.#now) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `run() until ${String(until)} is in the past: the clock is already at ${String(this.#now)}`,
      );
    }
    this.#beginFiring('run()');
    const eventsBefore = this.#eventsProcessed;
    try {
      const reason = this.#fireUntil(until);
      return { reason, time: this.#now, events: this.#eventsProcessed - eventsBefore };
    } finally {
      this.#running = false;
    }
  }

  /** Asks the current run() to return after the event being fired. Has no effect outside a run. */
  stop(): void {
    if (this.#running) this.#stopRequested = true;
  }

  /** Validates the action and priority, then queues the event; `caller` names the method in errors. */
  #add(time: number, action: () => void, options: ScheduleOptions | undefined, caller: string): ScheduledEvent {
    requireFunction(action, `${caller} action`);
    const priority = requireFinite(options?.priority ?? DEFAULT_PRIORITY, `${caller} priority`);
    return this.#queue.add(time, priority, options?.label, action);
  }

  /** Marks the start of run() or step(), refusing one called from inside an event. */
  #beginFiring(caller: string): void {
    if (this.#running) {
      throw new SimulationError(
        'REENTRANT_CALL',
        `${caller} was called from inside an event; schedule an event or call stop() instead`,
      );
    }
    this.#running = true;
    this.#stopRequested = false;
  }

  #fireUntil(until: number): RunEndReason {
    while (!this.#stopRequested) {
      const event = this.#queue.pop(until);
      if (event === undefined) return this.#finishRunAt(until);
      this.#fire(event);
    }
    return 'stopped';
  }

  /** Ends a run that has fired every event up to `until`. */
  #finishRunAt(until: number): RunEndReason {
    // Nothing else happens up to `until`, so the state up to it is final.
    if (until === Infinity) {
      this.#takeSnapshotsUpTo(this.#now, true);
      return 'empty';
    }
    this.#takeSnapshotsUpTo(until, true);
    this.#now = until;
    return 'until';
  }

  /** Fires an event already taken out of the queue. */
  #fire(event: ScheduledEvent): void {
    // Everything before `event.time` has happened: snapshots due before it are final.
    if (event.time > this.#nextSnapshotTime) this.#takeSnapshotsUpTo(event.time, false);
    this.#now = event.time;
    this.#eventsProcessed++;
    this.#trace?.(event);
    try {
      event.action();
    } catch (error) {
      throw describeFailure(event, error);
    }
  }

  /** Takes, in time order, every snapshot due before `limit` (or at `limit` too, if `inclusive`). */
  #takeSnapshotsUpTo(limit: number, inclusive: boolean): void {
    for (;;) {
      const recorder = this.#earliestRecorder();
      const time = recorder?.nextTime ?? Infinity;
      this.#nextSnapshotTime = time;
      if (recorder === undefined || time > limit || (time === limit && !inclusive)) return;
      this.#now = time;
      recorder.captureNext();
    }
  }

  /** The recorder with the earliest next snapshot; the first registered wins ties. */
  #earliestRecorder(): SnapshotSchedule<JsonValue> | undefined {
    let earliest: SnapshotSchedule<JsonValue> | undefined;
    for (const recorder of this.#recorders) {
      if (recorder.nextTime < (earliest?.nextTime ?? Infinity)) earliest = recorder;
    }
    return earliest;
  }
}

/** Like requireFinite, but also allows +Infinity, meaning "no limit". */
function requireTimeLimit(value: number, what: string): number {
  return value === Infinity ? value : requireFinite(value, what);
}

/** Wraps an error thrown by an event action with the event's name and time. */
function describeFailure(event: ScheduledEvent, error: unknown): SimulationError {
  // A failed process or agent has already said which one failed and when.
  if (error instanceof SimulationError && (error.code === 'PROCESS_FAILED' || error.code === 'AGENT_FAILED')) {
    return error;
  }
  const name = event.label === undefined ? 'Event' : `Event "${event.label}"`;
  return new SimulationError('EVENT_FAILED', `${name} failed at time ${String(event.time)}: ${messageOf(error)}`, {
    cause: error,
  });
}
