import { describe, expect, it } from 'vitest';

import { EventQueue } from './event-queue.js';
import { Random } from './random.js';

const noop = (): void => undefined;

/** Pops every event and returns their labels in firing order. */
function drainLabels(queue: EventQueue): string[] {
  const labels: string[] = [];
  for (let event = queue.pop(); event !== undefined; event = queue.pop()) {
    labels.push(event.label ?? '?');
  }
  return labels;
}

describe('EventQueue', () => {
  it('orders events by time, then priority, then scheduling order', () => {
    const queue = new EventQueue();
    queue.add(2, 0, 'late', noop);
    queue.add(1, 5, 'low priority', noop);
    queue.add(1, 0, 'first scheduled', noop);
    queue.add(1, -1, 'urgent', noop);
    queue.add(1, 0, 'second scheduled', noop);
    queue.add(0.5, 9, 'earliest', noop);

    expect(drainLabels(queue)).toEqual([
      'earliest',
      'urgent',
      'first scheduled',
      'second scheduled',
      'low priority',
      'late',
    ]);
  });

  it('numbers events in scheduling order', () => {
    const queue = new EventQueue();
    const seqs = [3, 1, 2].map((time) => queue.add(time, 0, undefined, noop).seq);
    expect(seqs).toEqual([0, 1, 2]);
  });

  it('matches a full sort by (time, priority, seq) on random input', () => {
    const random = new Random(7);
    const queue = new EventQueue();
    const expected: { time: number; priority: number; seq: number }[] = [];
    for (let i = 0; i < 5_000; i++) {
      // Few distinct values, so that ties in time and priority are common.
      const time = Math.floor(random.uniform(0, 20));
      const priority = Math.floor(random.uniform(-2, 3));
      const { seq } = queue.add(time, priority, undefined, noop);
      expected.push({ time, priority, seq });
    }
    expected.sort((a, b) => a.time - b.time || a.priority - b.priority || a.seq - b.seq);

    const fired: { time: number; priority: number; seq: number }[] = [];
    for (let event = queue.pop(); event !== undefined; event = queue.pop()) {
      fired.push({ time: event.time, priority: event.priority, seq: event.seq });
    }
    expect(fired).toEqual(expected);
  });

  it('skips cancelled events and counts only pending ones', () => {
    const queue = new EventQueue();
    const first = queue.add(1, 0, 'first', noop);
    const second = queue.add(2, 0, 'second', noop);
    queue.add(3, 0, 'third', noop);

    expect(first.cancel()).toBe(true);
    expect(first.cancel()).toBe(false);
    expect(first.pending).toBe(false);
    expect(second.pending).toBe(true);
    expect(queue.size).toBe(2);
    expect(queue.peek()?.label).toBe('second');
    expect(drainLabels(queue)).toEqual(['second', 'third']);
    expect(queue.size).toBe(0);
  });

  it('cannot cancel an event that has already been taken out to fire', () => {
    const queue = new EventQueue();
    const event = queue.add(1, 0, undefined, noop);
    expect(queue.pop()).toBe(event);
    expect(event.pending).toBe(false);
    expect(event.cancel()).toBe(false);
  });

  it('keeps the order when most events are cancelled and the heap is compacted', () => {
    const queue = new EventQueue();
    const events = Array.from({ length: 10_000 }, (_, i) => queue.add(10_000 - i, 0, String(i), noop));
    const isKept = (index: number): boolean => index % 10 === 0;
    events.forEach((event, index) => {
      if (!isKept(index)) {
        event.cancel();
      }
    });
    const kept = events.filter((_, index) => isKept(index));

    expect(queue.size).toBe(kept.length);
    const expected = kept.map((event) => event.label).reverse();
    expect(drainLabels(queue)).toEqual(expected);
  });
});
