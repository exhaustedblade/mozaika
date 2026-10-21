/**
 * A first-in, first-out queue with constant-time push and shift; used for
 * waiting requests and lines of entities, which can grow long under heavy load.
 * (Array.prototype.shift may copy the whole array.)
 */

/** Taken items are dropped from the array once at least this many have piled up at its front. */
const COMPACTION_THRESHOLD = 1024;

export class Fifo<T> {
  #items: (T | undefined)[] = [];
  /** Index of the first item still in the queue. */
  #head = 0;

  get size(): number {
    return this.#items.length - this.#head;
  }

  /** The first item, left in the queue; undefined if the queue is empty. */
  get first(): T | undefined {
    return this.size === 0 ? undefined : this.#items[this.#head];
  }

  push(item: T): void {
    this.#items.push(item);
  }

  /** Takes the first item; undefined if the queue is empty. */
  shift(): T | undefined {
    if (this.size === 0) return undefined;
    const item = this.#items[this.#head];
    this.#items[this.#head] = undefined; // do not keep the item alive
    this.#head++;
    if (this.size === 0) {
      this.#items = [];
      this.#head = 0;
    } else if (this.#head >= COMPACTION_THRESHOLD && this.#head >= this.size) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
    return item;
  }
}
