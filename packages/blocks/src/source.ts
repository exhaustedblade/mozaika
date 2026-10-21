import { type ProcessBody, type Simulation, timeout } from '@mozaika/kernel';

import { type EntityReceiver, OutputPort, travel } from './block.js';
import { type Distribution, TimeSampler } from './distribution.js';
import { Entity } from './entity.js';
import { blockStream, nextEntityId, registerBlockName } from './registry.js';
import { requireLimit, requireName } from './validation.js';

export interface SourceOptions {
  /** Unique within the simulation; also chooses the source's random stream. */
  readonly name: string;
  /** Time between arrivals, drawn from the source's own stream. */
  readonly interval: Distribution;
  /** How many entities to create, lost ones included; default Infinity (no limit). */
  readonly limit?: number;
}

/**
 * Creates entities at intervals (docs/BLOCKS.md, section 3). The source starts
 * when it is created: the first arrival comes one interval later, each next one
 * an interval after the previous. A new entity goes on as a process of its own,
 * started at the same moment. If the next block has no room, the arrival is
 * lost: a source cannot hold entities.
 */
export class Source {
  readonly simulation: Simulation;
  readonly name: string;
  /** How many entities the source creates in all; Infinity if unlimited. */
  readonly limit: number;
  readonly #interval: TimeSampler;
  readonly #output: OutputPort;
  #arrivals = 0;
  #lost = 0;

  constructor(simulation: Simulation, options: SourceOptions) {
    this.simulation = simulation;
    this.name = requireName(options.name, 'Source');
    this.#interval = new TimeSampler(
      options.interval,
      blockStream(simulation, this.name),
      `Source "${this.name}" interval`,
    );
    this.limit = requireLimit(options.limit ?? Infinity, `Source "${this.name}" limit`, 0);
    this.#output = new OutputPort(simulation, this.name);
    registerBlockName(simulation, this.name);
    simulation.process(this.#createEntities(), { name: this.name });
  }

  /** Entities created so far, lost ones included. Not affected by statistics resets. */
  get arrivals(): number {
    return this.#arrivals;
  }

  /** Arrivals lost so far because the next block had no room. Not affected by statistics resets. */
  get lost(): number {
    return this.#lost;
  }

  /** The block the entities go to, if connected. */
  get next(): EntityReceiver | undefined {
    return this.#output.target;
  }

  /** Connects the source to the block its entities enter, once; returns that block, so connections chain. */
  connect<T extends EntityReceiver>(next: T): T {
    return this.#output.connect(next);
  }

  *#createEntities(): ProcessBody {
    while (this.#arrivals < this.limit) {
      yield timeout(this.#interval.next());
      this.#arrive();
    }
  }

  #arrive(): void {
    const next = this.#output.requireTarget();
    const entity = new Entity(nextEntityId(this.simulation), this.simulation.now);
    this.#arrivals++;
    if (next.tryReserve()) {
      this.simulation.process(travel(entity, next), { name: `entity-${String(entity.id)}` });
    } else {
      this.#lost++;
    }
  }
}
