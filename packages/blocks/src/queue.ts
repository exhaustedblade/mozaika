import type { Agent, Simulation } from '@mozaika/kernel';

import { HoldingBlock, type HoldingBlockOptions } from './block.js';
import { registerBlockName } from './registry.js';
import type { Tally, TimeAverage } from './statistics.js';
import { WaitingLine } from './waiting-line.js';

export type QueueOptions = HoldingBlockOptions;

/**
 * Holds entities, first in, first out, until the next block has room for them
 * (docs/BLOCKS.md, section 4). If the next block always has room, entities
 * pass through at once, in the event they came in. When the queue is full, an
 * entity waits in the block before it, or is lost if it comes from a Source.
 * A queue has no events of its own: entities enter and leave it in the events
 * of other blocks and pools.
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
    this.#line = new WaitingLine(simulation, this.name, this.entities);
    this.stats = { length: this.#line.length, waitTime: this.#line.waitTime };
    registerBlockName(simulation, this.name);
  }

  /** The entity joins the end of the line and asks the next block for a place at once. */
  override enter(agent: Agent): void {
    const row = this.hold(agent);
    this.#line.join(row);
    this.runEntryAction(row);
    this.leaveWhenNextHasRoom(row);
  }

  override resetStatistics(): void {
    this.#line.resetStatistics();
  }

  protected override letGo(row: number): void {
    this.#line.leave(row);
  }
}
