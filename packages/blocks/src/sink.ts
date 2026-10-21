import type { ProcessBody, Simulation } from '@mozaika/kernel';

import type { EntityReceiver } from './block.js';
import type { Entity } from './entity.js';
import { registerBlockName } from './registry.js';
import { Tally } from './statistics.js';
import { requireName } from './validation.js';

export interface SinkOptions {
  /** Unique within the simulation. */
  readonly name: string;
}

/** Takes entities out of the model and counts them; always has room (docs/BLOCKS.md, section 7). */
export class Sink implements EntityReceiver {
  readonly simulation: Simulation;
  readonly name: string;
  readonly stats: {
    /** Time from creation at the source to leaving through this sink. */
    readonly timeInSystem: Tally;
  };
  #count = 0;

  constructor(simulation: Simulation, options: SinkOptions) {
    this.simulation = simulation;
    this.name = requireName(options.name, 'Sink');
    this.stats = { timeInSystem: new Tally() };
    registerBlockName(simulation, this.name);
  }

  /** Entities that have left through this sink since the start; not affected by resetStatistics(). */
  get count(): number {
    return this.#count;
  }

  tryReserve(): boolean {
    return true;
  }

  *reserve(): ProcessBody {
    // A sink always has room: nothing to wait for.
  }

  // eslint-disable-next-line require-yield -- the receiver protocol expects a generator, even one that never waits
  *enter(entity: Entity): ProcessBody<undefined> {
    this.#count++;
    this.stats.timeInSystem.add(this.simulation.now - entity.createdAt);
    return undefined;
  }

  /** Starts the statistics again from now (e.g. after a warm-up); the count goes on. */
  resetStatistics(): void {
    this.stats.timeInSystem.reset();
  }
}
