/**
 * How entities move between blocks (docs/BLOCKS.md, section 1).
 *
 * Every entity is a kernel process that goes from block to block. It leaves a
 * block only once the next block has room for it; until then it stays where it
 * is, keeping its place there. Places are granted in the order entities asked
 * for them, with the same first-come, first-served handover as ResourcePool.
 */
import { type ProcessBody, SimulationError, type Simulation } from '@mozaika/kernel';

import type { Entity } from './entity.js';
import { ResourcePool } from './resource-pool.js';
import { requireLimit, requireName } from './validation.js';

/**
 * A block that entities can move into. The blocks implement it; so can model
 * code, e.g. a custom end of a flow. Model code does not call these methods
 * itself: the blocks do, as entities move.
 */
export interface EntityReceiver {
  readonly simulation: Simulation;
  readonly name: string;
  /**
   * Takes a place for one entity now and returns true, or returns false if
   * there is no room; never waits. Used by a Source, which cannot hold entities.
   */
  tryReserve(): boolean;
  /** Takes a place for one entity, waiting in FIFO order until there is room. */
  reserve(): ProcessBody;
  /**
   * Runs an entity that holds a place here through the block. Returns the
   * next block, where the entity already holds a place, or undefined if the
   * entity left the model.
   */
  enter(entity: Entity): ProcessBody<EntityReceiver | undefined>;
}

/** The process of one entity: it goes from block to block until one lets it leave the model. */
export function* travel(entity: Entity, first: EntityReceiver): ProcessBody {
  let block: EntityReceiver | undefined = first;
  while (block !== undefined) block = yield* block.enter(entity);
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
}

/**
 * A block that holds entities for a while: Queue, Service, Delay. It has an
 * optional capacity and one output.
 *
 * A subclass validates its own options and then calls registerBlockName()
 * as the last step of its constructor, so that a block refused for a bad
 * option does not keep its name.
 */
export abstract class HoldingBlock implements EntityReceiver {
  readonly simulation: Simulation;
  readonly name: string;
  /** Most entities the block holds at once; Infinity if unlimited. */
  readonly capacity: number;
  /** The places of a block with a finite capacity; undefined if unlimited. */
  readonly #places: ResourcePool | undefined;
  readonly #output: OutputPort;

  protected constructor(simulation: Simulation, kind: string, options: HoldingBlockOptions) {
    this.simulation = simulation;
    this.name = requireName(options.name, kind);
    this.capacity = requireLimit(options.capacity ?? Infinity, `${kind} "${this.name}" capacity`, 1);
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

  tryReserve(): boolean {
    return this.#places?.trySeize() ?? true;
  }

  *reserve(): ProcessBody {
    if (this.#places !== undefined) yield* this.#places.seize();
  }

  abstract enter(entity: Entity): ProcessBody<EntityReceiver | undefined>;

  /** Starts the statistics of the block again from now (e.g. after a warm-up). */
  abstract resetStatistics(): void;

  /**
   * Waits, keeping the entity's place here, until the next block has room for
   * it; returns that block, where the entity now holds a place.
   */
  protected *reserveNext(): ProcessBody<EntityReceiver> {
    const next = this.#output.requireTarget();
    yield* next.reserve();
    return next;
  }

  /** Frees the place of an entity that leaves the block. */
  protected freePlace(): void {
    this.#places?.release();
  }
}
