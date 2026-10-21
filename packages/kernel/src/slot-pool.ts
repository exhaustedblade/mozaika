/**
 * Slot numbers for the tables of the kernel: rows of the event records and of
 * the tables that keep what an event cannot hold as a number (a function, a
 * message). New numbers go 0, 1, 2…; released ones come back first, the most
 * recently released first: its row was used a moment ago, so it is likely
 * still in the processor's cache.
 */
export class SlotPool {
  readonly #released: number[] = [];
  #issued = 0;

  /** Distinct slots handed out so far: the number of rows a table needs. */
  get issued(): number {
    return this.#issued;
  }

  take(): number {
    return this.#released.pop() ?? this.#issued++;
  }

  release(slot: number): void {
    this.#released.push(slot);
  }
}
