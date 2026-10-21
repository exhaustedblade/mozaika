/**
 * The data a population shares with its agents. Internal to the agents module:
 * model code sees it through AgentPopulation and Agent.
 */
import { DEFAULT_PRIORITY } from '../event-queue.js';
import type { Random } from '../random.js';
import { type EventKind, type Scheduler, schedulerOf } from '../scheduler.js';
import type { Simulation } from '../simulation.js';
import { grown } from '../typed-arrays.js';
import { type Agent, agentFriend, REMOVED } from './agent.js';
import type { StateNode, Timer } from './compile.js';
import type { AgentEvent } from './definition.js';
import { AgentMessages } from './messages.js';
import type { AgentPopulation } from './population.js';
import type { Statechart } from './statechart.js';

/** First number of rows of the columns; they double whenever the population outgrows them. */
const INITIAL_CAPACITY = 1024;

/** A cell of the timer column without a pending timeout. */
const NO_EVENT = -1;

/**
 * The agents of one population and their columns (docs/AGENTS.md, section 6;
 * П-30): row i holds the agent's id, its state code and the slots of its
 * pending timeouts. The rows are dense, in the order of creation until an
 * agent is removed: then the last agent moves into its row. Dense columns are
 * the form a snapshot of a large population takes (docs/ARCHITECTURE.md,
 * "Большие популяции"). Also the random streams the agents share and the two
 * kinds of events the population registers: timeouts and messages.
 */
export class AgentStore<TContext extends object> {
  readonly population: AgentPopulation<TContext>;
  readonly simulation: Simulation;
  readonly name: string;
  readonly statechart: Statechart<TContext>;
  /** Stream of actions, guards and field functions: agents/<population>. */
  readonly random: Random;
  /** Messages that found no enabled transition or a removed agent (docs/AGENTS.md, section 4.3). */
  discardedMessages = 0;
  readonly #scheduler: Scheduler;
  readonly #timeoutKind: number;
  readonly #messages: AgentMessages<TContext>;
  readonly #agents: Agent<TContext>[] = [];
  #ids = new Float64Array(INITIAL_CAPACITY);
  #codes = new Uint16Array(INITIAL_CAPACITY);
  /** Room in each row for the timeouts of one state: the most any state of the statechart has. */
  readonly #timersPerRow: number;
  /** Slots of the pending timeouts, #timersPerRow cells per row; NO_EVENT where there is none. */
  #timers: Int32Array;
  /** Cell of each timer within a row, by timer index: its place among the timers of its state. */
  readonly #timerCells: readonly number[];
  /** Stream of each timer's delay function, by timer index; undefined for fixed delays. */
  readonly #timerStreams: readonly (Random | undefined)[];
  /** The end of each timer's label, by timer index: ": <state> after <key>". */
  readonly #timerLabels: readonly string[];
  /** Number of agents in each state, by state code. */
  readonly #counts: number[];
  #created = 0;
  /** Agents that asked to be removed during their own step: they leave when it ends. */
  readonly #leaving = new Set<Agent<TContext>>();
  /** The state each removed agent was in, so that it can still tell it. */
  readonly #removedStates = new WeakMap<Agent<TContext>, StateNode<TContext>>();

  constructor(population: AgentPopulation<TContext>) {
    this.population = population;
    this.simulation = population.simulation;
    this.name = population.name;
    this.statechart = population.statechart;
    this.#scheduler = schedulerOf(this.simulation);
    this.random = this.simulation.random.stream('agents').stream(this.name);
    // One stream per named delay, created once here: creating a stream is costly (docs/AGENTS.md, section 7).
    this.#timerStreams = this.statechart.timers.map((timer) =>
      timer.streamName === undefined ? undefined : this.random.stream(timer.streamName),
    );
    const cells: number[] = [];
    const labels: string[] = [];
    for (const state of this.statechart.states) {
      state.after.forEach((timer, cell) => {
        cells[timer.index] = cell;
        labels[timer.index] = `: ${state.name} after ${timer.key}`;
      });
    }
    this.#timerCells = cells;
    this.#timerLabels = labels;
    this.#timersPerRow = Math.max(0, ...this.statechart.states.map((state) => state.after.length));
    this.#timers = new Int32Array(INITIAL_CAPACITY * this.#timersPerRow).fill(NO_EVENT);
    this.#counts = this.statechart.states.map(() => 0);
    this.#timeoutKind = this.#scheduler.registerKind(new AgentTimeouts(this));
    this.#messages = new AgentMessages(this.#scheduler, this.name);
  }

  /** The agents in the order of the rows. */
  get agents(): readonly Agent<TContext>[] {
    return this.#agents;
  }

  /** The id the next agent gets: ids count every agent created, removed ones included. */
  get nextId(): number {
    return this.#created + 1;
  }

  /** Adds a row for an agent in the initial state and returns its place. */
  add(agent: Agent<TContext>): number {
    const index = this.#agents.length;
    if (index === this.#ids.length) this.#grow();
    this.#agents.push(agent);
    this.#created++;
    this.#ids[index] = agent.id;
    const code = this.statechart.initial.code;
    this.#codes[index] = code;
    this.#counts[code] = (this.#counts[code] ?? 0) + 1;
    return index;
  }

  /**
   * Removes the agent at `index`: cancels its timeouts and moves the last
   * agent into its row, so the columns stay dense. Its messages still pending
   * are discarded when they are delivered.
   */
  removeAt(index: number): void {
    const agent = this.#agentAt(index);
    this.cancelTimers(index);
    const state = this.stateAt(index);
    this.#counts[state.code] = (this.#counts[state.code] ?? 0) - 1;
    this.#removedStates.set(agent, state);
    const last = this.#agents.length - 1;
    if (index !== last) this.#moveRow(last, index);
    this.#agents.pop();
    agentFriend.moveTo(agent, REMOVED);
  }

  /** Asks to remove an agent at the end of its step; returns false if it has asked already. */
  leaveAfterStep(agent: Agent<TContext>): boolean {
    if (this.#leaving.has(agent)) return false;
    this.#leaving.add(agent);
    return true;
  }

  /** Whether the agent asked to be removed during the step it has just ended; forgets the request. */
  leavesAfterStep(agent: Agent<TContext>): boolean {
    return this.#leaving.size > 0 && this.#leaving.delete(agent);
  }

  stateAt(index: number): StateNode<TContext> {
    const state = this.statechart.states[this.#codes[index] ?? -1];
    if (state === undefined) throw new Error(`AgentStore "${this.name}": no agent at ${String(index)}`);
    return state;
  }

  removedStateOf(agent: Agent<TContext>): StateNode<TContext> {
    const state = this.#removedStates.get(agent);
    if (state === undefined) throw new Error(`AgentStore "${this.name}": agent ${String(agent.id)} was not removed`);
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

  /** A copy of the ids, in the order of the rows. */
  copyIds(): Float64Array {
    return this.#ids.slice(0, this.#agents.length);
  }

  /** A copy of the state codes, in the order of the rows. */
  copyCodes(): Uint16Array {
    return this.#codes.slice(0, this.#agents.length);
  }

  /** The stream a timer's delay function draws from. */
  delayStream(timer: Timer<TContext>): Random {
    const stream = this.#timerStreams[timer.index];
    if (stream === undefined) throw new Error(`AgentStore "${this.name}": the delay "${timer.key}" has no stream`);
    return stream;
  }

  /** Sets a timeout of the agent at `index`, due `delay` from now (finite, checked). */
  setTimer(index: number, timer: Timer<TContext>, delay: number): void {
    const scheduler = this.#scheduler;
    const slot = scheduler.add(scheduler.now + delay, DEFAULT_PRIORITY, this.#timeoutKind, index, timer.index);
    this.#timers[this.#timerCell(index, timer.index)] = slot;
  }

  /** Cancels the pending timeouts of the agent at `index`. */
  cancelTimers(index: number): void {
    const start = index * this.#timersPerRow;
    for (let cell = start; cell < start + this.#timersPerRow; cell++) {
      const slot = this.#timers[cell] ?? NO_EVENT;
      if (slot === NO_EVENT) continue;
      this.#scheduler.cancel(slot);
      this.#timers[cell] = NO_EVENT;
    }
  }

  /** Fires a timeout of the agent at `index`: the event has left the queue, and the agent takes its step. */
  fireTimer(index: number, timerIndex: number): void {
    this.#timers[this.#timerCell(index, timerIndex)] = NO_EVENT;
    const timer = this.statechart.timers[timerIndex];
    if (timer === undefined) throw new Error(`AgentStore "${this.name}": no timer ${String(timerIndex)}`);
    agentFriend.fireTimer(this.#agentAt(index), timer);
  }

  /** "<population>#<agent>: <state> after <key>" (П-29). */
  timerLabel(index: number, timerIndex: number): string {
    return `${this.name}#${String(this.#ids[index])}${this.#timerLabels[timerIndex] ?? ''}`;
  }

  send(agent: Agent<TContext>, message: AgentEvent): void {
    this.#messages.send(agent, message);
  }

  #timerCell(index: number, timerIndex: number): number {
    return index * this.#timersPerRow + (this.#timerCells[timerIndex] ?? 0);
  }

  #agentAt(index: number): Agent<TContext> {
    const agent = this.#agents[index];
    if (agent === undefined) throw new Error(`AgentStore "${this.name}": no agent at ${String(index)}`);
    return agent;
  }

  /** Moves the agent in row `from` to row `to`; its pending timeouts follow it. */
  #moveRow(from: number, to: number): void {
    const agent = this.#agentAt(from);
    this.#agents[to] = agent;
    this.#ids[to] = this.#ids[from] ?? 0;
    this.#codes[to] = this.#codes[from] ?? 0;
    const width = this.#timersPerRow;
    for (let cell = 0; cell < width; cell++) {
      const slot = this.#timers[from * width + cell] ?? NO_EVENT;
      this.#timers[to * width + cell] = slot;
      this.#timers[from * width + cell] = NO_EVENT;
      if (slot !== NO_EVENT) this.#scheduler.retarget(slot, to);
    }
    agentFriend.moveTo(agent, to);
  }

  #grow(): void {
    const capacity = this.#ids.length * 2;
    this.#ids = grown(this.#ids, new Float64Array(capacity));
    this.#codes = grown(this.#codes, new Uint16Array(capacity));
    this.#timers = grown(this.#timers, new Int32Array(capacity * this.#timersPerRow).fill(NO_EVENT));
  }
}

/** Timeouts of the agents of one population: `target` is the agent's row, `data` the timer's index. */
class AgentTimeouts<TContext extends object> implements EventKind {
  readonly #store: AgentStore<TContext>;

  constructor(store: AgentStore<TContext>) {
    this.#store = store;
  }

  fire(index: number, timerIndex: number): void {
    this.#store.fireTimer(index, timerIndex);
  }

  label(index: number, timerIndex: number): string {
    return this.#store.timerLabel(index, timerIndex);
  }
}
