/**
 * The event queue as a ladder queue: W. T. Tang, R. S. M. Goh, I. L.-J. Thng,
 * "Ladder Queue: An O(1) priority queue structure for large-scale discrete
 * event simulation", ACM TOMACS 15(3), 2005. The design and why it keeps the
 * order of П-8: docs/ARCHITECTURE.md, "«Лестничная» очередь".
 *
 * Events far ahead are not sorted, only sorted into buckets of time; a bucket
 * is sorted when its turn comes. Three tiers, from late to early:
 *
 * - Top: an unsorted list of the events later than `#topAfter`.
 * - Rungs, at most MAX_RUNGS: each splits a range of time into buckets of
 *   equal width and is taken bucket by bucket. A bucket is a doubly linked
 *   list of slots. The first rung is made of the whole Top; a bucket with
 *   more than SPLIT_THRESHOLD events becomes a rung of its own below.
 * - Bottom: the earliest events, sorted by the full key (time, priority, seq).
 *
 * Which tier, rung and bucket take an event is decided by its time alone,
 * through bucket numbers that never decrease as time grows. So events of
 * equal time always share a place, everything higher up the ladder is later
 * than everything lower down, and sorting the Bottom by the full key gives
 * the order of П-8.
 */
import type { EventQueue } from './event-queue.js';
import type { EventRecords } from './event-records.js';
import { grown } from './typed-arrays.js';

/** A bucket or Bottom with more events than this is split into a new rung (THRES of the paper). */
const SPLIT_THRESHOLD = 50;
/** Most rungs at once, as in the paper: it stops endless splitting of events too close to tell apart. */
const MAX_RUNGS = 8;
/**
 * Events per bucket, on average, of a new rung. The paper has one; four were
 * as fast or faster in every benchmark and take a quarter of the buckets'
 * memory (П-48).
 */
const EVENTS_PER_BUCKET = 4;
/** Shorter runs are sorted by insertion, longer ones by merging. */
const INSERTION_SORT_LIMIT = 24;
const INITIAL_CAPACITY = 1024;

/**
 * Each slot has a row of 16 bytes: its time as a Float64, then two Int32,
 * NEXT and PREVIOUS. Moving an event between tiers reads and writes its row
 * only, one cache line, where separate columns would touch three.
 */
const ROW_BYTES = 16;
const FLOATS_PER_ROW = ROW_BYTES / Float64Array.BYTES_PER_ELEMENT;
const INTS_PER_ROW = ROW_BYTES / Int32Array.BYTES_PER_ELEMENT;
/** In a bucket: the next slot of the list. In Top: the event's index there. */
const NEXT = 2;
/** In a bucket: the previous slot of the list. Out of the rungs: where the event is (below). */
const PREVIOUS = 3;

/** No slot: the end of a list, an empty bucket, or the answer of removeFirst() on an empty queue. */
const NONE = -1;
/** Places of an event out of the rungs, kept in PREVIOUS: they are below every slot number. */
const IN_TOP = -2;
const IN_BOTTOM = -3;
const NOT_QUEUED = -4;

export class LadderQueue implements EventQueue {
  readonly #records: EventRecords;
  #size = 0;

  // Rows of the slots: two views of one buffer.
  #rowTimes: Float64Array;
  #rowLinks: Int32Array;

  // Top: slots in no order, all later than #topAfter, with the least and greatest of their times.
  #topSlots = new Int32Array(INITIAL_CAPACITY);
  #topSize = 0;
  #topMin = Infinity;
  #topMax = -Infinity;
  /**
   * The latest time that went below Top: later events go to Top. -Infinity
   * at first, so that events added before the first one is taken wait in Top
   * and make one rung together. +Infinity while the whole queue fits in the
   * Bottom (#moveTopDown).
   */
  #topAfter = -Infinity;

  // Rungs, from the top: bucket number of a time t is ⌊(t − start)·scale⌋, clipped to [0, count − 1].
  readonly #rungStart = new Float64Array(MAX_RUNGS);
  readonly #rungScale = new Float64Array(MAX_RUNGS);
  /** Where the rung's buckets begin in #bucketHeads and #bucketTails: a lower rung lies after a higher one. */
  readonly #rungFirstBucket = new Int32Array(MAX_RUNGS);
  readonly #rungBucketCount = new Int32Array(MAX_RUNGS);
  /** The next bucket to take: buckets before it have gone down already. */
  readonly #rungCurrent = new Int32Array(MAX_RUNGS);
  #rungCount = 0;
  #bucketHeads = new Int32Array(INITIAL_CAPACITY);
  #bucketTails = new Int32Array(INITIAL_CAPACITY);

  // Bottom: events [#bottomStart, #bottomEnd) sorted by key; a fired event leaves room before the first.
  #bottomTimes = new Float64Array(INITIAL_CAPACITY);
  #bottomSlots = new Int32Array(INITIAL_CAPACITY);
  #bottomStart = 0;
  #bottomEnd = 0;

  // Room for the merge sort of a long Bottom, kept so that sorting does not allocate.
  #scratchTimes = new Float64Array(0);
  #scratchSlots = new Int32Array(0);

  constructor(records: EventRecords) {
    this.#records = records;
    const buffer = new ArrayBuffer(INITIAL_CAPACITY * ROW_BYTES);
    this.#rowTimes = new Float64Array(buffer);
    this.#rowLinks = new Int32Array(buffer);
    markNotQueued(this.#rowLinks, 0, INITIAL_CAPACITY);
  }

  get size(): number {
    return this.#size;
  }

  get byteLength(): number {
    return (
      this.#rowTimes.byteLength +
      this.#topSlots.byteLength +
      this.#bucketHeads.byteLength +
      this.#bucketTails.byteLength +
      this.#bottomTimes.byteLength +
      this.#bottomSlots.byteLength +
      this.#scratchTimes.byteLength +
      this.#scratchSlots.byteLength
    );
  }

  add(slot: number, time: number): void {
    if (FLOATS_PER_ROW * slot >= this.#rowTimes.length) this.#growRows(slot);
    this.#rowTimes[FLOATS_PER_ROW * slot] = time;
    this.#size++;
    if (time > this.#topAfter) this.#pushTop(slot, time);
    else if (this.#rungCount === 0) this.#insertBottom(slot, time);
    else this.#addBelowTop(slot, time);
  }

  remove(slot: number): void {
    const links = this.#rowLinks;
    const previous = links[INTS_PER_ROW * slot + PREVIOUS] ?? NOT_QUEUED;
    if (previous === NOT_QUEUED) throw new Error(`LadderQueue: slot ${String(slot)} is not in the queue`);
    this.#size--;
    if (previous === IN_TOP) this.#removeFromTop(links[INTS_PER_ROW * slot + NEXT] ?? NONE);
    else if (previous === IN_BOTTOM) this.#removeFromBottom(slot);
    else this.#unlink(slot, previous);
    links[INTS_PER_ROW * slot + PREVIOUS] = NOT_QUEUED;
  }

  firstTime(): number {
    if (this.#bottomStart === this.#bottomEnd) {
      if (this.#size === 0) return Infinity;
      this.#fillBottom();
    }
    return this.#bottomTimes[this.#bottomStart] ?? Infinity;
  }

  removeFirst(): number {
    if (this.#bottomStart === this.#bottomEnd) {
      if (this.#size === 0) return NONE;
      this.#fillBottom();
    }
    const slot = this.#bottomSlots[this.#bottomStart++] ?? NONE;
    if (this.#bottomStart === this.#bottomEnd) this.#bottomStart = this.#bottomEnd = 0;
    this.#rowLinks[INTS_PER_ROW * slot + PREVIOUS] = NOT_QUEUED;
    this.#size--;
    return slot;
  }

  // ---- Top

  #pushTop(slot: number, time: number): void {
    const index = this.#topSize++;
    if (index === this.#topSlots.length) this.#topSlots = grown(this.#topSlots, new Int32Array(2 * index));
    this.#topSlots[index] = slot;
    if (time < this.#topMin) this.#topMin = time;
    if (time > this.#topMax) this.#topMax = time;
    const links = this.#rowLinks;
    links[INTS_PER_ROW * slot + NEXT] = index;
    links[INTS_PER_ROW * slot + PREVIOUS] = IN_TOP;
  }

  /**
   * The last event of Top takes the place of the removed one. The least and
   * greatest times stay as they were: they still bound the times of Top, and
   * a rung over a slightly wider range is as correct.
   */
  #removeFromTop(index: number): void {
    const last = --this.#topSize;
    if (index === last) return;
    const moved = this.#topSlots[last] ?? NONE;
    this.#topSlots[index] = moved;
    this.#rowLinks[INTS_PER_ROW * moved + NEXT] = index;
  }

  /**
   * Moves the whole Top down, when the ladder is empty: into a first rung, or
   * straight into the Bottom if Top cannot be split. A Top of a few events
   * means a small queue: it then lives in the Bottom alone (#topAfter is
   * +Infinity) until it outgrows it, which saves moving every event through
   * Top in queues like M/M/1 with two or three events.
   */
  #moveTopDown(): void {
    const count = this.#topSize;
    const min = this.#topMin;
    const max = this.#topMax;
    this.#topSize = 0;
    this.#topMin = Infinity;
    this.#topMax = -Infinity;
    if (this.#canSplit(count, min, max)) {
      this.#topAfter = max;
      this.#addRung(count, min, max, this.#topSlots, 0);
      return;
    }
    this.#topAfter = count <= SPLIT_THRESHOLD ? Infinity : max;
    this.#ensureBottom(count);
    const topSlots = this.#topSlots;
    const bottomTimes = this.#bottomTimes;
    const bottomSlots = this.#bottomSlots;
    const times = this.#rowTimes;
    const links = this.#rowLinks;
    for (let i = 0; i < count; i++) {
      const slot = topSlots[i] ?? NONE;
      bottomTimes[i] = times[FLOATS_PER_ROW * slot] ?? 0;
      bottomSlots[i] = slot;
      links[INTS_PER_ROW * slot + PREVIOUS] = IN_BOTTOM;
    }
    this.#bottomStart = 0;
    this.#bottomEnd = count;
    this.#sortBottom();
  }

  // ---- Rungs

  /** Adds an event earlier than Top while there are rungs: to its bucket, or to the Bottom. */
  #addBelowTop(slot: number, time: number): void {
    const bucket = this.#bucketFor(time);
    if (bucket === NONE) this.#insertBottom(slot, time);
    else this.#link(slot, bucket);
  }

  /**
   * The bucket that takes an event at `time`: on the first rung from the top
   * whose bucket for this time has not been taken yet. NONE if every rung has
   * taken it already: the event belongs to the Bottom.
   */
  #bucketFor(time: number): number {
    const rungs = this.#rungCount;
    for (let rung = 0; rung < rungs; rung++) {
      const last = (this.#rungBucketCount[rung] ?? 0) - 1;
      let index = Math.floor((time - (this.#rungStart[rung] ?? 0)) * (this.#rungScale[rung] ?? 0));
      if (index < 0) index = 0;
      else if (index > last) index = last;
      if (index >= (this.#rungCurrent[rung] ?? 0)) return (this.#rungFirstBucket[rung] ?? 0) + index;
    }
    return NONE;
  }

  /** True if `count` events over [min, max] can make a new rung. */
  #canSplit(count: number, min: number, max: number): boolean {
    if (count <= SPLIT_THRESHOLD || this.#rungCount === MAX_RUNGS || !(min < max)) return false;
    // Times so close that the scale overflows cannot be told apart by buckets either.
    return bucketCountFor(count) / (max - min) < Infinity;
  }

  /**
   * Adds a rung below the others over [min, max] and links into it the
   * `count` events of `slots` from `from` on. Their bucket is chosen as in
   * #bucketFor, so that a cancellation finds it again.
   */
  #addRung(count: number, min: number, max: number, slots: Int32Array, from: number): void {
    const rung = this.#rungCount++;
    const buckets = bucketCountFor(count);
    const first = rung === 0 ? 0 : (this.#rungFirstBucket[rung - 1] ?? 0) + (this.#rungBucketCount[rung - 1] ?? 0);
    if (first + buckets > this.#bucketHeads.length) this.#growBuckets(first + buckets);
    this.#bucketHeads.fill(NONE, first, first + buckets);
    this.#bucketTails.fill(NONE, first, first + buckets);
    const scale = buckets / (max - min);
    this.#rungStart[rung] = min;
    this.#rungScale[rung] = scale;
    this.#rungFirstBucket[rung] = first;
    this.#rungBucketCount[rung] = buckets;
    this.#rungCurrent[rung] = 0;

    const times = this.#rowTimes;
    const last = buckets - 1;
    for (let i = from; i < from + count; i++) {
      const slot = slots[i] ?? NONE;
      let index = Math.floor(((times[FLOATS_PER_ROW * slot] ?? 0) - min) * scale);
      if (index < 0) index = 0;
      else if (index > last) index = last;
      this.#link(slot, first + index);
    }
  }

  /** Appends the event to a bucket: events of a bucket stay in the order they came. */
  #link(slot: number, bucket: number): void {
    const links = this.#rowLinks;
    const tail = this.#bucketTails[bucket] ?? NONE;
    links[INTS_PER_ROW * slot + NEXT] = NONE;
    links[INTS_PER_ROW * slot + PREVIOUS] = tail;
    if (tail === NONE) this.#bucketHeads[bucket] = slot;
    else links[INTS_PER_ROW * tail + NEXT] = slot;
    this.#bucketTails[bucket] = slot;
  }

  /** Cuts a cancelled event out of its bucket; the bucket itself is needed only at an end of its list. */
  #unlink(slot: number, previous: number): void {
    const links = this.#rowLinks;
    const next = links[INTS_PER_ROW * slot + NEXT] ?? NONE;
    const bucket =
      previous === NONE || next === NONE ? this.#bucketFor(this.#rowTimes[FLOATS_PER_ROW * slot] ?? 0) : NONE;
    if (previous === NONE) this.#bucketHeads[bucket] = next;
    else links[INTS_PER_ROW * previous + NEXT] = next;
    if (next === NONE) this.#bucketTails[bucket] = previous;
    else links[INTS_PER_ROW * next + PREVIOUS] = previous;
  }

  /** Takes the next non-empty bucket of a rung and returns it; NONE if the rung has none left. */
  #takeBucket(rung: number): number {
    const heads = this.#bucketHeads;
    const first = this.#rungFirstBucket[rung] ?? 0;
    const end = this.#rungBucketCount[rung] ?? 0;
    let index = this.#rungCurrent[rung] ?? 0;
    while (index < end && heads[first + index] === NONE) index++;
    this.#rungCurrent[rung] = index < end ? index + 1 : end;
    return index < end ? first + index : NONE;
  }

  // ---- Bottom

  /**
   * Fills the empty Bottom from the last rung, removing the rungs it has
   * taken, or from Top when no rungs are left. The caller knows the queue is
   * not empty, so the loop ends.
   */
  #fillBottom(): void {
    while (this.#bottomStart === this.#bottomEnd) {
      if (this.#rungCount === 0) {
        this.#moveTopDown();
        continue;
      }
      const bucket = this.#takeBucket(this.#rungCount - 1);
      if (bucket === NONE) this.#rungCount--;
      else this.#moveBucketDown(bucket);
    }
  }

  /**
   * Copies a bucket into the empty Bottom, then sorts it there, or, if it is
   * too long, links its events into a new rung below.
   */
  #moveBucketDown(bucket: number): void {
    const times = this.#rowTimes;
    const links = this.#rowLinks;
    let count = 0;
    let min = Infinity;
    let max = -Infinity;
    let bottomTimes = this.#bottomTimes;
    let bottomSlots = this.#bottomSlots;
    let slot = this.#bucketHeads[bucket] ?? NONE;
    while (slot !== NONE) {
      if (count === bottomTimes.length) {
        this.#ensureBottom(count + 1);
        bottomTimes = this.#bottomTimes;
        bottomSlots = this.#bottomSlots;
      }
      const time = times[FLOATS_PER_ROW * slot] ?? 0;
      bottomTimes[count] = time;
      bottomSlots[count++] = slot;
      links[INTS_PER_ROW * slot + PREVIOUS] = IN_BOTTOM;
      if (time < min) min = time;
      if (time > max) max = time;
      slot = links[INTS_PER_ROW * slot + NEXT] ?? NONE;
    }
    this.#bucketHeads[bucket] = NONE;
    this.#bucketTails[bucket] = NONE;
    this.#bottomStart = 0;
    this.#bottomEnd = count;
    if (this.#canSplit(count, min, max)) this.#moveBottomToRung(min, max);
    else this.#sortBottom();
  }

  /**
   * Makes the whole Bottom a new rung below the others (the paper's
   * Bottom-to-Ladder transfer): a long Bottom would make every insertion slow.
   */
  #moveBottomToRung(min: number, max: number): void {
    // A queue that lived in the Bottom alone has outgrown it: later events go to Top again.
    if (this.#topAfter === Infinity) this.#topAfter = max;
    this.#addRung(this.#bottomEnd - this.#bottomStart, min, max, this.#bottomSlots, this.#bottomStart);
    this.#bottomStart = this.#bottomEnd = 0;
  }

  /**
   * Inserts an event in its place by key. Most land after every event of the
   * Bottom, or before every one when a fired event has left room there: those
   * need no search, and this function stays small enough for V8 to inline.
   */
  #insertBottom(slot: number, time: number): void {
    this.#rowLinks[INTS_PER_ROW * slot + PREVIOUS] = IN_BOTTOM;
    const start = this.#bottomStart;
    const end = this.#bottomEnd;
    const times = this.#bottomTimes;
    if (start < end && !(time > (times[end - 1] ?? 0))) {
      if (start > 0 && time < (times[start] ?? 0)) {
        times[start - 1] = time;
        this.#bottomSlots[start - 1] = slot;
        this.#bottomStart = start - 1;
      } else {
        this.#insertBottomInside(slot, time);
      }
    } else {
      if (end === times.length) this.#ensureBottom(end + 1);
      this.#bottomTimes[end] = time;
      this.#bottomSlots[end] = slot;
      this.#bottomEnd = end + 1;
    }
    if (end - start >= SPLIT_THRESHOLD) this.#splitLongBottom();
  }

  /** Inserts an event among the events of the Bottom, moving the shorter side by one place. */
  #insertBottomInside(slot: number, time: number): void {
    const start = this.#bottomStart;
    const end = this.#bottomEnd;
    let times = this.#bottomTimes;
    let slots = this.#bottomSlots;
    // The first position whose event fires after the new one.
    let low = start;
    let high = end;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.#before(time, slot, times[middle] ?? 0, slots[middle] ?? NONE)) high = middle;
      else low = middle + 1;
    }
    if (start > 0 && low - start < end - low) {
      for (let i = start; i < low; i++) {
        times[i - 1] = times[i] ?? 0;
        slots[i - 1] = slots[i] ?? NONE;
      }
      times[low - 1] = time;
      slots[low - 1] = slot;
      this.#bottomStart = start - 1;
      return;
    }
    if (end === times.length) {
      this.#ensureBottom(end + 1);
      times = this.#bottomTimes;
      slots = this.#bottomSlots;
    }
    for (let i = end; i > low; i--) {
      times[i] = times[i - 1] ?? 0;
      slots[i] = slots[i - 1] ?? NONE;
    }
    times[low] = time;
    slots[low] = slot;
    this.#bottomEnd = end + 1;
  }

  /** Makes a Bottom grown longer than a bucket may be into a rung, unless its events are too close to split. */
  #splitLongBottom(): void {
    const min = this.#bottomTimes[this.#bottomStart] ?? 0;
    const max = this.#bottomTimes[this.#bottomEnd - 1] ?? 0;
    if (this.#canSplit(this.#bottomEnd - this.#bottomStart, min, max)) this.#moveBottomToRung(min, max);
  }

  /** Finds a cancelled event by its key and closes the gap from the shorter side. */
  #removeFromBottom(slot: number): void {
    const time = this.#rowTimes[FLOATS_PER_ROW * slot] ?? 0;
    const times = this.#bottomTimes;
    const slots = this.#bottomSlots;
    const start = this.#bottomStart;
    const end = this.#bottomEnd;
    // The first position that does not fire before the event: the event itself, as keys are unique.
    let low = start;
    let high = end;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.#before(times[middle] ?? 0, slots[middle] ?? NONE, time, slot)) low = middle + 1;
      else high = middle;
    }
    if (low - start < end - 1 - low) {
      for (let i = low; i > start; i--) {
        times[i] = times[i - 1] ?? 0;
        slots[i] = slots[i - 1] ?? NONE;
      }
      this.#bottomStart = start + 1;
    } else {
      for (let i = low; i < end - 1; i++) {
        times[i] = times[i + 1] ?? 0;
        slots[i] = slots[i + 1] ?? NONE;
      }
      this.#bottomEnd = end - 1;
    }
    if (this.#bottomStart === this.#bottomEnd) this.#bottomStart = this.#bottomEnd = 0;
  }

  #sortBottom(): void {
    const from = this.#bottomStart;
    const to = this.#bottomEnd;
    if (to - from > INSERTION_SORT_LIMIT && this.#scratchTimes.length < to) {
      this.#scratchTimes = new Float64Array(this.#bottomTimes.length);
      this.#scratchSlots = new Int32Array(this.#bottomTimes.length);
    }
    this.#mergeSort(from, to);
  }

  /**
   * Sorts the Bottom between `from` and `to` by key: halves are sorted on
   * their own and merged, unless they are in order already — as events of one
   * moment usually are, scheduled one after another — and short runs are
   * sorted by insertion.
   */
  #mergeSort(from: number, to: number): void {
    if (to - from <= INSERTION_SORT_LIMIT) {
      this.#insertionSort(from, to);
      return;
    }
    const middle = (from + to) >>> 1;
    this.#mergeSort(from, middle);
    this.#mergeSort(middle, to);
    const times = this.#bottomTimes;
    const slots = this.#bottomSlots;
    if (!this.#before(times[middle] ?? 0, slots[middle] ?? NONE, times[middle - 1] ?? 0, slots[middle - 1] ?? NONE)) {
      return;
    }
    const scratchTimes = this.#scratchTimes;
    const scratchSlots = this.#scratchSlots;
    for (let i = from; i < middle; i++) {
      scratchTimes[i] = times[i] ?? 0;
      scratchSlots[i] = slots[i] ?? NONE;
    }
    let left = from;
    let right = middle;
    let out = from;
    while (left < middle && right < to) {
      const rightTime = times[right] ?? 0;
      const rightSlot = slots[right] ?? NONE;
      if (this.#before(rightTime, rightSlot, scratchTimes[left] ?? 0, scratchSlots[left] ?? NONE)) {
        times[out] = rightTime;
        slots[out++] = rightSlot;
        right++;
      } else {
        times[out] = scratchTimes[left] ?? 0;
        slots[out++] = scratchSlots[left++] ?? NONE;
      }
    }
    // What is left of the right half is in place already.
    while (left < middle) {
      times[out] = scratchTimes[left] ?? 0;
      slots[out++] = scratchSlots[left++] ?? NONE;
    }
  }

  #insertionSort(from: number, to: number): void {
    const times = this.#bottomTimes;
    const slots = this.#bottomSlots;
    for (let i = from + 1; i < to; i++) {
      const time = times[i] ?? 0;
      const slot = slots[i] ?? NONE;
      let j = i;
      while (j > from && this.#before(time, slot, times[j - 1] ?? 0, slots[j - 1] ?? NONE)) {
        times[j] = times[j - 1] ?? 0;
        slots[j] = slots[j - 1] ?? NONE;
        j--;
      }
      times[j] = time;
      slots[j] = slot;
    }
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

  // ---- Growth: arrays double when full and never shrink, as the heap's do.

  #growRows(slot: number): void {
    const rows = this.#rowTimes.length / FLOATS_PER_ROW;
    let capacity = 2 * rows;
    while (capacity <= slot) capacity *= 2;
    const buffer = new ArrayBuffer(capacity * ROW_BYTES);
    // The Int32 view copies the rows bit for bit, times included.
    const links = grown(this.#rowLinks, new Int32Array(buffer));
    markNotQueued(links, rows, capacity);
    this.#rowTimes = new Float64Array(buffer);
    this.#rowLinks = links;
  }

  #growBuckets(count: number): void {
    let capacity = 2 * this.#bucketHeads.length;
    while (capacity < count) capacity *= 2;
    this.#bucketHeads = grown(this.#bucketHeads, new Int32Array(capacity));
    this.#bucketTails = grown(this.#bucketTails, new Int32Array(capacity));
  }

  #ensureBottom(capacity: number): void {
    let length = this.#bottomTimes.length;
    if (capacity <= length) return;
    while (length < capacity) length *= 2;
    this.#bottomTimes = grown(this.#bottomTimes, new Float64Array(length));
    this.#bottomSlots = grown(this.#bottomSlots, new Int32Array(length));
  }
}

/** Buckets of a new rung for `count` events. */
function bucketCountFor(count: number): number {
  return Math.ceil(count / EVENTS_PER_BUCKET);
}

/** Marks the rows [from, to) as not queued, so that remove() can tell. */
function markNotQueued(links: Int32Array, from: number, to: number): void {
  for (let row = from; row < to; row++) links[INTS_PER_ROW * row + PREVIOUS] = NOT_QUEUED;
}
