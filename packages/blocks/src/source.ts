import { Agent, AgentPopulation, SimulationError, type Simulation } from '@mozaika/kernel';
import { EventKind } from '@mozaika/kernel/extension';

import { type BlockAction, requireAction, runAction } from './actions.js';
import { type Block, type EntityReceiver, OutputPort, type UnitRequester } from './block.js';
import { type Distribution, TimeSampler } from './distribution.js';
import { type AnyAgent, describeEntity, SIMPLE_ENTITY } from './entity.js';
import { EntityTable } from './entity-table.js';
import type { ResourcePool } from './resource-pool.js';
import {
  blockStream,
  type EntityNumbers,
  entityNumbersOf,
  registerBlockName,
  requireFreeBlockName,
} from './registry.js';
import { requireLimit, requireName } from './validation.js';

export interface SourceOptions {
  /** Unique within the simulation; also chooses the source's random stream and names its population. */
  readonly name: string;
  /** Time between arrivals, drawn from the source's own stream. */
  readonly interval: Distribution;
  /** How many entities to create, lost ones included; default Infinity (no limit). */
  readonly limit?: number;
  /**
   * Makes the agent of an arrival; by default an agent of the source's own
   * population, with one state and no fields. Lets agents with a statechart
   * and fields of their own travel through the blocks:
   * `entity: () => customers.add()`. Called only for arrivals that get into the next block.
   */
  readonly entity?: EntityFactory;
  /** Runs when an entity leaves the source for the next block (docs/BLOCKS.md, section 8). */
  readonly onExit?: BlockAction;
}

/**
 * Makes the agent of an arrival from the arrival's number and the current
 * model time. The agent must belong to a population of the same simulation.
 */
export type EntityFactory = (id: number, createdAt: number) => AnyAgent;

/** `target` of the source's start event and of its arrivals. */
const START = 0;
const ARRIVAL = 1;

/**
 * Creates entities at intervals (docs/BLOCKS.md, section 3). The source starts
 * with an event at its creation: the first arrival comes one interval later,
 * each next one an interval after the previous. A new entity enters the next
 * block in the event of its arrival. If the next block has no room, the
 * arrival is lost: a source cannot hold entities.
 */
export class Source implements Block, UnitRequester {
  readonly simulation: Simulation;
  readonly name: string;
  /** How many entities the source creates in all; Infinity if unlimited. */
  readonly limit: number;
  /** The population of the source's simple entities, named after it; undefined if a factory makes the agents. */
  readonly population: AgentPopulation | undefined;
  readonly #interval: TimeSampler;
  readonly #createEntity: EntityFactory;
  readonly #onExit: BlockAction | undefined;
  readonly #output: OutputPort;
  readonly #numbers: EntityNumbers;
  readonly #events: EventKind;
  /** New entities that wait, for a moment, for a place granted to them in the next block. */
  readonly #entering: EntityTable;
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
    this.#onExit = requireAction(options.onExit, `Source "${this.name}" onExit`);
    const factory = requireFactory(options.entity, this.name);
    // The population takes a name of its own, so the block name is checked first: a refused
    // source must keep neither name.
    requireFreeBlockName(simulation, this.name);
    if (factory === undefined) {
      const population = new AgentPopulation(simulation, { name: this.name, statechart: SIMPLE_ENTITY });
      this.population = population;
      // Numbered by arrival, so the numbers of entities are those of Ф0-3 (П-38). One options
      // object serves every arrival: add() reads the number at once and keeps nothing.
      const numbered = { id: 0 };
      this.#createEntity = (id) => {
        numbered.id = id;
        return population.add(undefined, numbered);
      };
    } else {
      this.population = undefined;
      this.#createEntity = factory;
    }
    this.#output = new OutputPort(simulation, this.name);
    this.#numbers = entityNumbersOf(simulation);
    this.#entering = new EntityTable(this.name);
    this.#events = new EventKind(simulation, {
      fire: (target) => {
        this.#fire(target);
      },
      label: () => this.name,
    });
    registerBlockName(simulation, this.name);
    this.#events.schedule(0, START, 0);
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

  /** A place in the next block, granted after earlier grants there, is the new entity's now: it enters. */
  unitGranted(_pool: ResourcePool, row: number): void {
    this.#enterNext(row, this.#output.requireTarget());
  }

  describeRequest(row: number): string {
    return `${describeEntity(this.#entering.agentOrUndefined(row))} from ${this.name}`;
  }

  /** The start of the source and each arrival schedule the next arrival, until the limit. */
  #fire(target: number): void {
    if (target === ARRIVAL) this.#arrive();
    if (this.#arrivals < this.limit) this.#events.schedule(this.#interval.next(), ARRIVAL, 0);
  }

  #arrive(): void {
    const next = this.#output.requireTarget();
    // A lost arrival uses up its number too, so numbers count arrivals; only an entity that gets in is made.
    const id = this.#numbers.next();
    this.#arrivals++;
    const row = this.#entering.open();
    const outcome = next.tryReserve(this, row);
    if (outcome === 'refused') {
      this.#entering.release(row);
      this.#lost++;
      return;
    }
    this.#entering.fill(row, this.#makeEntity(id));
    if (outcome === 'granted') this.#enterNext(row, next);
  }

  /** The exit action, then the entity enters the next block, where it holds a place. */
  #enterNext(row: number, next: EntityReceiver): void {
    const agent = this.#entering.agent(row);
    runAction(this.#onExit, agent, this);
    next.enter(agent);
    this.#entering.release(row);
  }

  #makeEntity(id: number): Agent {
    const agent: unknown = this.#createEntity(id, this.simulation.now);
    if (!isAgentOf(this.simulation, agent)) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `Source "${this.name}": its entity factory must return an agent of a population of this simulation`,
      );
    }
    return agent;
  }
}

/** Whether `value` is an agent of a population of `simulation`; the blocks read no fields, so any fields will do. */
function isAgentOf(simulation: Simulation, value: unknown): value is Agent {
  return value instanceof Agent && value.population.simulation === simulation;
}

function requireFactory(factory: unknown, source: string): EntityFactory | undefined {
  if (factory === undefined || typeof factory === 'function') return factory as EntityFactory | undefined;
  throw new SimulationError('INVALID_ARGUMENT', `Source "${source}" entity must be a function that makes an agent`);
}
