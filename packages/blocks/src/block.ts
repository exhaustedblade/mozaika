/**
 * How entities move between blocks (docs/BLOCKS.md, section 1).
 *
 * An entity is an agent (П-31). A block keeps the entities it holds in a
 * table and moves them on with kernel events, without a process per entity
 * (П-39). An entity leaves a block only once the next block has room for it;
 * until then it stays where it is, keeping its place there. Places are
 * granted in the order entities asked for them, with the same first-come,
 * first-served handover as the units of a ResourcePool, because the places
 * of a block are a ResourcePool.
 */
import { type Agent, SimulationError, type Simulation } from '@mozaika/kernel';

import { type BlockAction, requireAction, runAction } from './actions.js';
import { describeEntity } from './entity.js';
import { EntityTable } from './entity-table.js';
import { ResourcePool } from './resource-pool.js';
import { requireLimit, requireName } from './validation.js';

/** Something entities pass through: a source, a block or a sink. */
export interface Block {
  readonly simulation: Simulation;
  /** Unique within the simulation. */
  readonly name: string;
}

/**
 * What a request for a unit of a pool, or for a place in a block, got:
 * - granted: the unit is the requester's now, and it goes on at once;
 * - pending: the unit will come — the pool calls requester.unitGranted() in an event of its own;
 * - refused: there is no free unit, and the request does not wait (tryReserve, tryRequest).
 */
export type RequestOutcome = 'granted' | 'pending' | 'refused';

/**
 * Who asks a pool for a unit, or a block for a place, on behalf of an entity
 * it holds. `ticket` is a number the requester chooses, such as the row of
 * the entity in its table; the pool only keeps it and gives it back.
 */
export interface UnitRequester {
  /**
   * A unit asked for earlier, with the answer 'pending', is the requester's
   * now. Called inside the pool's event, at the moment of the grant: the
   * requester goes on with its entity at once.
   */
  unitGranted(pool: ResourcePool, ticket: number): void;
  /** Names the entity of a request in traces and error messages, e.g. "door#3 at hall". */
  describeRequest(ticket: number): string;
}

/**
 * A block that entities can move into. The blocks implement it; so can
 * model code, e.g. a custom end of a flow. Model code does not call these
 * methods itself: the blocks do, as entities move.
 */
export interface EntityReceiver extends Block {
  /** Takes a place for one entity if one is free; never queues: 'refused' if there is none. Used by a Source. */
  tryReserve(requester: UnitRequester, ticket: number): RequestOutcome;
  /** Takes a place for one entity or queues for one, in FIFO order: 'granted' or 'pending'. */
  reserve(requester: UnitRequester, ticket: number): RequestOutcome;
  /** An entity that holds a place here enters the block, inside the current event. */
  enter(agent: Agent): void;
}

/** The single output of a block or a source: where its entities go next. */
export class OutputPort {
  readonly #simulation: Simulation;
  /** Name of the block that owns the port, for error messages. */
  readonly #owner: string;
  #target: EntityReceiver | undefined;

  constructor(simulation: Simulation, owner: string) {
    this.#simulation = simulation;
    this.#owner = owner;
  }

  get target(): EntityReceiver | undefined {
    return this.#target;
  }

  /** Connects the port to `target`, once; returns `target` so that connections chain. */
  connect<T extends EntityReceiver>(target: T): T {
    if (target.simulation !== this.#simulation) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `"${this.#owner}" cannot be connected to "${target.name}": they belong to different simulations`,
      );
    }
    if (this.#target !== undefined) {
      throw new SimulationError(
        'INVALID_STATE',
        `"${this.#owner}" is already connected to "${this.#target.name}"`,
      );
    }
    this.#target = target;
    return target;
  }

  /** The connected block; an entity that must leave through an unconnected port is an error. */
  requireTarget(): EntityReceiver {
    if (this.#target === undefined) {
      throw new SimulationError(
        'INVALID_STATE',
        `"${this.#owner}" is not connected: an entity has nowhere to go; connect it to the next block`,
      );
    }
    return this.#target;
  }
}

/** Options shared by the blocks that hold entities. */
export interface HoldingBlockOptions {
  /** Unique within the simulation; also chooses the block's random stream. */
  readonly name: string;
  /** Most entities the block holds at once: a whole number, at least 1; default Infinity (no limit). */
  readonly capacity?: number;
  /** Runs when an entity enters, once the block counts it (docs/BLOCKS.md, section 8). */
  readonly onEnter?: BlockAction;
  /** Runs when an entity leaves, while the block still counts it and it holds its units. */
  readonly onExit?: BlockAction;
}

/**
 * A block that holds entities for a while: Queue, Service, Delay. It has an
 * optional capacity, one output, entry and exit actions, and a table of the
 * entities it holds.
 *
 * A subclass takes an entity in with hold() and, when the entity is ready to
 * leave, calls leaveWhenNextHasRoom(); the base moves it on, now or once the
 * next block grants it a place, and asks the subclass to letGo() of it.
 *
 * A subclass validates its own options and then calls registerBlockName()
 * as the last step of its constructor, so that a block refused for a bad
 * option does not keep its name.
 */
export abstract class HoldingBlock implements EntityReceiver, UnitRequester {
  readonly simulation: Simulation;
  readonly name: string;
  /** Most entities the block holds at once; Infinity if unlimited. */
  readonly capacity: number;
  /** The entities in the block, by row: the events of the block carry the row. */
  protected readonly entities: EntityTable;
  /** The places of a block with a finite capacity; undefined if unlimited. */
  readonly #places: ResourcePool | undefined;
  readonly #output: OutputPort;
  readonly #onEnter: BlockAction | undefined;
  readonly #onExit: BlockAction | undefined;

  protected constructor(simulation: Simulation, kind: string, options: HoldingBlockOptions) {
    this.simulation = simulation;
    this.name = requireName(options.name, kind);
    this.capacity = requireLimit(options.capacity ?? Infinity, `${kind} "${this.name}" capacity`, 1);
    this.#onEnter = requireAction(options.onEnter, `${kind} "${this.name}" onEnter`);
    this.#onExit = requireAction(options.onExit, `${kind} "${this.name}" onExit`);
    this.entities = new EntityTable(this.name);
    this.#places =
      this.capacity === Infinity
        ? undefined
        : new ResourcePool(simulation, { name: `${this.name} places`, capacity: this.capacity });
    this.#output = new OutputPort(simulation, this.name);
  }

  /** The block the entities go to next, if connected. */
  get next(): EntityReceiver | undefined {
    return this.#output.target;
  }

  /** Connects the output to the next block, once; returns that block, so connections chain. */
  connect<T extends EntityReceiver>(next: T): T {
    return this.#output.connect(next);
  }

  tryReserve(requester: UnitRequester, ticket: number): RequestOutcome {
    return this.#places === undefined ? 'granted' : this.#places.tryRequest(requester, ticket);
  }

  reserve(requester: UnitRequester, ticket: number): RequestOutcome {
    return this.#places === undefined ? 'granted' : this.#places.request(requester, ticket);
  }

  abstract enter(agent: Agent): void;

  /** Starts the statistics of the block again from now (e.g. after a warm-up). */
  abstract resetStatistics(): void;

  /** A place in the next block, asked for by leaveWhenNextHasRoom(), is the entity's now: it leaves. */
  unitGranted(_pool: ResourcePool, row: number): void {
    this.#leave(row, this.#output.requireTarget());
  }

  describeRequest(row: number): string {
    return `${describeEntity(this.entities.agentOrUndefined(row))} at ${this.name}`;
  }

  /** Takes an entering entity into the table and returns its row. */
  protected hold(agent: Agent): number {
    return this.entities.add(agent);
  }

  /** Runs the entry action, if the block has one, for the entity in `row`, which the block has counted. */
  protected runEntryAction(row: number): void {
    if (this.#onEnter !== undefined) runAction(this.#onEnter, this.entities.agent(row), this);
  }

  /**
   * The entity in `row` is ready to leave. It leaves now if the next block
   * has room; otherwise it waits here, keeping its place, until the next
   * block grants it one (unitGranted).
   */
  protected leaveWhenNextHasRoom(row: number): void {
    const next = this.#output.requireTarget();
    if (next.reserve(this, row) === 'granted') this.#leave(row, next);
  }

  /**
   * Updates the statistics of an entity that leaves and lets go of what it
   * holds in the block other than its place, e.g. a unit of a pool.
   */
  protected abstract letGo(row: number): void;

  /**
   * The exit action, then the block lets go of the entity and its place, and
   * the entity enters the next block, where it holds a place already. The row
   * is freed last: the label of the current event may still read it if
   * entering the next block fails.
   */
  #leave(row: number, next: EntityReceiver): void {
    const agent = this.entities.agent(row);
    runAction(this.#onExit, agent, this);
    this.letGo(row);
    this.#places?.release();
    next.enter(agent);
    this.entities.release(row);
  }
}
