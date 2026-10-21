import { type Agent, SimulationError, type Simulation } from '@mozaika/kernel';
import { EventKind } from '@mozaika/kernel/extension';

import { HoldingBlock, type HoldingBlockOptions, type UnitRequester } from './block.js';
import { type Distribution, TimeSampler } from './distribution.js';
import { describeEntity } from './entity.js';
import { blockStream, registerBlockName } from './registry.js';
import type { ResourcePool } from './resource-pool.js';
import { type Tally, TimeAverage } from './statistics.js';
import { WaitingLine } from './waiting-line.js';

export interface ServiceOptions extends HoldingBlockOptions {
  /** The units that serve; one pool may serve several blocks and model processes. */
  readonly pool: ResourcePool;
  /** Service time, drawn from the block's stream when service starts. */
  readonly duration: Distribution;
}

/**
 * Queue, seize one unit of the pool, service time, release (docs/BLOCKS.md,
 * section 5). `capacity` limits the entities in the block, waiting and in
 * service together. A served entity keeps its unit until the next block has
 * room for it ("blocking after service"). The block's own events are the
 * ends of service; an entity that waited for a unit starts service in the
 * pool's grant event.
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
  readonly #serviceEnds: EventKind;
  /** Asks the pool for units on behalf of the entities: a unit granted later starts service. */
  readonly #unitRequests: UnitRequester = {
    unitGranted: (_pool, row) => {
      this.#startService(row);
    },
    describeRequest: (row) => this.describeRequest(row),
  };

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
    this.#line = new WaitingLine(simulation, this.name, this.entities);
    this.#content = new TimeAverage(simulation);
    this.stats = { queueLength: this.#line.length, waitTime: this.#line.waitTime, content: this.#content };
    this.#serviceEnds = new EventKind(simulation, {
      fire: (row) => {
        this.leaveWhenNextHasRoom(row);
      },
      label: (row) => `${this.name}: ${describeEntity(this.entities.agentOrUndefined(row))} service ends`,
    });
    registerBlockName(simulation, this.name);
  }

  /** The entity joins the line and asks the pool for a unit; with one free, service starts at once. */
  override enter(agent: Agent): void {
    const row = this.hold(agent);
    this.#content.add(1);
    this.#line.join(row);
    this.runEntryAction(row);
    if (this.pool.request(this.#unitRequests, row) === 'granted') this.#startService(row);
  }

  override resetStatistics(): void {
    this.#line.resetStatistics();
    this.#content.reset();
  }

  /** The served entity gives its unit back, to the first request waiting for one. */
  protected override letGo(): void {
    this.pool.release();
    this.#content.add(-1);
  }

  /** The entity has its unit: it leaves the line, and its service time is drawn now. */
  #startService(row: number): void {
    this.#line.leave(row);
    this.#serviceEnds.schedule(this.#duration.next(), row, 0);
  }
}
