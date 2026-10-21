/**
 * The requests a ResourcePool keeps (docs/BLOCKS.md, section 2): those that
 * wait for a unit, in the order they were made, and those of blocks that have
 * been granted a unit but not gone on yet. A request of a block is the block
 * and a number it gave (the row of its entity), so it costs no object; a
 * model process waits for its unit with a signal of its own.
 */
import type { Signal } from '@mozaika/kernel';

import type { UnitRequester } from './block.js';
import { Fifo } from './fifo.js';
import { RowPool } from './row-pool.js';

/** Who waits for a unit: a block on behalf of an entity, or a model process woken by its signal. */
export type Waiter = UnitRequester | Signal;

/** Requests waiting for a unit, first in, first out. */
export class RequestQueue {
  // Two queues in step: the waiter and its ticket of each request.
  readonly #waiters = new Fifo<Waiter>();
  readonly #tickets = new Fifo<number>();

  get size(): number {
    return this.#waiters.size;
  }

  push(waiter: Waiter, ticket: number): void {
    this.#waiters.push(waiter);
    this.#tickets.push(ticket);
  }

  /** The ticket of the first request; read it before shift(), which returns the waiter. */
  get firstTicket(): number {
    return this.#tickets.first ?? -1;
  }

  /** Takes the first request out and returns its waiter; undefined if none waits. */
  shift(): Waiter | undefined {
    this.#tickets.shift();
    return this.#waiters.shift();
  }
}

/** Units granted to blocks whose entities have not gone on yet, by row; a grant event carries the row. */
export class GrantTable {
  readonly #rows = new RowPool();
  readonly #requesters: (UnitRequester | undefined)[] = [];
  readonly #tickets: number[] = [];

  add(requester: UnitRequester, ticket: number): number {
    const row = this.#rows.take();
    this.#requesters[row] = requester;
    this.#tickets[row] = ticket;
    return row;
  }

  requester(row: number): UnitRequester | undefined {
    return this.#requesters[row];
  }

  ticket(row: number): number {
    return this.#tickets[row] ?? -1;
  }

  release(row: number): void {
    this.#requesters[row] = undefined;
    this.#rows.release(row);
  }
}
