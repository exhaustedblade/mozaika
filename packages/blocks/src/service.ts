import { type ProcessBody, SimulationError, type Simulation, timeout } from '@mozaika/kernel';

import { type EntityReceiver, HoldingBlock, type HoldingBlockOptions } from './block.js';
import { type Distribution, TimeSampler } from './distribution.js';
import type { Entity } from './entity.js';
import { blockStream, registerBlockName } from './registry.js';
import type { ResourcePool } from './resource-pool.js';
import { type Tally, TimeAverage } from './statistics.js';
import { WaitingLine } from './waiting-line.js';

export interface ServiceOptions extends HoldingBlockOptions {
  /** The units that serve; one pool may serve several blocks. */
  readonly pool: ResourcePool;
  /** Service time, drawn from the block's stream when service starts. */
  readonly duration: Distribution;
}

/**
 * Queue, seize one unit of the pool, service time, release (docs/BLOCKS.md,
 * section 5). `capacity` limits the entities in the block, waiting and in
 * service together. A served entity keeps its unit until the next block has
 * room for it ("blocking after service").
 */
export class Service extends HoldingBlock {
  readonly pool: ResourcePool;
  readonly stats: {
    /** Number of entities waiting for a unit, over time. */
    readonly queueLength: TimeAverage;
    /** Time from entering the block to the start of service, zero waits included. */
    readonly waitTime: Tally;
    /** Number of entities in the block (waiting, in service, or waiting to leave), over time. */
    readonly content: TimeAverage;
  };
  readonly #line: WaitingLine;
  readonly #content: TimeAverage;
  readonly #duration: TimeSampler;

  constructor(simulation: Simulation, options: ServiceOptions) {
    super(simulation, 'Service', options);
    if (options.pool.simulation !== simulation) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `Service "${this.name}": its pool "${options.pool.name}" belongs to another simulation`,
      );
    }
    this.pool = options.pool;
    this.#duration = new TimeSampler(
      options.duration,
      blockStream(simulation, this.name),
      `Service "${this.name}" duration`,
    );
    this.#line = new WaitingLine(simulation, this.name);
    this.#content = new TimeAverage(simulation);
    this.stats = { queueLength: this.#line.length, waitTime: this.#line.waitTime, content: this.#content };
    registerBlockName(simulation, this.name);
  }

  override *enter(entity: Entity): ProcessBody<EntityReceiver> {
    this.#content.add(1);
    this.#line.join(entity);
    yield* this.pool.seize();
    this.#line.leave(entity);
    yield timeout(this.#duration.next());
    const next = yield* this.reserveNext();
    this.pool.release();
    this.#content.add(-1);
    this.freePlace();
    return next;
  }

  override resetStatistics(): void {
    this.#line.resetStatistics();
    this.#content.reset();
  }
}
