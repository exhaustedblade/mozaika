/**
 * The pending event set: a binary min-heap ordered by the key (time, priority, seq).
 *
 * Order of events — the rule for simultaneous events:
 *   1. An earlier time fires first.
 *   2. At equal times, the smaller priority fires first. The default is 0;
 *      negative priorities fire before it, positive ones after it.
 *   3. At equal time and priority, the event scheduled first fires first.
 *      `seq` counts scheduled events, so this is first-in, first-out.
 *
 * `seq` is unique, so the key is a strict total order: the firing order never
 * depends on the layout of the heap, only on what was scheduled and when.
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

type EventState = 'pending' | 'fired' | 'cancelled';

/** The queue's record of an event. Outside the kernel it is seen only as an EventHandle. */
export class ScheduledEvent implements EventHandle {
  readonly time: number;
  readonly priority: number;
  readonly seq: number;
  readonly label: string | undefined;
  readonly action: () => void;
  /** Changed only by the queue. */
  state: EventState = 'pending';
  readonly #queue: EventQueue;

  constructor(
    queue: EventQueue,
    time: number,
    priority: number,
    seq: number,
    label: string | undefined,
    action: () => void,
  ) {
    this.#queue = queue;
    this.time = time;
    this.priority = priority;
    this.seq = seq;
    this.label = label;
    this.action = action;
  }

  get pending(): boolean {
    return this.state === 'pending';
  }

  cancel(): boolean {
    return this.#queue.cancel(this);
  }
}

/** True if `a` fires before `b`. */
function precedes(a: EventInfo, b: EventInfo): boolean {
  if (a.time !== b.time) return a.time < b.time;
  if (a.priority !== b.priority) return a.priority < b.priority;
  return a.seq < b.seq;
}

/**
 * Cancelled events stay in the heap and are skipped when they reach the top.
 * When at least this many are cancelled and they outnumber the pending ones,
 * the heap is rebuilt without them, so cancelled events do not pile up in memory.
 */
const COMPACTION_THRESHOLD = 1024;

export class EventQueue {
  #heap: ScheduledEvent[] = [];
  #nextSeq = 0;
  #cancelledInHeap = 0;

  /** Number of pending (not cancelled) events. */
  get size(): number {
    return this.#heap.length - this.#cancelledInHeap;
  }

  /** Schedules an event. Arguments must already be validated by the caller. */
  add(time: number, priority: number, label: string | undefined, action: () => void): ScheduledEvent {
    const event = new ScheduledEvent(this, time, priority, this.#nextSeq++, label, action);
    this.#heap.push(event);
    this.#siftUp(this.#heap.length - 1);
    return event;
  }

  /** The next event to fire, without removing it. */
  peek(): ScheduledEvent | undefined {
    this.#discardCancelledTop();
    return this.#heap[0];
  }

  /**
   * Removes the next event and marks it fired. Returns undefined, removing
   * nothing, if the queue is empty or the next event is later than `until`.
   */
  pop(until = Infinity): ScheduledEvent | undefined {
    const next = this.peek();
    if (next === undefined || next.time > until) return undefined;
    this.#removeTop();
    next.state = 'fired';
    return next;
  }

  /** Cancels a pending event; returns false if it has already fired or been cancelled. */
  cancel(event: ScheduledEvent): boolean {
    if (event.state !== 'pending') return false;
    event.state = 'cancelled';
    this.#cancelledInHeap++;
    if (this.#cancelledInHeap >= COMPACTION_THRESHOLD && this.#cancelledInHeap > this.size) {
      this.#removeCancelled();
    }
    return true;
  }

  /** Removes cancelled events from the top, so that the top is the next event to fire. */
  #discardCancelledTop(): void {
    while (this.#heap[0]?.state === 'cancelled') {
      this.#removeTop();
      this.#cancelledInHeap--;
    }
  }

  #removeTop(): ScheduledEvent | undefined {
    const heap = this.#heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last;
      this.#siftDown(0);
    }
    return top;
  }

  #removeCancelled(): void {
    this.#heap = this.#heap.filter((event) => event.state === 'pending');
    this.#cancelledInHeap = 0;
    // Floyd's heap construction: sift down every parent, last one first.
    for (let index = (this.#heap.length >> 1) - 1; index >= 0; index--) {
      this.#siftDown(index);
    }
  }

  /** Moves the event at `index` up until its parent fires before it. */
  #siftUp(index: number): void {
    const heap = this.#heap;
    const event = heap[index];
    if (event === undefined) return;
    let hole = index;
    while (hole > 0) {
      const parentIndex = (hole - 1) >> 1;
      const parent = heap[parentIndex];
      // `parent` is always defined here; the check only satisfies the type checker.
      if (parent === undefined || !precedes(event, parent)) break;
      heap[hole] = parent;
      hole = parentIndex;
    }
    heap[hole] = event;
  }

  /** Moves the event at `index` down until it fires before both children. */
  #siftDown(index: number): void {
    const heap = this.#heap;
    const event = heap[index];
    if (event === undefined) return;
    let hole = index;
    for (;;) {
      const leftIndex = 2 * hole + 1;
      const left = heap[leftIndex];
      if (left === undefined) break; // no children
      let child = left;
      let childIndex = leftIndex;
      const right = heap[leftIndex + 1];
      if (right !== undefined && precedes(right, left)) {
        child = right;
        childIndex = leftIndex + 1;
      }
      if (!precedes(child, event)) break;
      heap[hole] = child;
      hole = childIndex;
    }
    heap[hole] = event;
  }
}
