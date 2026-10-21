/**
 * The data a population shares with its agents. Internal to the agents module:
 * model code sees it through AgentPopulation and Agent.
 */
import { DEFAULT_PRIORITY } from '../event-queue.js';
import type { Random } from '../random.js';
import { type EventKindHandler, type Scheduler, schedulerOf } from '../scheduler.js';
import type { Simulation } from '../simulation.js';
import { grown } from '../typed-arrays.js';
import { type Agent, agentFriend } from './agent.js';
import type { StateNode, Timer } from './compile.js';
import type { AgentEvent } from './definition.js';
import { AgentMessages } from './messages.js';
import { AgentMotion, type CheckedMoveOptions, type Point, writeSegmentsAtOrigin } from './motion.js';
import type { AgentPopulation } from './population.js';
import type { Statechart } from './statechart.js';

/** First number of rows of the columns; they double whenever the population outgrows them. */
const INITIAL_CAPACITY = 1024;

/** A cell of the timer column without a pending timeout. */
const NO_EVENT = -1;

/** Numbers per row of the identity column, and their places: the agent's id and its creation time. */
const IDENTITY_WIDTH = 2;
const ID = 0;
const CREATED_AT = 1;

/**
 * The agents of one population and their columns (docs/AGENTS.md, section 6;
 * П-30): row i holds the agent's id, its state code, its creation time and
 * the slots of its pending timeouts, and — once an agent of the population
 * has moved — its segment of movement (motion.ts). The rows are dense, in the
 * order of creation until an agent is removed: then the last agent moves into
 * its row. Dense columns are the form a snapshot of a large population takes
 * (docs/ARCHITECTURE.md, "Снимок популяции"). Also the random streams the
 * agents share and the kinds of events the population registers: timeouts,
 * messages and, with movement, arrivals.
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
  /**
   * The id and the creation time of each agent, side by side (П-42, П-46).
   * As a field of the agent, a fractional creation time took a number object
   * of its own, 12 bytes. Here a Sink reads it as the agent leaves, and the
   * removal then writes the id of the agent moved into the row at the same
   * place: one line of the processor's cache for both rather than two.
   */
  #identities = new Float64Array(INITIAL_CAPACITY * IDENTITY_WIDTH);
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
  /** The number of the last agent created; the next one gets a larger number. */
  #lastId = 0;
  /** Agents that asked to be removed during their own step: they leave when it ends. */
  readonly #leaving = new Set<Agent<TContext>>();
  /**
   * The agents taking a step now, the innermost last: steps nest when an
   * action of one agent calls check() of another. A handful at most, so a
   * list here costs less than a flag in each of a hundred thousand agents.
   */
  readonly #stepping: Agent<TContext>[] = [];
  /** Movement of the agents; created when one of them first moves, so a population that never moves pays nothing. */
  #motion: AgentMotion | undefined;

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

  /** The smallest id the next agent may get, and the one it gets by default. */
  get nextId(): number {
    return this.#lastId + 1;
  }

  /** Adds a row for an agent created now, in the initial state, and returns its place. */
  add(agent: Agent<TContext>): number {
    const index = this.#agents.length;
    if (index === this.#codes.length) this.#grow();
    this.#agents.push(agent);
    this.#lastId = agent.id;
    this.#identities[index * IDENTITY_WIDTH + ID] = agent.id;
    this.#identities[index * IDENTITY_WIDTH + CREATED_AT] = this.#scheduler.now;
    this.#motion?.clearRow(index);
    const code = this.statechart.initial.code;
    this.#codes[index] = code;
    this.#counts[code] = (this.#counts[code] ?? 0) + 1;
    return index;
  }

  /**
   * Removes the agent at `index`: cancels its timeouts and its arrival and
   * moves the last agent into its row, so the columns stay dense. The agent
   * keeps its last state. Its messages still pending are discarded when they
   * are delivered.
   */
  removeAt(index: number): void {
    const agent = this.#agentAt(index);
    this.cancelTimers(index);
    this.#motion?.remove(index);
    const state = this.stateAt(index);
    this.#counts[state.code] = (this.#counts[state.code] ?? 0) - 1;
    const last = this.#agents.length - 1;
    if (index !== last) this.#moveRow(last, index);
    this.#agents.pop();
    agentFriend.markRemoved(agent, state.code);
  }

  /** The agent begins a step; see isStepping. */
  beginStep(agent: Agent<TContext>): void {
    this.#stepping.push(agent);
  }

  /** The innermost step ends. */
  endStep(): void {
    this.#stepping.pop();
  }

  /** Whether the agent is taking a step: its own check() and its removal then wait for the end of the step. */
  isStepping(agent: Agent<TContext>): boolean {
    return this.#stepping.includes(agent);
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

  stateWithCode(code: number): StateNode<TContext> {
    const state = this.statechart.states[code];
    if (state === undefined) throw new Error(`AgentStore "${this.name}": no state with code ${String(code)}`);
    return state;
  }

  setState(index: number, state: StateNode<TContext>): void {
    const previous = this.#codes[index] ?? 0;
    this.#counts[previous] = (this.#counts[previous] ?? 0) - 1;
    this.#codes[index] = state.code;
    this.#counts[state.code] = (this.#counts[state.code] ?? 0) + 1;
  }

  /** The creation time of the agent at `index`. */
  createdAtOf(index: number): number {
    return this.#identities[index * IDENTITY_WIDTH + CREATED_AT] ?? Number.NaN;
  }

  /** Number of agents in the state with this code. */
  count(code: number): number {
    return this.#counts[code] ?? 0;
  }

  /** A copy of the ids, in the order of the rows. */
  copyIds(): Float64Array {
    const ids = new Float64Array(this.#agents.length);
    this.#writeIdentities(ids, undefined);
    return ids;
  }

  /** A copy of the state codes, in the order of the rows. */
  copyCodes(): Uint16Array {
    return this.#codes.slice(0, this.#agents.length);
  }

  /** Writes the positions now into `into`, x and y of each agent in turn, in the order of the rows. */
  writePositions(into: Float64Array): void {
    const size = this.#agents.length;
    if (this.#motion === undefined) {
      into.fill(0, 0, 2 * size);
    } else {
      this.#motion.writePositions(into, size, this.#scheduler.now);
    }
  }

  /**
   * Writes the columns of a snapshot at the current time into views of a
   * buffer (population-snapshots.ts); they hold at least `agents.length` rows.
   */
  writeSnapshot(ids: Float64Array, createdAt: Float64Array, segments: Float32Array, states: Uint16Array): void {
    const size = this.#agents.length;
    this.#writeIdentities(ids, createdAt);
    states.set(this.#codes.subarray(0, size));
    if (this.#motion === undefined) {
      writeSegmentsAtOrigin(segments, size, this.#scheduler.now);
    } else {
      this.#motion.writeSegments(segments, size, this.#scheduler.now);
    }
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

  /** The agent at `index` leaves its state: its timeouts are cancelled, and a walk bound to the state stops. */
  leaveState(index: number): void {
    this.cancelTimers(index);
    this.#motion?.leaveState(index);
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
    return `${this.name}#${String(this.#idOf(index))}${this.#timerLabels[timerIndex] ?? ''}`;
  }

  send(agent: Agent<TContext>, message: AgentEvent): void {
    this.#messages.send(agent, message);
  }

  /** Whether the agent at `index` is walking; agents of a population that has never moved stand. */
  isMoving(index: number): boolean {
    return this.#motion?.isMoving(index) ?? false;
  }

  /** Where the agent at `index` is now; agents of a population that has never moved stand at the origin. */
  position(index: number): Point {
    return this.#motion?.position(index) ?? { x: 0, y: 0 };
  }

  placeAt(index: number, x: number, y: number): void {
    this.#movement().placeAt(index, x, y);
  }

  /** The agent at `index` walks to (x, y), all checked; see AgentMotion.moveTo. */
  moveTo(index: number, x: number, y: number, walk: CheckedMoveOptions): void {
    this.#movement().moveTo(index, x, y, walk);
  }

  stop(index: number): boolean {
    return this.#motion?.stop(index) ?? false;
  }

  /** Fires the arrival of the agent at `index`: the event has left the queue, and the agent takes its step. */
  fireArrival(index: number): void {
    this.#movement().arrived(index);
    agentFriend.arrive(this.#agentAt(index));
  }

  /** "<population>#<agent>: arrival" (П-29). */
  arrivalLabel(index: number): string {
    return `${this.name}#${String(this.#idOf(index))}: arrival`;
  }

  #timerCell(index: number, timerIndex: number): number {
    return index * this.#timersPerRow + (this.#timerCells[timerIndex] ?? 0);
  }

  #idOf(index: number): number {
    return this.#identities[index * IDENTITY_WIDTH + ID] ?? Number.NaN;
  }

  /** Writes the ids, and the creation times if asked, of the agents in the order of the rows. */
  #writeIdentities(ids: Float64Array, createdAt: Float64Array | undefined): void {
    const identities = this.#identities;
    const size = this.#agents.length;
    for (let row = 0, cell = 0; row < size; row++, cell += IDENTITY_WIDTH) {
      ids[row] = identities[cell + ID] ?? Number.NaN;
      if (createdAt !== undefined) createdAt[row] = identities[cell + CREATED_AT] ?? Number.NaN;
    }
  }

  #agentAt(index: number): Agent<TContext> {
    const agent = this.#agents[index];
    if (agent === undefined) throw new Error(`AgentStore "${this.name}": no agent at ${String(index)}`);
    return agent;
  }

  /** The movement of the agents, created with the arrivals kind when one of them first moves. */
  #movement(): AgentMotion {
    if (this.#motion === undefined) {
      const arrivalKind = this.#scheduler.registerKind(new AgentArrivals(this));
      this.#motion = new AgentMotion(this.#scheduler, arrivalKind, this.#codes.length);
    }
    return this.#motion;
  }

  /** Moves the agent in row `from` to row `to`; its pending timeouts and its arrival follow it. */
  #moveRow(from: number, to: number): void {
    const agent = this.#agentAt(from);
    this.#agents[to] = agent;
    this.#identities.copyWithin(to * IDENTITY_WIDTH, from * IDENTITY_WIDTH, (from + 1) * IDENTITY_WIDTH);
    this.#codes[to] = this.#codes[from] ?? 0;
    this.#motion?.moveRow(from, to);
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
    const capacity = this.#codes.length * 2;
    this.#identities = grown(this.#identities, new Float64Array(capacity * IDENTITY_WIDTH));
    this.#codes = grown(this.#codes, new Uint16Array(capacity));
    this.#motion?.grow(capacity);
    this.#timers = grown(this.#timers, new Int32Array(capacity * this.#timersPerRow).fill(NO_EVENT));
  }
}

/** Arrivals of the agents of one population: `target` is the agent's row. */
class AgentArrivals<TContext extends object> implements EventKindHandler {
  readonly #store: AgentStore<TContext>;

  constructor(store: AgentStore<TContext>) {
    this.#store = store;
  }

  fire(index: number): void {
    this.#store.fireArrival(index);
  }

  label(index: number): string {
    return this.#store.arrivalLabel(index);
  }
}

/** Timeouts of the agents of one population: `target` is the agent's row, `data` the timer's index. */
class AgentTimeouts<TContext extends object> implements EventKindHandler {
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
