/**
 * Row numbers for the tables of the blocks: the entities a block holds and
 * the units a pool has granted. New numbers go 0, 1, 2…; released ones come
 * back first, the most recently released first: its row was used a moment
 * ago, so it is likely still in the processor's cache.
 */
export class RowPool {
  readonly #released: number[] = [];
  #issued = 0;

  take(): number {
    return this.#released.pop() ?? this.#issued++;
  }

  release(row: number): void {
    this.#released.push(row);
  }
}
