/** A first-in, first-out line of waiting entities with its statistics; used by Queue and Service. */
import { SimulationError, type Simulation } from '@mozaika/kernel';

import type { Entity } from './entity.js';
import { Fifo } from './fifo.js';
import { Tally, TimeAverage } from './statistics.js';

interface Place {
  readonly entity: Entity;
  /** When the entity joined the line. */
  readonly since: number;
}

export class WaitingLine {
  /** Number of entities in the line over time. */
  readonly length: TimeAverage;
  /** Time each entity spent in the line, recorded when it leaves. */
  readonly waitTime = new Tally();
  readonly #simulation: Simulation;
  /** Name of the block, for error messages. */
  readonly #owner: string;
  readonly #places = new Fifo<Place>();

  constructor(simulation: Simulation, owner: string) {
    this.#simulation = simulation;
    this.#owner = owner;
    this.length = new TimeAverage(simulation);
  }

  join(entity: Entity): void {
    this.#places.push({ entity, since: this.#simulation.now });
    this.length.add(1);
  }

  /**
   * Takes `entity` out of the line. The blocks grant whatever ends the wait in
   * the order of the line, so it is always the first entity; anything else is a
   * bug in the blocks, reported rather than silently miscounted.
   */
  leave(entity: Entity): void {
    const first = this.#places.shift();
    if (first?.entity !== entity) {
      throw new SimulationError(
        'INVALID_STATE',
        `"${this.#owner}": entity ${String(entity.id)} left the line out of first-in, first-out order`,
      );
    }
    this.length.add(-1);
    this.waitTime.add(this.#simulation.now - first.since);
  }

  resetStatistics(): void {
    this.length.reset();
    this.waitTime.reset();
  }
}
