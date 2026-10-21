/**
 * The pending event set: what the kernel shows of an event, and the interface
 * of the queue that decides which event fires next.
 *
 * Order of events — the rule for simultaneous events (П-8):
 *   1. An earlier time fires first.
 *   2. At equal times, the smaller priority fires first. The default is 0;
 *      negative priorities fire before it, positive ones after it.
 *   3. At equal time and priority, the event scheduled first fires first.
 *      `seq` counts scheduled events, so this is first-in, first-out.
 *
 * `seq` is unique, so the key (time, priority, seq) is a strict total order:
 * the firing order never depends on how the queue is built, only on what was
 * scheduled and when.
 */

export const DEFAULT_PRIORITY = 0;

/** What every event exposes about itself, e.g. to a trace. */
export interface EventInfo {
  /** Model time at which the event fires. */
  readonly time: number;
  /** Tie-breaker for events at the same time: smaller fires first. */
  readonly priority: number;
  /** Scheduling order, unique within a simulation: the final tie-breaker. */
  readonly seq: number;
  /** Optional name for traces and error messages. */
  readonly label: string | undefined;
}

/** A scheduled event as seen by the code that scheduled it. */
export interface EventHandle extends EventInfo {
  /** True until the event fires or is cancelled. */
  readonly pending: boolean;
  /** Cancels the event unless it has already fired; returns whether it did. */
  cancel(): boolean;
}

/**
 * The order in which pending events fire. The queue holds the slots of the
 * events (event-records.ts) with their times, and reads the priority and seq
 * of a slot from the records when times are equal.
 *
 * The records, the kinds of events and their handlers do not depend on how
 * the queue is built, so the 4-ary heap (four-ary-heap.ts) can be replaced,
 * e.g. by a ladder queue (Tang et al., 2005), without touching the rest (П-28).
 */
export interface EventQueue {
  /** Number of pending events. */
  readonly size: number;
  /** Adds the event of `slot`, due at `time`. */
  add(slot: number, time: number): void;
  /** Removes a pending event that has not fired yet: a cancellation. */
  remove(slot: number): void;
  /** Time of the next event to fire; Infinity if there is none. */
  firstTime(): number;
  /** Takes the next event out of the queue and returns its slot; -1 if there is none. */
  removeFirst(): number;
}
