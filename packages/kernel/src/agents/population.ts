/**
 * Populations: all agents of one type in a simulation (docs/AGENTS.md).
 */
import { describeValue, messageOf, SimulationError } from '../errors.js';
import type { Simulation } from '../simulation.js';
import { Agent } from './agent.js';
import { Statechart } from './statechart.js';
import { AgentStore } from './store.js';

export interface AgentPopulationOptions<TContext extends object = object> {
  /** Unique within the simulation; also chooses the random streams of the agents, agents/<name>/… */
  readonly name: string;
  /** The type of the agents, from defineStatechart(). */
  readonly statechart: Statechart<TContext>;
}

/**
 * Names of the populations of each simulation, kept here because the kernel's
 * Simulation knows nothing about agents. Keyed weakly: a finished simulation
 * takes its names with it when it is garbage-collected.
 */
const populationNames = new WeakMap<Simulation, Set<string>>();

/**
 * The agents of one type. They are numbered 1, 2, 3… in the order of
 * creation, and their state codes are kept in a dense array in that order,
 * so a snapshot of a large population is one typed array (stateCodes()).
 */
export class AgentPopulation<TContext extends object = object> {
  readonly simulation: Simulation;
  readonly name: string;
  readonly statechart: Statechart<TContext>;
  readonly #store: AgentStore<TContext>;

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
    this.#store = new AgentStore(simulation, this.name, this.statechart);
    // Last, so that a population refused for a bad option does not keep its name.
    claimPopulationName(simulation, this.name);
  }

  /** Number of agents created so far. */
  get size(): number {
    return this.#store.agents.length;
  }

  /** The agents in the order of creation; agent i has id i + 1. */
  get agents(): readonly Agent<TContext>[] {
    return this.#store.agents;
  }

  /** Messages delivered so far that found no enabled transition and were discarded. */
  get discardedMessages(): number {
    return this.#store.discardedMessages;
  }

  /**
   * Creates an agent. Its fields are a copy of the statechart's `context` (or
   * what its function builds) with `fields` on top. The agent enters its
   * initial state at once, inside this call, without an event.
   */
  add(fields?: Partial<TContext>): Agent<TContext> {
    const context = this.#createContext();
    if (fields !== undefined) Object.assign(context, requireFields(fields, this.name));
    return new Agent(this.#store, this, context);
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

  /**
   * The state code of every agent, in the order of creation: a copy, so it
   * can be handed to a viewer as is. Code k is statechart.stateNames[k].
   */
  stateCodes(): Uint16Array {
    return this.#store.copyCodes();
  }

  /**
   * Checks the conditions of every agent, in the order of creation (Agent.check).
   * Call it after changing data that many agents' conditions read.
   */
  check(): void {
    // Agents created during the loop are checked too; they were checked at creation, so it does no harm.
    for (const agent of this.#store.agents) agent.check();
  }

  #createContext(): TContext {
    const id = this.#store.nextId;
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
