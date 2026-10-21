/**
 * Wake-ups: events that call a function waiting for them with a value — a
 * process going on after `yield timeout(...)` or `yield signal.wait()`, or a
 * listener of `signal.once()`. The function exists before the event (a process
 * makes its own once, when it is created), so the event needs no closure: the
 * function, the value and the label wait in a table of this kind, and the
 * record of the event holds the row.
 */
import { eventFailure } from './errors.js';
import type { EventKindHandler, Scheduler } from './scheduler.js';
import { SlotPool } from './slot-pool.js';

/** A function that waits for an event, e.g. the one that resumes a process. */
export type Listener = (value: unknown) => void;

export class WakeUps implements EventKindHandler {
  readonly #scheduler: Scheduler;
  readonly #kind: number;
  /** Rows of the table; an event carries its row as `data`. */
  readonly #rows = new SlotPool();
  readonly #listeners: (Listener | undefined)[] = [];
  readonly #values: unknown[] = [];
  readonly #labels: (string | undefined)[] = [];

  constructor(scheduler: Scheduler) {
    this.#scheduler = scheduler;
    this.#kind = scheduler.registerKind(this);
  }

  /** Calls `listener(value)` as an event at `time`; the caller has checked the time and the priority. */
  schedule(time: number, priority: number, listener: Listener, value: unknown, label: string | undefined): void {
    const row = this.#rows.take();
    this.#listeners[row] = listener;
    this.#values[row] = value;
    this.#labels[row] = label;
    this.#scheduler.add(time, priority, this.#kind, 0, row);
  }

  fire(_target: number, row: number): void {
    const listener = this.#listeners[row];
    const value = this.#values[row];
    const label = this.#labels[row];
    this.#listeners[row] = undefined;
    this.#values[row] = undefined;
    this.#labels[row] = undefined;
    this.#rows.release(row);
    if (listener === undefined) throw new Error(`WakeUps: row ${String(row)} holds no listener`);
    try {
      listener(value);
    } catch (error) {
      throw eventFailure(label, this.#scheduler.now, error);
    }
  }

  label(_target: number, row: number): string | undefined {
    return this.#labels[row];
  }
}
