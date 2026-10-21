import type { Agent, Simulation } from '@mozaika/kernel';
import { EventKind } from '@mozaika/kernel/extension';

import { HoldingBlock, type HoldingBlockOptions } from './block.js';
import { type Distribution, TimeSampler } from './distribution.js';
import { describeEntity } from './entity.js';
import { blockStream, registerBlockName } from './registry.js';
import { TimeAverage } from './statistics.js';

export interface DelayOptions extends HoldingBlockOptions {
  /** How long each entity stays, drawn from the block's stream when it enters. */
  readonly duration: Distribution;
}

/**
 * Delays entities without a resource: each one on its own, however many there
 * are (docs/BLOCKS.md, section 6). The block's events are the ends of the
 * delays; after its delay, an entity waits in the block until the next block
 * has room.
 */
export class Delay extends HoldingBlock {
  readonly stats: {
    /** Number of entities in the block over time. */
    readonly content: TimeAverage;
  };
  readonly #content: TimeAverage;
  readonly #duration: TimeSampler;
  readonly #delayEnds: EventKind;

  constructor(simulation: Simulation, options: DelayOptions) {
    super(simulation, 'Delay', options);
    this.#duration = new TimeSampler(
      options.duration,
      blockStream(simulation, this.name),
      `Delay "${this.name}" duration`,
    );
    this.#content = new TimeAverage(simulation);
    this.stats = { content: this.#content };
    this.#delayEnds = new EventKind(simulation, {
      fire: (row) => {
        this.leaveWhenNextHasRoom(row);
      },
      label: (row) => `${this.name}: ${describeEntity(this.entities.agentOrUndefined(row))} delay ends`,
    });
    registerBlockName(simulation, this.name);
  }

  /** The entity's delay is drawn as it enters. */
  override enter(agent: Agent): void {
    const row = this.hold(agent);
    this.#content.add(1);
    this.runEntryAction(row);
    this.#delayEnds.schedule(this.#duration.next(), row, 0);
  }

  override resetStatistics(): void {
    this.#content.reset();
  }

  protected override letGo(): void {
    this.#content.add(-1);
  }
}
