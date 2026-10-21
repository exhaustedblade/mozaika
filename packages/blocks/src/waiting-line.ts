/** A first-in, first-out line of waiting entities with its statistics; used by Queue and Service. */
import { SimulationError, type Simulation } from '@mozaika/kernel';

import { describeEntity } from './entity.js';
import type { EntityTable } from './entity-table.js';
import { Fifo } from './fifo.js';
import { Tally, TimeAverage } from './statistics.js';

/** First number of rows of the column of join times; it doubles whenever it is too small. */
const INITIAL_CAPACITY = 64;

export class WaitingLine {
  /** Number of entities in the line over time. */
  readonly length: TimeAverage;
  /** Time each entity spent in the line, recorded when it leaves. */
  readonly waitTime = new Tally();
  readonly #simulation: Simulation;
  /** Name of the block, for error messages. */
  readonly #owner: string;
  /** The table of the block, to name entities in errors. */
  readonly #entities: EntityTable;
  /** Rows of the waiting entities in the table, in the order they joined. */
  readonly #rows = new Fifo<number>();
  /** When the entity in each row of the table joined the line. */
  #joinedAt = new Float64Array(INITIAL_CAPACITY);

  constructor(simulation: Simulation, owner: string, entities: EntityTable) {
    this.#simulation = simulation;
    this.#owner = owner;
    this.#entities = entities;
    this.length = new TimeAverage(simulation);
  }

  /** The entity in `row` of the table joins the end of the line. */
  join(row: number): void {
    if (row >= this.#joinedAt.length) this.#growTo(row);
    this.#joinedAt[row] = this.#simulation.now;
    this.#rows.push(row);
    this.length.add(1);
  }

  /**
   * Takes the entity in `row` out of the line, recording its wait from the
   * moment it joined. The blocks grant whatever ends the wait in the order
   * of the line, so it is always the first entity; anything else is a bug in
   * the blocks, reported rather than silently miscounted.
   */
  leave(row: number): void {
    if (this.#rows.shift() !== row) {
      const entity = describeEntity(this.#entities.agentOrUndefined(row));
      throw new SimulationError(
        'INVALID_STATE',
        `"${this.#owner}": entity ${entity} left the line out of first-in, first-out order`,
      );
    }
    this.length.add(-1);
    this.waitTime.add(this.#simulation.now - (this.#joinedAt[row] ?? Number.NaN));
  }

  resetStatistics(): void {
    this.length.reset();
    this.waitTime.reset();
  }

  /** Makes room in the column of join times for rows up to `row`. */
  #growTo(row: number): void {
    let capacity = this.#joinedAt.length * 2;
    while (capacity <= row) capacity *= 2;
    const larger = new Float64Array(capacity);
    larger.set(this.#joinedAt);
    this.#joinedAt = larger;
  }
}
