/**
 * Events of schedule() and scheduleAt(): a function of the model fired once at
 * its time, unless cancelled through its handle. The function and the label
 * wait in a table of this kind, so the record of the event holds only numbers.
 */
import { eventFailure } from './errors.js';
import type { EventHandle } from './event-queue.js';
import type { EventKindHandler, Scheduler } from './scheduler.js';
import { SlotPool } from './slot-pool.js';

export class ModelEvents implements EventKindHandler {
  readonly #scheduler: Scheduler;
  readonly #kind: number;
  /** Rows of the table; an event carries its row as `data`. */
  readonly #rows = new SlotPool();
  readonly #actions: ((() => void) | undefined)[] = [];
  readonly #labels: (string | undefined)[] = [];

  constructor(scheduler: Scheduler) {
    this.#scheduler = scheduler;
    this.#kind = scheduler.registerKind(this);
  }

  /** Schedules `action` at `time`, both checked by the caller, and returns the event's handle. */
  schedule(time: number, priority: number, label: string | undefined, action: () => void): EventHandle {
    const row = this.#rows.take();
    this.#actions[row] = action;
    this.#labels[row] = label;
    const slot = this.#scheduler.add(time, priority, this.#kind, 0, row);
    return new ScheduledEvent(this.#scheduler, slot, time, priority, label);
  }

  fire(_target: number, row: number): void {
    const action = this.#actions[row];
    const label = this.#labels[row];
    this.#release(row);
    if (action === undefined) throw new Error(`ModelEvents: row ${String(row)} holds no action`);
    try {
      action();
    } catch (error) {
      throw eventFailure(label, this.#scheduler.now, error);
    }
  }

  label(_target: number, row: number): string | undefined {
    return this.#labels[row];
  }

  cancelled(_target: number, row: number): void {
    this.#release(row);
  }

  #release(row: number): void {
    this.#actions[row] = undefined;
    this.#labels[row] = undefined;
    this.#rows.release(row);
  }
}

/**
 * The handle of a scheduled event. It remembers the slot of its event and the
 * slot's generation: once the event has fired or been cancelled, the
 * generation changes, so the handle is no longer pending and cannot cancel a
 * later event that reuses the slot. What it describes is copied, so it stays
 * readable after the event.
 */
class ScheduledEvent implements EventHandle {
  readonly time: number;
  readonly priority: number;
  readonly seq: number;
  readonly label: string | undefined;
  readonly #scheduler: Scheduler;
  readonly #slot: number;
  readonly #generation: number;

  constructor(scheduler: Scheduler, slot: number, time: number, priority: number, label: string | undefined) {
    this.time = time;
    this.priority = priority;
    this.seq = scheduler.seq(slot);
    this.label = label;
    this.#scheduler = scheduler;
    this.#slot = slot;
    this.#generation = scheduler.generation(slot);
  }

  get pending(): boolean {
    return this.#scheduler.generation(this.#slot) === this.#generation;
  }

  cancel(): boolean {
    if (!this.pending) return false;
    this.#scheduler.cancel(this.#slot);
    return true;
  }
}
