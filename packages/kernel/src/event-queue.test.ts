import { describe, expect, it } from 'vitest';

import type { EventQueue } from './event-queue.js';
import { EventRecords } from './event-records.js';
import { FourAryHeap } from './four-ary-heap.js';
import { Random } from './random.js';

interface Key {
  readonly time: number;
  readonly priority: number;
  readonly seq: number;
}

/** Firing order of the kernel (П-8): time, then priority, then scheduling order. */
function byKey(a: Key, b: Key): number {
  return a.time - b.time || a.priority - b.priority || a.seq - b.seq;
}

/**
 * A queue with its records, as the scheduler drives them: every added event
 * gets a record with the next number; a label stands for the event's data.
 */
class TestQueue {
  readonly records = new EventRecords();
  readonly queue: EventQueue = new FourAryHeap(this.records);
  readonly #labels: string[] = [];
  readonly #times = new Map<number, number>();
  #nextSeq = 0;

  /** Adds an event and returns its slot. */
  add(time: number, priority: number, label = ''): number {
    const slot = this.records.allocate(priority, this.#nextSeq++, 0, 0, this.#labels.push(label) - 1);
    this.queue.add(slot, time);
    this.#times.set(slot, time);
    return slot;
  }

  cancel(slot: number): void {
    this.queue.remove(slot);
    this.records.free(slot);
  }

  /** Takes the first event out, frees its slot and returns its key; undefined if the queue is empty. */
  pop(): (Key & { label: string }) | undefined {
    if (this.queue.size === 0) return undefined;
    const time = this.queue.firstTime();
    const slot = this.queue.removeFirst();
    expect(this.#times.get(slot)).toBe(time);
    const key = {
      time,
      priority: this.records.priority(slot),
      seq: this.records.seq(slot),
      label: this.#labels[this.records.data(slot)] ?? '?',
    };
    this.records.free(slot);
    return key;
  }

  drainLabels(): string[] {
    const labels: string[] = [];
    for (let event = this.pop(); event !== undefined; event = this.pop()) labels.push(event.label);
    return labels;
  }

  drainKeys(): Key[] {
    const keys: Key[] = [];
    for (let event = this.pop(); event !== undefined; event = this.pop()) {
      keys.push({ time: event.time, priority: event.priority, seq: event.seq });
    }
    return keys;
  }
}

describe('EventQueue (indexed 4-ary heap)', () => {
  it('orders events by time, then priority, then scheduling order', () => {
    const queue = new TestQueue();
    queue.add(2, 0, 'late');
    queue.add(1, 5, 'low priority');
    queue.add(1, 0, 'first scheduled');
    queue.add(1, -1, 'urgent');
    queue.add(1, 0, 'second scheduled');
    queue.add(0.5, 9, 'earliest');

    expect(queue.drainLabels()).toEqual([
      'earliest',
      'urgent',
      'first scheduled',
      'second scheduled',
      'low priority',
      'late',
    ]);
  });

  it('reports the time of the first event, or Infinity when empty', () => {
    const queue = new TestQueue();
    expect(queue.queue.firstTime()).toBe(Infinity);
    expect(queue.queue.removeFirst()).toBe(-1);
    queue.add(3, 0);
    queue.add(1.5, 0);
    expect(queue.queue.firstTime()).toBe(1.5);
    expect(queue.queue.size).toBe(2);
  });

  it('matches a full sort by (time, priority, seq) on random input', () => {
    const random = new Random(7);
    const queue = new TestQueue();
    const expected: Key[] = [];
    for (let i = 0; i < 5_000; i++) {
      // Few distinct values, so that ties in time and priority are common.
      const time = Math.floor(random.uniform(0, 20));
      const priority = Math.floor(random.uniform(-2, 3));
      const slot = queue.add(time, priority);
      expected.push({ time, priority, seq: queue.records.seq(slot) });
    }
    expected.sort(byKey);
    expect(queue.drainKeys()).toEqual(expected);
  });

  it('matches a full sort by key on a large queue with many ties and cancellations', () => {
    const random = new Random(2026);
    const queue = new TestQueue();
    const kept: Key[] = [];
    const slots: number[] = [];
    for (let i = 0; i < 100_000; i++) {
      // 50 distinct times and 5 priorities: about 400 events share each (time, priority).
      const time = Math.floor(random.uniform(0, 50)) / 4;
      const priority = Math.floor(random.uniform(-2, 3));
      const slot = queue.add(time, priority);
      slots.push(slot);
      kept.push({ time, priority, seq: queue.records.seq(slot) });
    }
    // Cancel about a third, wherever they are in the heap.
    const cancelled = new Set<number>();
    for (const [index, slot] of slots.entries()) {
      if (random.uniform() < 1 / 3) {
        queue.cancel(slot);
        cancelled.add(index);
      }
    }
    const expected = kept.filter((_, index) => !cancelled.has(index)).sort(byKey);
    expect(queue.queue.size).toBe(expected.length);
    expect(queue.drainKeys()).toEqual(expected);
  });

  it('fires in key order when adding, cancelling and firing are interleaved, as in a run', () => {
    const random = new Random(11);
    const queue = new TestQueue();
    /** The reference: pending events in a plain list, the next one found by a full scan. */
    const pending = new Map<number, Key>();
    let now = 0;
    const add = (): void => {
      // As in a simulation: never earlier than now, often at exactly now or on a coarse grid.
      const time = now + Math.floor(random.uniform(0, 8)) / 2;
      const priority = Math.floor(random.uniform(-1, 2));
      const slot = queue.add(time, priority);
      pending.set(slot, { time, priority, seq: queue.records.seq(slot) });
    };
    for (let i = 0; i < 1_000; i++) add();
    for (let step = 0; step < 30_000; step++) {
      const action = random.uniform();
      if (action < 0.45) {
        add();
      } else if (action < 0.55 && pending.size > 0) {
        const slots = [...pending.keys()];
        const slot = slots[Math.floor(random.uniform(0, slots.length))] ?? -1;
        queue.cancel(slot);
        pending.delete(slot);
      } else if (pending.size > 0) {
        const next = [...pending.entries()].reduce((best, entry) => (byKey(entry[1], best[1]) < 0 ? entry : best));
        const fired = queue.pop();
        expect(fired && { time: fired.time, priority: fired.priority, seq: fired.seq }).toEqual(next[1]);
        pending.delete(next[0]);
        now = next[1].time;
      }
    }
    expect(queue.queue.size).toBe(pending.size);
    expect(queue.drainKeys()).toEqual([...pending.values()].sort(byKey));
  });

  it('removes a cancelled event at once and keeps the order of the rest', () => {
    const queue = new TestQueue();
    const slots = Array.from({ length: 10_000 }, (_, i) => queue.add(10_000 - i, 0, String(i)));
    const isKept = (index: number): boolean => index % 10 === 0;
    slots.forEach((slot, index) => {
      if (!isKept(index)) queue.cancel(slot);
    });
    expect(queue.queue.size).toBe(1_000);
    const expected = slots.map((_, index) => String(index)).filter((_, index) => isKept(index));
    expect(queue.drainLabels()).toEqual(expected.reverse());
  });
});

describe('EventRecords', () => {
  it('reuses the most recently freed slot first and changes its generation', () => {
    const records = new EventRecords();
    const first = records.allocate(0, 0, 0, 0, 0);
    const second = records.allocate(0, 1, 0, 0, 0);
    expect([first, second]).toEqual([0, 1]);
    const generation = records.generation(second);

    records.free(second);
    expect(records.generation(second)).not.toBe(generation);
    const reused = records.allocate(3, 2, 1, 7, 9);
    expect(reused).toBe(second);
    expect(records.generation(reused)).not.toBe(generation);
    expect([records.priority(reused), records.seq(reused), records.kind(reused)]).toEqual([3, 2, 1]);
    expect([records.target(reused), records.data(reused)]).toEqual([7, 9]);
  });

  it('grows past its first capacity and keeps every record', () => {
    const records = new EventRecords();
    const slots = Array.from({ length: 5_000 }, (_, i) => records.allocate(i % 3, i, i % 5, i, -i));
    expect(slots).toEqual(Array.from({ length: 5_000 }, (_, i) => i));
    expect(records.seq(4_999)).toBe(4_999);
    expect(records.data(4_999)).toBe(-4_999);
    records.setTarget(4_999, 42);
    expect(records.target(4_999)).toBe(42);
  });
});
