import { describe, expect, it } from 'vitest';

import type { EventQueue } from './event-queue.js';
import { EventRecords } from './event-records.js';
import { FourAryHeap } from './four-ary-heap.js';
import { LadderQueue } from './ladder-queue.js';
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

type QueueClass = new (records: EventRecords) => EventQueue;

/** Both implementations of the queue pass the same tests: the kernel may use either (П-28). */
const IMPLEMENTATIONS: readonly (readonly [string, QueueClass])[] = [
  ['indexed 4-ary heap', FourAryHeap],
  ['ladder queue', LadderQueue],
];

/**
 * A queue with its records, as the scheduler drives them: every added event
 * gets a record with the next number; a label stands for the event's data.
 */
class TestQueue {
  readonly records = new EventRecords();
  readonly queue: EventQueue;
  readonly #labels: string[] = [];
  readonly #times = new Map<number, number>();
  #nextSeq = 0;

  constructor(Queue: QueueClass) {
    this.queue = new Queue(this.records);
  }

  /** Adds an event and returns its slot. */
  add(time: number, priority: number, label = ''): number {
    const slot = this.records.allocate(priority, this.#nextSeq++, 0, 0, this.#labels.push(label) - 1);
    this.queue.add(slot, time);
    this.#times.set(slot, time);
    return slot;
  }

  /** Adds an event and returns its key. */
  addKey(time: number, priority: number): Key {
    return this.keyOf(this.add(time, priority), time);
  }

  keyOf(slot: number, time: number): Key {
    return { time, priority: this.records.priority(slot), seq: this.records.seq(slot) };
  }

  cancel(slot: number): void {
    this.queue.remove(slot);
    this.records.free(slot);
    this.#times.delete(slot);
  }

  /** Takes the first event out, frees its slot and returns its key; undefined if the queue is empty. */
  pop(): (Key & { label: string }) | undefined {
    if (this.queue.size === 0) return undefined;
    const time = this.queue.firstTime();
    const slot = this.queue.removeFirst();
    expect(this.#times.get(slot)).toBe(time);
    this.#times.delete(slot);
    const key = { ...this.keyOf(slot, time), label: this.#labels[this.records.data(slot)] ?? '?' };
    this.records.free(slot);
    return key;
  }

  popKey(): Key | undefined {
    const event = this.pop();
    return event && { time: event.time, priority: event.priority, seq: event.seq };
  }

  drainLabels(): string[] {
    const labels: string[] = [];
    for (let event = this.pop(); event !== undefined; event = this.pop()) labels.push(event.label);
    return labels;
  }

  drainKeys(): Key[] {
    const keys: Key[] = [];
    for (let key = this.popKey(); key !== undefined; key = this.popKey()) keys.push(key);
    return keys;
  }
}

interface Entry {
  readonly slot: number;
  readonly key: Key;
}

/**
 * A reference queue: the pending events in an array sorted by key, kept so
 * by binary search. Obviously right, and fast enough for the tests.
 */
class ReferenceQueue {
  readonly #sorted: Entry[] = [];
  readonly #keys = new Map<number, Key>();

  get size(): number {
    return this.#sorted.length;
  }

  add(slot: number, key: Key): void {
    this.#sorted.splice(this.#indexOf(key), 0, { slot, key });
    this.#keys.set(slot, key);
  }

  delete(slot: number): void {
    const key = this.#keys.get(slot);
    if (key === undefined) throw new Error(`ReferenceQueue: slot ${String(slot)} is not pending`);
    this.#sorted.splice(this.#indexOf(key), 1);
    this.#keys.delete(slot);
  }

  randomSlot(random: Random): number {
    return this.#sorted[Math.floor(random.uniform(0, this.#sorted.length))]?.slot ?? -1;
  }

  /** Removes the next event and returns its key. */
  pop(): Key | undefined {
    const next = this.#sorted.shift();
    if (next !== undefined) this.#keys.delete(next.slot);
    return next?.key;
  }

  sortedKeys(): Key[] {
    return this.#sorted.map((entry) => entry.key);
  }

  /** The first index whose key is not before `key`. */
  #indexOf(key: Key): number {
    let low = 0;
    let high = this.#sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const entry = this.#sorted[middle];
      if (entry !== undefined && byKey(entry.key, key) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

/** Time of a new event, given the current time: the shapes of time a model can make. */
type TimeShape = (random: Random, now: number) => number;

const TIME_SHAPES: readonly (readonly [string, TimeShape])[] = [
  // Random delays, as most models have them: equal times are rare.
  ['exponential delays', (random, now) => now + random.exponential(1)],
  // Delays on a coarse grid: many events share a time.
  ['delays on a grid', (random, now) => now + Math.floor(random.uniform(0, 8)) / 2],
  // Every event at the current moment, as wake-ups and zero delays are.
  ['all at the current moment', (_, now) => now],
  // A mix of the current moment, random delays and whole units.
  [
    'a mix',
    (random, now) => {
      const choice = random.uniform();
      if (choice < 0.3) return now;
      return choice < 0.65 ? now + random.exponential(1) : now + Math.floor(random.uniform(0, 4));
    },
  ],
  // Times a few units in the last place apart: equal, neighbouring or very close doubles.
  [
    'times a few ulps apart',
    (random, now) => now + Math.floor(random.uniform(0, 4)) * Number.EPSILON * Math.max(1, now),
  ],
  // A heavy tail: mostly tiny delays, now and then a delay a billion times longer.
  ['a heavy tail', (random, now) => (random.uniform() < 0.01 ? now + 1e9 : now + random.exponential(1e-3))],
  // Any time at all, also before the current moment: a queue must not rely on time moving forward.
  ['any time, also in the past', (random) => random.uniform(-50, 50)],
];

describe.each(IMPLEMENTATIONS)('EventQueue: %s', (_, Queue) => {
  it('orders events by time, then priority, then scheduling order', () => {
    const queue = new TestQueue(Queue);
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
    const queue = new TestQueue(Queue);
    expect(queue.queue.firstTime()).toBe(Infinity);
    expect(queue.queue.removeFirst()).toBe(-1);
    queue.add(3, 0);
    queue.add(1.5, 0);
    expect(queue.queue.firstTime()).toBe(1.5);
    expect(queue.queue.size).toBe(2);
  });

  it('matches a full sort by (time, priority, seq) on random input', () => {
    const random = new Random(7);
    const queue = new TestQueue(Queue);
    const expected: Key[] = [];
    for (let i = 0; i < 5_000; i++) {
      // Few distinct values, so that ties in time and priority are common.
      const time = Math.floor(random.uniform(0, 20));
      const priority = Math.floor(random.uniform(-2, 3));
      expected.push(queue.addKey(time, priority));
    }
    expected.sort(byKey);
    expect(queue.drainKeys()).toEqual(expected);
  });

  it('matches a full sort by key on a large queue with many ties and cancellations', () => {
    const random = new Random(2026);
    const queue = new TestQueue(Queue);
    const kept: Key[] = [];
    const slots: number[] = [];
    for (let i = 0; i < 100_000; i++) {
      // 50 distinct times and 5 priorities: about 400 events share each (time, priority).
      const time = Math.floor(random.uniform(0, 50)) / 4;
      const priority = Math.floor(random.uniform(-2, 3));
      const slot = queue.add(time, priority);
      slots.push(slot);
      kept.push(queue.keyOf(slot, time));
    }
    // Cancel about a third, wherever they are in the queue.
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

  it('keeps the order of a mass of simultaneous events while it fires, grows and is cancelled', () => {
    const random = new Random(5);
    const queue = new TestQueue(Queue);
    const reference = new ReferenceQueue();
    const add = (time: number): void => {
      const priority = Math.floor(random.uniform(-1, 2));
      const slot = queue.add(time, priority);
      reference.add(slot, queue.keyOf(slot, time));
    };
    // 30 000 events at one moment, a few before and after it.
    for (let i = 0; i < 30_000; i++) add(5);
    for (let i = 0; i < 100; i++) add(random.uniform(0, 10));
    // While the mass fires: events at the same moment are added and some of the mass is cancelled.
    for (let step = 0; step < 30_000; step++) {
      const fired = queue.popKey();
      expect(fired).toEqual(reference.pop());
      if (fired === undefined) break;
      if (step % 3 === 0) add(fired.time);
      if (step % 5 === 0) {
        const slot = reference.randomSlot(random);
        queue.cancel(slot);
        reference.delete(slot);
      }
    }
    expect(queue.queue.size).toBe(reference.size);
    expect(queue.drainKeys()).toEqual(reference.sortedKeys());
  });

  describe.each(TIME_SHAPES)('fires in key order when adding, cancelling and firing interleave: %s', (__, timeOf) => {
    /** Runs random operations against the reference: `start` events, then `steps` adds, cancels and fires. */
    function checkAgainstReference(seed: number, start: number, steps: number, cancelShare: number): void {
      const random = new Random(seed);
      const queue = new TestQueue(Queue);
      const reference = new ReferenceQueue();
      let now = 0;
      const add = (): void => {
        const time = timeOf(random, now);
        const priority = Math.floor(random.uniform(-1, 2));
        const slot = queue.add(time, priority);
        reference.add(slot, queue.keyOf(slot, time));
      };
      for (let i = 0; i < start; i++) add();
      for (let step = 0; step < steps; step++) {
        const action = random.uniform();
        if (action < 0.45) {
          add();
        } else if (action < 0.45 + cancelShare) {
          if (reference.size === 0) continue;
          const slot = reference.randomSlot(random);
          queue.cancel(slot);
          reference.delete(slot);
        } else {
          const expected = reference.pop();
          expect(queue.popKey()).toEqual(expected);
          if (expected !== undefined) now = expected.time;
        }
      }
      expect(queue.queue.size).toBe(reference.size);
      expect(queue.drainKeys()).toEqual(reference.sortedKeys());
    }

    it('in a large queue', () => {
      checkAgainstReference(11, 2_000, 20_000, 0.1);
    });

    it('in a small queue that grows and shrinks', () => {
      checkAgainstReference(12, 5, 20_000, 0.05);
    });

    it('with many cancellations', () => {
      checkAgainstReference(13, 3_000, 10_000, 0.3);
    });
  });

  it('removes a cancelled event at once and keeps the order of the rest', () => {
    const queue = new TestQueue(Queue);
    const slots = Array.from({ length: 10_000 }, (_, i) => queue.add(10_000 - i, 0, String(i)));
    const isKept = (index: number): boolean => index % 10 === 0;
    slots.forEach((slot, index) => {
      if (!isKept(index)) queue.cancel(slot);
    });
    expect(queue.queue.size).toBe(1_000);
    const expected = slots.map((_, index) => String(index)).filter((_, index) => isKept(index));
    expect(queue.drainLabels()).toEqual(expected.reverse());
  });

  it('takes a reused slot as a new event, whatever happened to the old one', () => {
    const queue = new TestQueue(Queue);
    for (let i = 0; i < 200; i++) queue.add(10 + i, 0, `filler ${String(i)}`);
    const cancelled = queue.add(3, 0, 'cancelled');
    queue.cancel(cancelled);
    // The records give the freed slot out first.
    expect(queue.add(500, 0, 'in the slot of the cancelled one')).toBe(cancelled);
    expect(queue.pop()?.label).toBe('filler 0');
    const fired = queue.add(0, -1, 'fires next');
    expect(queue.pop()?.label).toBe('fires next');
    expect(queue.add(9, 0, 'in the slot of the fired one')).toBe(fired);
    const labels = queue.drainLabels();
    expect(labels[0]).toBe('in the slot of the fired one');
    expect(labels.at(-1)).toBe('in the slot of the cancelled one');
    expect(labels).toHaveLength(201);
  });

  it('refuses to remove an event that is not in the queue', () => {
    const queue = new TestQueue(Queue);
    const slot = queue.add(1, 0);
    expect(queue.queue.removeFirst()).toBe(slot);
    expect(() => {
      queue.queue.remove(slot);
    }).toThrow(/not in the queue/);
  });

  it('tells apart equal, neighbouring and very close times of any size and sign', () => {
    const random = new Random(3);
    const queue = new TestQueue(Queue);
    const bases = [0, -0, Number.MIN_VALUE, 1, -1, 1e-300, 1e15, -1e15, 2 ** 52, 1e300];
    const expected: Key[] = [];
    for (let i = 0; i < 3_000; i++) {
      const base = bases[i % bases.length] ?? 0;
      // The same time, or a few doubles away from it on either side.
      const ulps = Math.floor(random.uniform(-3, 4));
      const time = base + ulps * Number.MIN_VALUE + (ulps * Math.abs(base) * Number.EPSILON) / 2;
      expected.push(queue.addKey(time, Math.floor(random.uniform(-1, 2))));
    }
    expected.sort(byKey);
    expect(queue.drainKeys()).toEqual(expected);
  });

  it('places an event at the current moment before later events, after its part of the queue has been taken', () => {
    const random = new Random(8);
    const queue = new TestQueue(Queue);
    const reference = new ReferenceQueue();
    const add = (time: number, priority: number): void => {
      const slot = queue.add(time, priority);
      reference.add(slot, queue.keyOf(slot, time));
    };
    for (let i = 0; i < 20_000; i++) add(random.exponential(1), 0);
    for (let round = 0; round < 2_000; round++) {
      const fired = queue.popKey();
      expect(fired).toEqual(reference.pop());
      if (fired === undefined) break;
      // The event just fired came from the part of the queue being taken now: new events land right there.
      add(fired.time, 1);
      add(fired.time, -1);
      add(fired.time, 0);
      add(fired.time + random.exponential(1e-4), 0);
    }
    expect(queue.drainKeys()).toEqual(reference.sortedKeys());
  });

  it('grows through nested clusters of times and shrinks back when drained, then works again', () => {
    const queue = new TestQueue(Queue);
    const expected: Key[] = [];
    // Ten levels of clusters: level L holds 60 events in (0, 60·2^(−40L)], far finer than
    // the level above, so each level is one more step down the ladder, past its last rung.
    for (let level = 0; level < 10; level++) {
      for (let i = 1; i <= 60; i++) expected.push(queue.addKey(i * 2 ** (-40 * level), 0));
    }
    expected.push(queue.addKey(1e9, 0));
    expected.sort(byKey);
    expect(queue.drainKeys()).toEqual(expected);
    expect(queue.queue.size).toBe(0);
    expect(queue.queue.firstTime()).toBe(Infinity);

    // An emptied queue takes new events as a fresh one.
    const again = [queue.addKey(7, 0), queue.addKey(-3, 0), queue.addKey(7, -1)];
    expect(queue.drainKeys()).toEqual(again.sort(byKey));
  });

  it('keeps its memory bounded by the pending events, however many are cancelled', () => {
    const random = new Random(4);
    const queue = new TestQueue(Queue);
    const pending: number[] = [];
    const cycle = (): void => {
      // Near and far events: some stay, most are cancelled, a few fire.
      pending.push(queue.add(random.uniform() < 0.5 ? random.exponential(1) : 1e6 + random.uniform(0, 1e6), 0));
      if (pending.length > 100) {
        const index = Math.floor(random.uniform(0, pending.length));
        const [slot] = pending.splice(index, 1);
        if (slot !== undefined) queue.cancel(slot);
      }
    };
    // 200 000 cancelled events would take megabytes if the queue kept them until their time came.
    for (let i = 0; i < 200_000; i++) cycle();
    expect(queue.queue.size).toBe(pending.length);
    expect(queue.queue.byteLength).toBeLessThan(256 * 1024);
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
