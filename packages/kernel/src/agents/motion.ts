/**
 * Movement of the agents of one population (docs/AGENTS.md, section 9; П-32).
 *
 * An agent stands at a point or walks along a straight segment: from where,
 * to where, the moment it started and the moment it arrives. Its position at
 * any moment follows from the segment by a formula, so a walk costs one event
 * — the arrival — however long it lasts, and the positions of a whole
 * population are computed in one pass over the columns.
 *
 * The population creates these columns when one of its agents first moves:
 * a population that never moves pays nothing for them.
 */
import { describeValue, requireDelay, requireFinite, requirePositive, SimulationError } from '../errors.js';
import { DEFAULT_PRIORITY } from '../event-queue.js';
import type { Scheduler } from '../scheduler.js';
import { grown } from '../typed-arrays.js';

/** A point of the plane, in the model's units of length. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * How an agent walks to its target: at a speed or for a duration (one of
 * them), and whether leaving its state stops it.
 */
export interface MoveOptions {
  /** Units of length per unit of model time; greater than zero. */
  readonly speed?: number;
  /** Units of model time the walk takes; not negative. */
  readonly duration?: number;
  /**
   * Stop the walk when the agent next leaves a state, where it is at that
   * moment, before the exit actions; default false. Without it, the walk goes
   * on whatever the statechart does, as a block that leads an entity needs.
   */
  readonly stopOnExit?: boolean;
}

/** Options of a walk that have passed requireMoveOptions: a speed or a duration, never both. */
export type CheckedMoveOptions =
  | { readonly speed: number; readonly duration?: undefined; readonly stopOnExit?: boolean }
  | { readonly speed?: undefined; readonly duration: number; readonly stopOnExit?: boolean };

/** Checks a point given by model code and returns it: an object with finite numbers x and y. */
export function requirePoint(point: unknown, what: string): Point {
  if (typeof point !== 'object' || point === null) {
    throw new SimulationError(
      'INVALID_ARGUMENT',
      `${what} must be an object with numbers x and y, got ${describeValue(point)}`,
    );
  }
  const { x, y } = point as Partial<Record<'x' | 'y', unknown>>;
  requireFinite(x, `${what} x`);
  requireFinite(y, `${what} y`);
  return point as Point;
}

/**
 * Checks the options of moveTo() and returns them: exactly one of a speed
 * above zero and a duration not below zero, and stopOnExit, if given, a
 * boolean. The same object comes back, so a walk allocates nothing here.
 */
export function requireMoveOptions(options: unknown): CheckedMoveOptions {
  if (typeof options !== 'object' || options === null) {
    throw new SimulationError(
      'INVALID_ARGUMENT',
      `moveTo() options must give speed or duration, got ${describeValue(options)}`,
    );
  }
  const { speed, duration, stopOnExit } = options as Partial<Record<keyof MoveOptions, unknown>>;
  if ((speed === undefined) === (duration === undefined)) {
    throw new SimulationError('INVALID_ARGUMENT', 'moveTo() options must give speed or duration, not both');
  }
  if (speed !== undefined) requirePositive(speed, 'moveTo() speed');
  if (duration !== undefined) requireDelay(duration, 'moveTo() duration');
  if (stopOnExit !== undefined && typeof stopOnExit !== 'boolean') {
    throw new SimulationError(
      'INVALID_ARGUMENT',
      `moveTo() stopOnExit must be true or false, got ${describeValue(stopOnExit)}`,
    );
  }
  return options as CheckedMoveOptions;
}

/** Numbers of a segment: from x, y, to x, y, start, arrival — as a snapshot gives it to a viewer. */
export const SEGMENT_WIDTH = 6;

/**
 * Numbers per row of the motion column: the segment, the slot of the pending
 * arrival and the flag of stopOnExit — eight Float64 numbers, 64 bytes, one
 * line of the processor's cache. A step of an agent (arrival, moveTo) reads
 * and writes all of them, so they lie together: on a million walking agents
 * this is about 14 % faster than the segment with the slot and the flag in
 * columns of their own, and costs 11 bytes per agent more (docs/AGENTS.md,
 * section 9). The slot and the flag are small whole numbers, exact in Float64.
 */
const ROW_WIDTH = 8;
const FROM_X = 0;
const FROM_Y = 1;
const TO_X = 2;
const TO_Y = 3;
const START = 4;
const ARRIVAL = 5;
const ARRIVAL_SLOT = 6;
const STOPS_ON_EXIT = 7;

/** The arrival slot of a row without a pending arrival. */
const NO_EVENT = -1;

/**
 * The coordinate of a walker at `time`: on the straight line of its segment
 * before the arrival, and exactly the target from the arrival on — the formula
 * at k = 1 could differ from it in the last bit.
 */
function along(from: number, to: number, start: number, arrival: number, time: number): number {
  if (time >= arrival) return to;
  return from + (to - from) * ((time - start) / (arrival - start));
}

/**
 * Writes the segments of `size` agents that have never moved, as writeSegments
 * would: standing at the origin since time 0, as a new row of AgentMotion does.
 */
export function writeSegmentsAtOrigin(into: Float32Array, size: number, time: number): void {
  const end = size * SEGMENT_WIDTH;
  into.fill(0, 0, end);
  for (let cell = 0; cell < end; cell += SEGMENT_WIDTH) {
    into[cell + START] = -time;
    into[cell + ARRIVAL] = -time;
  }
}

/**
 * The segments of the agents of one population, by row of its columns, with
 * the events of their arrivals. Rows follow the agents: when the population
 * moves its last agent into the row of a removed one, the segment and the
 * arrival go with it (moveRow).
 */
export class AgentMotion {
  readonly #scheduler: Scheduler;
  /** The kind of the arrival events; an event's target is the agent's row. */
  readonly #arrivalKind: number;
  /** ROW_WIDTH numbers per row: the segment, the arrival slot and the flag of stopOnExit. */
  #rows: Float64Array;

  /** Columns for `capacity` rows, all agents standing at the origin. */
  constructor(scheduler: Scheduler, arrivalKind: number, capacity: number) {
    this.#scheduler = scheduler;
    this.#arrivalKind = arrivalKind;
    this.#rows = standingRows(capacity, 0);
  }

  /** Whether the agent in `row` is walking: its arrival is still to come. */
  isMoving(row: number): boolean {
    return (this.#rows[row * ROW_WIDTH + ARRIVAL_SLOT] ?? NO_EVENT) !== NO_EVENT;
  }

  /** Where the agent in `row` is now. */
  position(row: number): Point {
    const now = this.#scheduler.now;
    return { x: this.#coordinate(row, FROM_X, TO_X, now), y: this.#coordinate(row, FROM_Y, TO_Y, now) };
  }

  /** The agent in `row` stands at (x, y) from now on; its walk, if any, is over. */
  placeAt(row: number, x: number, y: number): void {
    this.#cancelArrival(row);
    this.#stand(row, x, y);
  }

  /**
   * The agent in `row` walks in a straight line from where it is now to
   * (x, y), as `walk` says; the arrival of an earlier walk is cancelled. The
   * caller has checked the target and the options. A walk too long for its
   * speed to arrive at a finite time is refused before anything changes.
   */
  moveTo(row: number, x: number, y: number, walk: CheckedMoveOptions): void {
    const now = this.#scheduler.now;
    // Read without a Point object: a walk that starts on every arrival must not allocate.
    const hereX = this.#coordinate(row, FROM_X, TO_X, now);
    const hereY = this.#coordinate(row, FROM_Y, TO_Y, now);
    const duration = walk.speed === undefined ? walk.duration : Math.hypot(x - hereX, y - hereY) / walk.speed;
    const arrival = requireFinite(now + duration, 'moveTo() arrival time');
    this.#cancelArrival(row);
    const rows = this.#rows;
    const cell = row * ROW_WIDTH;
    rows[cell + FROM_X] = hereX;
    rows[cell + FROM_Y] = hereY;
    rows[cell + TO_X] = x;
    rows[cell + TO_Y] = y;
    rows[cell + START] = now;
    rows[cell + ARRIVAL] = arrival;
    rows[cell + ARRIVAL_SLOT] = this.#scheduler.add(arrival, DEFAULT_PRIORITY, this.#arrivalKind, row, 0);
    rows[cell + STOPS_ON_EXIT] = walk.stopOnExit === true ? 1 : 0;
  }

  /** The agent in `row` stops where it is now; returns whether it was walking. */
  stop(row: number): boolean {
    if (!this.isMoving(row)) return false;
    const now = this.#scheduler.now;
    const hereX = this.#coordinate(row, FROM_X, TO_X, now);
    const hereY = this.#coordinate(row, FROM_Y, TO_Y, now);
    this.#cancelArrival(row);
    this.#stand(row, hereX, hereY);
    return true;
  }

  /** The agent in `row` leaves a state: a walk bound to it stops (MoveOptions.stopOnExit). */
  leaveState(row: number): void {
    if (this.#rows[row * ROW_WIDTH + STOPS_ON_EXIT] === 1) this.stop(row);
  }

  /**
   * The arrival of the agent in `row` fires: the event has left the queue, so
   * the agent is no longer walking; its segment stays, and puts it at the target.
   */
  arrived(row: number): void {
    const cell = row * ROW_WIDTH;
    this.#rows[cell + ARRIVAL_SLOT] = NO_EVENT;
    this.#rows[cell + STOPS_ON_EXIT] = 0;
  }

  /** The agent in `row` is removed: its arrival, if any, is cancelled. */
  remove(row: number): void {
    this.#cancelArrival(row);
  }

  /** A new agent takes `row`: it stands at the origin. */
  clearRow(row: number): void {
    const cell = row * ROW_WIDTH;
    this.#rows.fill(0, cell, cell + ROW_WIDTH);
    this.#rows[cell + ARRIVAL_SLOT] = NO_EVENT;
  }

  /** The agent in row `from` moves to row `to`; its pending arrival is pointed at the new row. */
  moveRow(from: number, to: number): void {
    const rows = this.#rows;
    // Element by element, as the population copies its other columns: copyWithin() is a call.
    for (let cell = 0; cell < ROW_WIDTH; cell++) rows[to * ROW_WIDTH + cell] = rows[from * ROW_WIDTH + cell] ?? 0;
    rows[from * ROW_WIDTH + ARRIVAL_SLOT] = NO_EVENT;
    const slot = rows[to * ROW_WIDTH + ARRIVAL_SLOT] ?? NO_EVENT;
    if (slot !== NO_EVENT) this.#scheduler.retarget(slot, to);
  }

  /** Room for `capacity` rows; the population grows its columns together. */
  grow(capacity: number): void {
    this.#rows = grown(this.#rows, standingRows(capacity, this.#rows.length / ROW_WIDTH));
  }

  /**
   * Writes the positions of the first `size` rows at `time` into `into`, x
   * and y of each in turn. One pass over the rows, which lie one after
   * another; the arrays are read through local variables, as in every hot loop.
   */
  writePositions(into: Float64Array, size: number, time: number): void {
    const rows = this.#rows;
    for (let cell = 0, out = 0; out < 2 * size; cell += ROW_WIDTH, out += 2) {
      const start = rows[cell + START] ?? 0;
      const arrival = rows[cell + ARRIVAL] ?? 0;
      into[out] = along(rows[cell + FROM_X] ?? 0, rows[cell + TO_X] ?? 0, start, arrival, time);
      into[out + 1] = along(rows[cell + FROM_Y] ?? 0, rows[cell + TO_Y] ?? 0, start, arrival, time);
    }
  }

  /**
   * Writes the segments of the first `size` rows into `into`, as a viewer
   * takes them (docs/ARCHITECTURE.md, "Снимок популяции"): Float32, with the
   * start and the arrival counted from `time`. A difference of two nearby
   * moments keeps its precision in Float32, where a moment itself would not.
   */
  writeSegments(into: Float32Array, size: number, time: number): void {
    const rows = this.#rows;
    for (let cell = 0, out = 0; out < SEGMENT_WIDTH * size; cell += ROW_WIDTH, out += SEGMENT_WIDTH) {
      into[out + FROM_X] = rows[cell + FROM_X] ?? 0;
      into[out + FROM_Y] = rows[cell + FROM_Y] ?? 0;
      into[out + TO_X] = rows[cell + TO_X] ?? 0;
      into[out + TO_Y] = rows[cell + TO_Y] ?? 0;
      into[out + START] = (rows[cell + START] ?? 0) - time;
      into[out + ARRIVAL] = (rows[cell + ARRIVAL] ?? 0) - time;
    }
  }

  /** One coordinate of the agent in `row` at `time`: x with FROM_X and TO_X, y with FROM_Y and TO_Y. */
  #coordinate(row: number, from: number, to: number, time: number): number {
    const rows = this.#rows;
    const cell = row * ROW_WIDTH;
    const start = rows[cell + START] ?? 0;
    return along(rows[cell + from] ?? 0, rows[cell + to] ?? 0, start, rows[cell + ARRIVAL] ?? 0, time);
  }

  /** The agent in `row`, whose arrival is not pending, stands at (x, y) from now on. */
  #stand(row: number, x: number, y: number): void {
    const now = this.#scheduler.now;
    const rows = this.#rows;
    const cell = row * ROW_WIDTH;
    rows[cell + FROM_X] = x;
    rows[cell + FROM_Y] = y;
    rows[cell + TO_X] = x;
    rows[cell + TO_Y] = y;
    rows[cell + START] = now;
    rows[cell + ARRIVAL] = now;
    rows[cell + STOPS_ON_EXIT] = 0;
  }

  #cancelArrival(row: number): void {
    const cell = row * ROW_WIDTH + ARRIVAL_SLOT;
    const slot = this.#rows[cell] ?? NO_EVENT;
    if (slot === NO_EVENT) return;
    this.#scheduler.cancel(slot);
    this.#rows[cell] = NO_EVENT;
  }
}

/** Rows for `capacity` agents, those from `from` on standing at the origin without an arrival. */
function standingRows(capacity: number, from: number): Float64Array {
  const rows = new Float64Array(capacity * ROW_WIDTH);
  for (let cell = from * ROW_WIDTH + ARRIVAL_SLOT; cell < rows.length; cell += ROW_WIDTH) rows[cell] = NO_EVENT;
  return rows;
}
