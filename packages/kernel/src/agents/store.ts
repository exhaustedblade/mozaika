/**
 * The data a population shares with its agents. Internal to the agents module:
 * model code sees it through AgentPopulation and Agent.
 */
import type { Random } from '../random.js';
import type { Simulation } from '../simulation.js';
import type { Agent } from './agent.js';
import type { StateNode, Timer } from './compile.js';
import type { Statechart } from './statechart.js';

/** First length of the dense array of state codes; it doubles whenever the population outgrows it. */
const INITIAL_CAPACITY = 1024;

/**
 * Agents of one population and their state codes in a dense array, indexed by
 * creation order: the form a snapshot of a large population takes
 * (docs/ARCHITECTURE.md, "Большие популяции"). Also the random streams and
 * event labels the agents share.
 */
export class AgentStore<TContext extends object> {
  readonly simulation: Simulation;
  readonly name: string;
  readonly statechart: Statechart<TContext>;
  /** Stream of actions, guards and field functions: agents/<population>. */
  readonly random: Random;
  /** In creation order: the agent with index i has id i + 1. */
  readonly agents: Agent<TContext>[] = [];
  /** Messages that found no enabled transition (docs/AGENTS.md, section 4.3). */
  discardedMessages = 0;
  /** Stream of each timer's delay function, by timer index; undefined for fixed delays. */
  readonly #timerStreams: readonly (Random | undefined)[];
  /**
   * Event labels, made once rather than per event: a new string for every
   * event of many agents costs about a fifth of the speed. So a label names
   * the population and the transition, not the agent; errors name the agent.
   */
  readonly #timerLabels: readonly string[];
  readonly #messageLabels = new Map<string, string>();
  /** State code of each agent, by index. */
  #codes = new Uint16Array(INITIAL_CAPACITY);
  /** Number of agents in each state, by state code. */
  readonly #counts: number[];

  constructor(simulation: Simulation, name: string, statechart: Statechart<TContext>) {
    this.simulation = simulation;
    this.name = name;
    this.statechart = statechart;
    this.random = simulation.random.stream('agents').stream(name);
    // One stream per named delay, created once here: creating a stream is costly (docs/AGENTS.md, section 7).
    this.#timerStreams = statechart.timers.map((timer) =>
      timer.streamName === undefined ? undefined : this.random.stream(timer.streamName),
    );
    const labels: string[] = [];
    for (const state of statechart.states) {
      for (const timer of state.after) labels[timer.index] = `${name}: ${state.name} after ${timer.key}`;
    }
    this.#timerLabels = labels;
    this.#counts = statechart.states.map(() => 0);
  }

  /** The id the next agent gets. */
  get nextId(): number {
    return this.agents.length + 1;
  }

  /** Adds an agent in the initial state and returns its index. */
  add(agent: Agent<TContext>): number {
    const index = this.agents.length;
    this.agents.push(agent);
    if (index === this.#codes.length) this.#grow();
    const code = this.statechart.initial.code;
    this.#codes[index] = code;
    this.#counts[code] = (this.#counts[code] ?? 0) + 1;
    return index;
  }

  stateOf(index: number): StateNode<TContext> {
    const state = this.statechart.states[this.#codes[index] ?? -1];
    if (state === undefined) throw new Error(`AgentStore "${this.name}": no agent with index ${String(index)}`);
    return state;
  }

  setState(index: number, state: StateNode<TContext>): void {
    const previous = this.#codes[index] ?? 0;
    this.#counts[previous] = (this.#counts[previous] ?? 0) - 1;
    this.#codes[index] = state.code;
    this.#counts[state.code] = (this.#counts[state.code] ?? 0) + 1;
  }

  /** Number of agents in the state with this code. */
  count(code: number): number {
    return this.#counts[code] ?? 0;
  }

  /** A copy of the state codes of all agents, in creation order. */
  copyCodes(): Uint16Array {
    return this.#codes.slice(0, this.agents.length);
  }

  /** The stream a timer's delay function draws from. */
  delayStream(timer: Timer<TContext>): Random {
    const stream = this.#timerStreams[timer.index];
    if (stream === undefined) throw new Error(`AgentStore "${this.name}": the delay "${timer.key}" has no stream`);
    return stream;
  }

  /** Label of a timer's events: "<population>: <state> after <key>". */
  timerLabel(timer: Timer<TContext>): string {
    return this.#timerLabels[timer.index] ?? this.name;
  }

  /** Label of the events that deliver messages of a type: "<population>: message "<type>"". */
  messageLabel(type: string): string {
    let label = this.#messageLabels.get(type);
    if (label === undefined) {
      label = `${this.name}: message "${type}"`;
      this.#messageLabels.set(type, label);
    }
    return label;
  }

  #grow(): void {
    const codes = new Uint16Array(this.#codes.length * 2);
    codes.set(this.#codes);
    this.#codes = codes;
  }
}
