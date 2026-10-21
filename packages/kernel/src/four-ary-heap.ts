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

  get byteLength(): number {
    return this.#times.byteLength + this.#slots.byteLength + this.#positions.byteLength;
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
    const time = this.#times[lastIndex] ?? Infinity;
    const last = this.#slots[lastIndex] ?? NONE;
    const parent = (index - 1) >> 2;
    if (index > 0 && this.#before(time, last, this.#times[parent] ?? Infinity, this.#slots[parent] ?? NONE)) {
      this.#siftUp(index, last, time);
    } else {
      this.#siftDown(index, last, time);
    }
  }

  firstTime(): number {
    return this.#size === 0 ? Infinity : (this.#times[0] ?? Infinity);
  }

  /**
   * Removes the top "bottom-up": the hole left at the top sinks to a leaf
   * along the earliest child at each level, then the last entry is put in
   * the hole and sifted up. The last entry is a late event that belongs near
   * the bottom anyway, so this saves the comparison with it at every level
   * of the way down (Wegener, "Bottom-up heapsort", 1993).
   *
   * The loops here and in the sifts read the arrays through local variables
   * rather than small accessor methods: they run on every event, and the
   * accessors cost a quarter of the speed on queues that fit in the cache.
   */
  removeFirst(): number {
    if (this.#size === 0) return NONE;
    const times = this.#times;
    const slots = this.#slots;
    const positions = this.#positions;
    const first = slots[0] ?? NONE;
    positions[first] = NONE;
    const size = --this.#size;
    if (size === 0) return first;
    let hole = 0;
    for (let child = this.#earliestChild(hole); child !== NONE; child = this.#earliestChild(hole)) {
      const moved = slots[child] ?? NONE;
      times[hole] = times[child] ?? Infinity;
      slots[hole] = moved;
      positions[moved] = hole;
      hole = child;
    }
    // The last entry, now outside the heap, goes into the hole at the leaf.
    this.#siftUp(hole, slots[size] ?? NONE, times[size] ?? Infinity);
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
    const times = this.#times;
    const slots = this.#slots;
    const positions = this.#positions;
    let hole = index;
    while (hole > 0) {
      const parent = (hole - 1) >> 2;
      const parentTime = times[parent] ?? Infinity;
      const parentSlot = slots[parent] ?? NONE;
      // Most new events are later than their parent: the time alone decides, without reading the records.
      if (time > parentTime || !this.#before(time, slot, parentTime, parentSlot)) break;
      times[hole] = parentTime;
      slots[hole] = parentSlot;
      positions[parentSlot] = hole;
      hole = parent;
    }
    times[hole] = time;
    slots[hole] = slot;
    positions[slot] = hole;
  }

  /** Moves the hole at `index` down past every child that fires before (slot, time), then puts the entry there. */
  #siftDown(index: number, slot: number, time: number): void {
    const times = this.#times;
    const slots = this.#slots;
    const positions = this.#positions;
    let hole = index;
    for (let child = this.#earliestChild(hole); child !== NONE; child = this.#earliestChild(hole)) {
      const childTime = times[child] ?? Infinity;
      const childSlot = slots[child] ?? NONE;
      if (!this.#before(childTime, childSlot, time, slot)) break;
      times[hole] = childTime;
      slots[hole] = childSlot;
      positions[childSlot] = hole;
      hole = child;
    }
    times[hole] = time;
    slots[hole] = slot;
    positions[slot] = hole;
  }

  /** Index of the child of `parent` that fires first; NONE for a leaf. */
  #earliestChild(parent: number): number {
    const first = ARITY * parent + 1;
    const size = this.#size;
    if (first >= size) return NONE;
    const times = this.#times;
    const end = Math.min(first + ARITY, size);
    let earliest = first;
    let earliestTime = times[first] ?? Infinity;
    for (let child = first + 1; child < end; child++) {
      const time = times[child] ?? Infinity;
      if (time < earliestTime || (time === earliestTime && this.#tieBefore(child, earliest))) {
        earliest = child;
        earliestTime = time;
      }
    }
    return earliest;
  }

  /** For two heap entries of equal time: true if the one at index `a` fires before the one at `b`. */
  #tieBefore(a: number, b: number): boolean {
    const time = this.#times[a] ?? Infinity;
    return this.#before(time, this.#slots[a] ?? NONE, time, this.#slots[b] ?? NONE);
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
