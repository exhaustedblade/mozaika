import type { ProcessBody, Simulation } from '@mozaika/kernel';

import { type EntityReceiver, HoldingBlock, type HoldingBlockOptions } from './block.js';
import type { Entity } from './entity.js';
import { registerBlockName } from './registry.js';
import type { Tally, TimeAverage } from './statistics.js';
import { WaitingLine } from './waiting-line.js';

export type QueueOptions = HoldingBlockOptions;

/**
 * Holds entities, first in, first out, until the next block has room for them
 * (docs/BLOCKS.md, section 4). If the next block always has room, entities
 * pass through at once. When the queue is full, an entity waits in the block
 * before it, or is lost if it comes from a Source.
 */
export class Queue extends HoldingBlock {
  readonly stats: {
    /** Number of entities in the queue over time. */
    readonly length: TimeAverage;
    /** Time from entering the queue to leaving it, zero waits included. */
    readonly waitTime: Tally;
  };
  readonly #line: WaitingLine;

  constructor(simulation: Simulation, options: QueueOptions) {
    super(simulation, 'Queue', options);
    this.#line = new WaitingLine(simulation, this.name);
    this.stats = { length: this.#line.length, waitTime: this.#line.waitTime };
    registerBlockName(simulation, this.name);
  }

  override *enter(entity: Entity): ProcessBody<EntityReceiver> {
    this.#line.join(entity);
    const next = yield* this.reserveNext();
    this.#line.leave(entity);
    this.freePlace();
    return next;
  }

  override resetStatistics(): void {
    this.#line.resetStatistics();
  }
}
