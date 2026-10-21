/**
 * Records of the scheduled events (docs/ARCHITECTURE.md, "Очередь событий на
 * массивах"): each pending event has a slot, and its fields are kept in
 * columns of typed arrays rather than in an object per event. The time of an
 * event is not here: the queue keeps it next to the slot, because the queue
 * compares times far more often than anything else.
 */
import { SlotPool } from './slot-pool.js';
import { grown } from './typed-arrays.js';

/** First number of rows; the columns double whenever they are full. */
const INITIAL_CAPACITY = 1024;

export class EventRecords {
  /** Tie-breaker at equal times: smaller fires first (П-8). */
  #priorities = new Float64Array(INITIAL_CAPACITY);
  /** Scheduling order, the final tie-breaker. A double: a long run can schedule more than 2³² events. */
  #seqs = new Float64Array(INITIAL_CAPACITY);
  /** Number of the event kind, which says what firing the event does (scheduler.ts). */
  #kinds = new Uint16Array(INITIAL_CAPACITY);
  /** What the event acts on, e.g. the place of an agent in its population; the kind decides. */
  #targets = new Int32Array(INITIAL_CAPACITY);
  /** What else the kind needs, e.g. the number of a timer or the row of a table. */
  #data = new Int32Array(INITIAL_CAPACITY);
  /**
   * Grows by one each time the slot is freed. A handle remembers the
   * generation of its event, so it never mistakes a later event in the same
   * slot for its own. It wraps around after 2³² reuses of one slot.
   */
  #generations = new Uint32Array(INITIAL_CAPACITY);
  readonly #slots = new SlotPool();

  /** Takes a free slot for an event and fills in its fields. */
  allocate(priority: number, seq: number, kind: number, target: number, data: number): number {
    const slot = this.#slots.take();
    if (slot === this.#kinds.length) this.#grow();
    this.#priorities[slot] = priority;
    this.#seqs[slot] = seq;
    this.#kinds[slot] = kind;
    this.#targets[slot] = target;
    this.#data[slot] = data;
    return slot;
  }

  /** Frees the slot of an event that has fired or been cancelled. */
  free(slot: number): void {
    this.#generations[slot] = (this.#generations[slot] ?? 0) + 1;
    this.#slots.release(slot);
  }

  priority(slot: number): number {
    return this.#priorities[slot] ?? Number.NaN;
  }

  seq(slot: number): number {
    return this.#seqs[slot] ?? Number.NaN;
  }

  kind(slot: number): number {
    return this.#kinds[slot] ?? -1;
  }

  target(slot: number): number {
    return this.#targets[slot] ?? -1;
  }

  data(slot: number): number {
    return this.#data[slot] ?? -1;
  }

  generation(slot: number): number {
    return this.#generations[slot] ?? -1;
  }

  /** Points a pending event at another target, e.g. an agent that has moved in its population. */
  setTarget(slot: number, target: number): void {
    this.#targets[slot] = target;
  }

  #grow(): void {
    const capacity = this.#kinds.length * 2;
    this.#priorities = grown(this.#priorities, new Float64Array(capacity));
    this.#seqs = grown(this.#seqs, new Float64Array(capacity));
    this.#kinds = grown(this.#kinds, new Uint16Array(capacity));
    this.#targets = grown(this.#targets, new Int32Array(capacity));
    this.#data = grown(this.#data, new Int32Array(capacity));
    this.#generations = grown(this.#generations, new Uint32Array(capacity));
  }
}
