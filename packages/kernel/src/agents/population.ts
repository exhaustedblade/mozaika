/**
 * Populations: all agents of one type in a simulation (docs/AGENTS.md).
 */
import { describeValue, messageOf, SimulationError } from '../errors.js';
import type { Simulation } from '../simulation.js';
import { Agent, agentFriend } from './agent.js';
import { Statechart } from './statechart.js';
import { AgentStore } from './store.js';

export interface AgentPopulationOptions<TContext extends object = object> {
  /** Unique within the simulation; also chooses the random streams of the agents, agents/<name>/… */
  readonly name: string;
  /** The type of the agents, from defineStatechart(). */
  readonly statechart: Statechart<TContext>;
}

export interface AddAgentOptions {
  /**
   * The agent's number: a whole number above every number the population has
   * given so far, so numbers still grow in the order of creation and are
   * never reused. Default: one more than the last number. A Source uses it to
   * number its agents by arrival (docs/BLOCKS.md, section 3).
   */
  readonly id?: number;
}

/**
 * A population with any fields, for code that does not touch them, such as
 * snapshots. AgentPopulation<TContext> is invariant in its fields — its
 * statechart's actions take them — so an AgentPopulation<{ speed: number }>
 * is not an AgentPopulation<object>.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any fields, as explained above
export type AnyPopulation = AgentPopulation<any>;

/**
 * Names of the populations of each simulation, kept here because the kernel's
 * Simulation knows nothing about agents. Keyed weakly: a finished simulation
 * takes its names with it when it is garbage-collected.
 */
const populationNames = new WeakMap<Simulation, Set<string>>();

/**
 * Reads the store of a population, for the modules of the agents that work on
 * its columns (population-snapshots.ts). Set once, by the static block of
 * AgentPopulation, which sees its private fields: model code cannot reach the store.
 */
export let storeOf: <TContext extends object>(population: AgentPopulation<TContext>) => AgentStore<TContext>;

/**
 * The agents of one type. They are numbered 1, 2, 3… in the order of
 * creation. Their ids, state codes, creation times and movement are kept in
 * dense columns, in the order of creation until an agent is removed: the last
 * agent then takes its place. So a snapshot of a large population is a few
 * typed arrays (ids(), stateCodes(), positions(), PopulationSnapshots).
 */
export class AgentPopulation<TContext extends object = object> {
  readonly simulation: Simulation;
  readonly name: string;
  readonly statechart: Statechart<TContext>;
  readonly #store: AgentStore<TContext>;

  static {
    storeOf = (population) => population.#store;
  }

  constructor(simulation: Simulation, options: AgentPopulationOptions<TContext>) {
    this.simulation = simulation;
    this.name = requirePopulationName(options.name);
    if (!(options.statechart instanceof Statechart)) {
      const given = describeValue(options.statechart);
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `AgentPopulation "${this.name}": statechart must come from defineStatechart(), got ${given}`,
      );
    }
    this.statechart = options.statechart;
    // After the checks, so that a population refused for a bad option does not keep its name.
    claimPopulationName(simulation, this.name);
    this.#store = new AgentStore(this);
  }

  /** Number of agents in the population now. */
  get size(): number {
    return this.#store.agents.length;
  }

  /**
   * The agents in the order of the columns: the order of creation until an
   * agent is removed, when the last agent takes its place.
   */
  get agents(): readonly Agent<TContext>[] {
    return this.#store.agents;
  }

  /** Messages delivered so far that found no enabled transition and were discarded. */
  get discardedMessages(): number {
    return this.#store.discardedMessages;
  }

  /**
   * Creates an agent. Its fields are a copy of the statechart's `context` (or
   * what its function builds) with `fields` on top; its number is
   * `options.id` or the next one. The agent enters its initial state at once,
   * inside this call, without an event.
   */
  add(fields?: Partial<TContext>, options?: AddAgentOptions): Agent<TContext> {
    const id = options?.id === undefined ? this.#store.nextId : this.#requireNewId(options.id);
    const context = this.#createContext(id);
    if (fields !== undefined) Object.assign(context, requireFields(fields, this.name));
    return new Agent(this.#store, context, id);
  }

  /**
   * Removes an agent (П-30): its timeouts are cancelled, messages still on
   * their way to it are discarded and counted in discardedMessages, and the
   * last agent takes its place in the columns. An agent that removes itself
   * from its own action leaves at the end of its step. A removed agent keeps
   * its id, fields and last state, but no longer reacts to anything.
   * Returns false if the agent has already been removed.
   */
  remove(agent: Agent<TContext>): boolean {
    if (!(agent instanceof Agent)) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `AgentPopulation "${this.name}": remove() expects one of its agents, got ${describeValue(agent)}`,
      );
    }
    if (agent.population !== this) {
      const other = agent.population.name;
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `AgentPopulation "${this.name}" cannot remove agent ${other}#${String(agent.id)} of population "${other}"`,
      );
    }
    return agentFriend.remove(agent);
  }

  /** Number of agents in the state now. */
  count(state: string): number {
    const node = this.statechart.stateNamed(state);
    if (node === undefined) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `AgentPopulation "${this.name}" has no state "${state}"; its states: ${this.statechart.stateNames.join(', ')}`,
      );
    }
    return this.#store.count(node.code);
  }

  /** The id of every agent, in the order of the columns: a copy, so it can be handed to a viewer as is. */
  ids(): Float64Array {
    return this.#store.copyIds();
  }

  /**
   * The state code of every agent in one region of the statechart, in the
   * order of the columns: a copy, so it can be handed to a viewer as is. Code k
   * is statechart.stateNames[k]. A statechart has one region for now
   * (statechart.regionCount); parallel states will add a column per region.
   */
  stateCodes(region = 0): Uint16Array {
    if (!Number.isInteger(region) || region < 0 || region >= this.statechart.regionCount) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `AgentPopulation "${this.name}" has no region ${String(region)}; ` +
          `its statechart has ${String(this.statechart.regionCount)}, numbered from 0`,
      );
    }
    return this.#store.copyCodes();
  }

  /**
   * Where every agent is now (docs/AGENTS.md, section 9): x and y of each in
   * turn, in the order of the columns, computed in one pass over their
   * segments; agents that have never moved stand at the origin. Written into
   * `into` if it is given — it must hold 2 × size numbers — or else into a
   * new array. Reuse an array to read the positions of a large population
   * often: a new one of a million agents is 16 MB for the garbage collector.
   */
  positions(into?: Float64Array): Float64Array {
    const length = 2 * this.size;
    if (into !== undefined && (!(into instanceof Float64Array) || into.length < length)) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `AgentPopulation "${this.name}": positions() needs a Float64Array of at least ${String(length)} numbers, ` +
          `got ${into instanceof Float64Array ? `${String(into.length)} numbers` : describeValue(into)}`,
      );
    }
    const positions = into ?? new Float64Array(length);
    this.#store.writePositions(positions);
    return positions;
  }

  /**
   * Checks the conditions of every agent, in the order of the columns (Agent.check).
   * Call it after changing data that many agents' conditions read.
   */
  check(): void {
    // A copy: the checks may add and remove agents. Agents added meanwhile were
    // checked when they were created; removed ones are skipped by their own check().
    for (const agent of [...this.#store.agents]) agent.check();
  }

  #createContext(id: number): TContext {
    const now = this.simulation.now;
    try {
      return this.statechart.createContext({ id, now, random: this.#store.random });
    } catch (error) {
      const agent = `${this.name}#${String(id)}`;
      throw new SimulationError(
        'AGENT_FAILED',
        `Agent "${agent}" failed at time ${String(now)} while building its fields: ${messageOf(error)}`,
        { cause: error },
      );
    }
  }

  /** A number given at creation: whole, and above every earlier one. */
  #requireNewId(id: unknown): number {
    const next = this.#store.nextId;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < next) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `AgentPopulation "${this.name}": add() id must be a whole number of at least ${String(next)}, ` +
          `above every earlier one, got ${describeValue(id)}`,
      );
    }
    return id;
  }
}

function requirePopulationName(name: unknown): string {
  if (typeof name !== 'string' || name === '') {
    throw new SimulationError(
      'INVALID_ARGUMENT',
      `AgentPopulation name must be a non-empty string, got ${describeValue(name)}`,
    );
  }
  return name;
}

/** Names are unique because they choose the random streams of the agents. */
function claimPopulationName(simulation: Simulation, name: string): void {
  let names = populationNames.get(simulation);
  if (names === undefined) {
    names = new Set();
    populationNames.set(simulation, names);
  }
  if (names.has(name)) {
    throw new SimulationError('INVALID_ARGUMENT', `A population named "${name}" already exists in this simulation`);
  }
  names.add(name);
}

function requireFields(fields: unknown, population: string): object {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    throw new SimulationError(
      'INVALID_ARGUMENT',
      `AgentPopulation "${population}": add() takes an object of fields, got ${describeValue(fields)}`,
    );
  }
  return fields;
}
