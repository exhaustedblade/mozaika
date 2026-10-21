/**
 * The event queue as an indexed 4-ary min-heap (П-28, docs/ARCHITECTURE.md,
 * "Очередь событий на массивах").
 *
 * - The heap is two typed arrays in heap order: the time and the slot of each
 *   pending event. The children of index i are 4i + 1 … 4i + 4, so the times
 *   compared at each level lie next to each other in memory, and the heap is
 *   half as deep as a binary one.
 * - Equal times are rare in models with random delays, so the priority and
 *   seq are not copied into the heap: they are read from the records only
 *   when the times are equal.
 * - "Indexed": the heap also knows the position of every queued slot, so a
 *   cancelled event is removed at once rather than skipped when it reaches
 *   the top, and memory stays bounded by the number of pending events.
 */
import type { EventQueue } from './event-queue.js';
import type { EventRecords } from './event-records.js';
import { grown } from './typed-arrays.js';

const ARITY = 4;
/** First number of entries; the arrays double whenever they are full. */
const INITIAL_CAPACITY = 1024;
/** Position of a slot that is not in the queue, and the answer of removeFirst() on an empty queue. */
const NONE = -1;

export class FourAryHeap implements EventQueue {
  readonly #records: EventRecords;
  /** Time of the event at each heap index. */
  #times = new Float64Array(INITIAL_CAPACITY);
  /** Slot of the event at each heap index. */
  #slots = new Int32Array(INITIAL_CAPACITY);
  /** Heap index of each queued slot; NONE for slots not in the queue. */
  #positions = new Int32Array(INITIAL_CAPACITY).fill(NONE);
  #size = 0;

  constructor(records: EventRecords) {
    this.#records = records;
  }

  get size(): number {
    return this.#size;
  }

  add(slot: number, time: number): void {
    if (this.#size === this.#times.length) this.#growHeap();
    if (slot >= this.#positions.length) this.#growPositions(slot);
    this.#siftUp(this.#size++, slot, time);
  }

  remove(slot: number): void {
    const index = this.#positions[slot] ?? NONE;
    if (index === NONE) throw new Error(`FourAryHeap: slot ${String(slot)} is not in the queue`);
    this.#positions[slot] = NONE;
    const lastIndex = --this.#size;
    if (index === lastIndex) return;
    // The last entry fills the hole and moves up or down to its place.
    const time = this.#timeAt(lastIndex);
    const last = this.#slotAt(lastIndex);
    const parent = (index - 1) >> 2;
    if (index > 0 && this.#before(time, last, this.#timeAt(parent), this.#slotAt(parent))) {
      this.#siftUp(index, last, time);
    } else {
      this.#siftDown(index, last, time);
    }
  }

  firstTime(): number {
    return this.#size === 0 ? Infinity : this.#timeAt(0);
  }

  /**
   * Removes the top "bottom-up": the hole left at the top sinks to a leaf
   * along the earlier child at each level, then the last entry is put in the
   * hole and sifted up. The last entry is a late event that belongs near the
   * bottom anyway, so this saves the comparison with it at every level of
   * the way down (Wegener, "Bottom-up heapsort", 1993).
   */
  removeFirst(): number {
    if (this.#size === 0) return NONE;
    const first = this.#slotAt(0);
    this.#positions[first] = NONE;
    const lastIndex = --this.#size;
    if (lastIndex > 0) {
      const hole = this.#sinkHoleToLeaf(0);
      this.#siftUp(hole, this.#slotAt(lastIndex), this.#timeAt(lastIndex));
    }
    return first;
  }

  /** True if the event (timeA, slotA) fires before the event (timeB, slotB): the rule of П-8. */
  #before(timeA: number, slotA: number, timeB: number, slotB: number): boolean {
    if (timeA !== timeB) return timeA < timeB;
    const records = this.#records;
    const priorityA = records.priority(slotA);
    const priorityB = records.priority(slotB);
    if (priorityA !== priorityB) return priorityA < priorityB;
    return records.seq(slotA) < records.seq(slotB);
  }

  /** Moves the hole at `index` up past every parent that fires after (slot, time), then puts the entry there. */
  #siftUp(index: number, slot: number, time: number): void {
    let hole = index;
    while (hole > 0) {
      const parent = (hole - 1) >> 2;
      const parentTime = this.#timeAt(parent);
      // Most new events are later than their parent, and their times differ: decide by time alone first.
      if (time > parentTime) break;
      if (!this.#before(time, slot, parentTime, this.#slotAt(parent))) break;
      this.#move(parent, hole);
      hole = parent;
    }
    this.#place(hole, slot, time);
  }

  /** Moves the hole at `index` down past every child that fires before (slot, time), then puts the entry there. */
  #siftDown(index: number, slot: number, time: number): void {
    let hole = index;
    for (;;) {
      const child = this.#earliestChild(hole);
      if (child === NONE || !this.#before(this.#timeAt(child), this.#slotAt(child), time, slot)) break;
      this.#move(child, hole);
      hole = child;
    }
    this.#place(hole, slot, time);
  }

  /** Moves the hole at `index` down to a leaf, pulling the earliest child up at each level; returns the leaf. */
  #sinkHoleToLeaf(index: number): number {
    let hole = index;
    for (let child = this.#earliestChild(hole); child !== NONE; child = this.#earliestChild(hole)) {
      this.#move(child, hole);
      hole = child;
    }
    return hole;
  }

  /** Index of the child of `parent` that fires first; NONE for a leaf. */
  #earliestChild(parent: number): number {
    const first = ARITY * parent + 1;
    if (first >= this.#size) return NONE;
    const end = Math.min(first + ARITY, this.#size);
    let earliest = first;
    let earliestTime = this.#timeAt(first);
    for (let child = first + 1; child < end; child++) {
      const time = this.#timeAt(child);
      const earlier =
        time === earliestTime
          ? this.#before(time, this.#slotAt(child), earliestTime, this.#slotAt(earliest))
          : time < earliestTime;
      if (earlier) {
        earliest = child;
        earliestTime = time;
      }
    }
    return earliest;
  }

  #move(from: number, to: number): void {
    this.#place(to, this.#slotAt(from), this.#timeAt(from));
  }

  #place(index: number, slot: number, time: number): void {
    this.#times[index] = time;
    this.#slots[index] = slot;
    this.#positions[slot] = index;
  }

  #timeAt(index: number): number {
    return this.#times[index] ?? Infinity;
  }

  #slotAt(index: number): number {
    return this.#slots[index] ?? NONE;
  }

  #growHeap(): void {
    const capacity = this.#times.length * 2;
    this.#times = grown(this.#times, new Float64Array(capacity));
    this.#slots = grown(this.#slots, new Int32Array(capacity));
  }

  /** Makes room in the positions for slots up to `slot`. */
  #growPositions(slot: number): void {
    let capacity = this.#positions.length * 2;
    while (capacity <= slot) capacity *= 2;
    const positions = new Int32Array(capacity).fill(NONE);
    this.#positions = grown(this.#positions, positions);
  }
}
