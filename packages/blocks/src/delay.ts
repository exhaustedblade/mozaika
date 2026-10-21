import { type ProcessBody, type Simulation, timeout } from '@mozaika/kernel';

import { type EntityReceiver, HoldingBlock, type HoldingBlockOptions } from './block.js';
import { type Distribution, TimeSampler } from './distribution.js';
import { blockStream, registerBlockName } from './registry.js';
import { TimeAverage } from './statistics.js';

export interface DelayOptions extends HoldingBlockOptions {
  /** How long each entity stays, drawn from the block's stream when it enters. */
  readonly duration: Distribution;
}

/**
 * Delays entities without a resource: each one on its own, however many there
 * are (docs/BLOCKS.md, section 6). After its delay, an entity waits in the
 * block until the next block has room.
 */
export class Delay extends HoldingBlock {
  readonly stats: {
    /** Number of entities in the block over time. */
    readonly content: TimeAverage;
  };
  readonly #content: TimeAverage;
  readonly #duration: TimeSampler;

  constructor(simulation: Simulation, options: DelayOptions) {
    super(simulation, 'Delay', options);
    this.#duration = new TimeSampler(
      options.duration,
      blockStream(simulation, this.name),
      `Delay "${this.name}" duration`,
    );
    this.#content = new TimeAverage(simulation);
    this.stats = { content: this.#content };
    registerBlockName(simulation, this.name);
  }

  /** The delay does not depend on the entity, so it does not look at it. */
  override *enter(): ProcessBody<EntityReceiver> {
    this.#content.add(1);
    yield timeout(this.#duration.next());
    const next = yield* this.reserveNext();
    this.#content.add(-1);
    this.freePlace();
    return next;
  }

  override resetStatistics(): void {
    this.#content.reset();
  }
}
