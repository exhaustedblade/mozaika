import { describe, expect, it } from 'vitest';

import { Fifo } from './fifo.js';

describe('Fifo', () => {
  it('returns items in the order they were pushed', () => {
    const fifo = new Fifo<string>();
    expect(fifo.shift()).toBeUndefined();
    fifo.push('a');
    fifo.push('b');
    expect(fifo.shift()).toBe('a');
    fifo.push('c');
    expect(fifo.size).toBe(2);
    expect([fifo.shift(), fifo.shift(), fifo.shift()]).toEqual(['b', 'c', undefined]);
    expect(fifo.size).toBe(0);
  });

  it('keeps the order across compactions of a long queue', () => {
    const fifo = new Fifo<number>();
    const taken: number[] = [];
    let next = 0;
    // Grow to thousands of items while taking some, so the front is dropped several times.
    for (let round = 0; round < 50; round++) {
      for (let i = 0; i < 100; i++) fifo.push(next++);
      for (let i = 0; i < 60; i++) taken.push(fifo.shift() ?? -1);
    }
    while (fifo.size > 0) taken.push(fifo.shift() ?? -1);
    expect(taken).toEqual(Array.from({ length: next }, (_, i) => i));
  });
});
