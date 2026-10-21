/**
 * Snapshots: the model state captured at a fixed step of model time, as plain
 * data that survives JSON serialisation (and so postMessage from a Web Worker).
 *
 * A snapshot at time T shows the state after every event with time ≤ T,
 * matching the usual convention that a sample path is right-continuous: an
 * arrival at T is already counted at T. Snapshots are taken by the run loop
 * between events and never add events of their own, so recording them does not
 * change the model run.
 */

import { requireFinite, requireFunction, requirePositive, SimulationError } from './errors.js';

/** Data that JSON represents exactly. Use type aliases, not interfaces, to describe it. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface Snapshot<T extends JsonValue = JsonValue> {
  /** Model time the snapshot describes. */
  readonly time: number;
  readonly data: T;
}

export interface SnapshotOptions<T extends JsonValue> {
  /** Model time between snapshots; must be positive. */
  readonly every: number;
  /** Time of the first snapshot; default: the current model time. */
  readonly start?: number;
  /**
   * Builds the snapshot data. While it runs, the clock shows the snapshot time.
   * It must return fresh data (not live model objects that change later) and
   * must not change the model.
   */
  readonly capture: (time: number) => T;
}

export interface SnapshotRecorder<T extends JsonValue = JsonValue> {
  readonly every: number;
  readonly start: number;
  /** Returns the snapshots taken since the last call and forgets them. */
  take(): Snapshot<T>[];
  /** Stops taking snapshots; the ones already taken can still be taken out. */
  stop(): void;
}

/** A recorder together with what the run loop needs to drive it. */
export class SnapshotSchedule<T extends JsonValue> implements SnapshotRecorder<T> {
  readonly every: number;
  readonly start: number;
  readonly #capture: (time: number) => T;
  #taken: Snapshot<T>[] = [];
  #count = 0;
  #stopped = false;

  constructor(options: SnapshotOptions<T>, now: number) {
    this.every = requirePositive(options.every, 'recordSnapshots() every');
    this.start = requireFinite(options.start ?? now, 'recordSnapshots() start');
    this.#capture = requireFunction(options.capture, 'recordSnapshots() capture');
    if (this.start < now) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `recordSnapshots() start ${String(this.start)} is in the past: the clock is already at ${String(now)}`,
      );
    }
  }

  /**
   * Time of the next snapshot, or Infinity once stopped. The k-th snapshot is
   * at start + k·every, so rounding errors do not accumulate.
   */
  get nextTime(): number {
    return this.#stopped ? Infinity : this.start + this.#count * this.every;
  }

  /** Takes the snapshot due at `nextTime`; the run loop has set the clock to it. */
  captureNext(): void {
    const time = this.nextTime;
    this.#taken.push({ time, data: this.#capture(time) });
    this.#count++;
  }

  take(): Snapshot<T>[] {
    const taken = this.#taken;
    this.#taken = [];
    return taken;
  }

  stop(): void {
    this.#stopped = true;
  }
}
