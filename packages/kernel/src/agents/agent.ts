/**
 * Agents: objects with fields that live by a statechart (docs/AGENTS.md).
 *
 * An agent is not a process. Its timeouts and messages are plain kernel
 * events, and a timeout is cancelled when the agent leaves its state, so a
 * hundred thousand agents cost a hundred thousand objects and their pending
 * events, not a hundred thousand generators.
 */
import { messageOf, SimulationError } from '../errors.js';
import type { EventHandle } from '../event-queue.js';
import type { AgentAction, AgentArgs, AgentEvent } from './definition.js';
import type { AgentPopulation } from './population.js';
import { requireAgentDelay, type StateNode, type Timer, type Transition } from './compile.js';
import type { AgentStore } from './store.js';

/** The event of the step in which an agent is created and enters its initial state. */
const START_EVENT: AgentEvent = Object.freeze({ type: 'agent.start' });

/** The event of a step started by check(). */
const CHECK_EVENT: AgentEvent = Object.freeze({ type: 'agent.check' });

/**
 * Most eventless transitions one step may take in a row. Real chains of
 * conditions are a few transitions long; more than this means they loop.
 */
const MAX_EVENTLESS_TRANSITIONS = 1000;

export class Agent<TContext extends object = object> {
  /** Number in the population: 1, 2, 3… in the order of creation. */
  readonly id: number;
  /** Model time at which the agent was created. */
  readonly createdAt: number;
  readonly population: AgentPopulation<TContext>;
  /** The agent's fields; actions change them in place. */
  readonly context: TContext;
  readonly #store: AgentStore<TContext>;
  /** Position in the population's arrays. */
  readonly #index: number;
  /**
   * Pending timeouts of the current state. Most states have at most one, so
   * the first has a field of its own and only the rest go into an array: one
   * object and one memory access less per event, for each of many agents.
   */
  #timer: EventHandle | undefined;
  #moreTimers: EventHandle[] | undefined;
  /** True while the agent takes a step: its own check() then waits for the end of the step. */
  #busy = false;

  /**
   * Use population.add(). The agent joins the population and enters its
   * initial state at once, inside the constructor, without an event.
   */
  constructor(store: AgentStore<TContext>, population: AgentPopulation<TContext>, context: TContext) {
    this.#store = store;
    this.population = population;
    this.context = context;
    this.createdAt = store.simulation.now;
    this.#index = store.add(this);
    this.id = this.#index + 1;
    this.#start();
  }

  /** Name of the current state. */
  get state(): string {
    return this.#currentState().name;
  }

  /** True once the agent is in a final state: it no longer reacts to anything. */
  get done(): boolean {
    return this.#currentState().final;
  }

  /**
   * Sends the agent a message. It is delivered as an event at the current
   * time, after the events already due now (П-8); a message that finds no
   * enabled transition is discarded and counted in population.discardedMessages.
   */
  send(event: AgentEvent): void {
    const message = requireMessage(event);
    this.#store.simulation.schedule(
      0,
      () => {
        this.#receive(message);
      },
      { label: this.#store.messageLabel(message.type) },
    );
  }

  /**
   * Checks the conditions (eventless transitions) of the current state now and
   * takes the first enabled one, then the next, until none is enabled. Call it
   * after changing data that the conditions read. Does nothing while the agent
   * is taking a step of its own: the step checks the conditions at its end.
   */
  check(): void {
    if (this.#busy || this.done) return;
    this.#react(CHECK_EVENT, undefined);
  }

  #start(): void {
    const args = this.#beginStep(START_EVENT);
    try {
      this.#enter(this.#store.statechart.initial, args);
      this.#settle(args);
    } catch (error) {
      throw this.#failure(error);
    } finally {
      this.#busy = false;
    }
  }

  #receive(message: AgentEvent): void {
    const transitions = this.#currentState().on.get(message.type);
    if (!this.#react(message, transitions)) this.#store.discardedMessages++;
  }

  #fire(timer: Timer<TContext>): void {
    this.#react(timer.event, timer.transitions);
  }

  /**
   * One step: takes the first enabled transition among `triggered`, if any,
   * then eventless transitions until none is enabled. Returns whether a
   * triggered transition was taken.
   */
  #react(event: AgentEvent, triggered: readonly Transition<TContext>[] | undefined): boolean {
    const args = this.#beginStep(event);
    try {
      const transition = triggered === undefined ? undefined : firstEnabled(triggered, args);
      if (transition !== undefined) this.#take(transition, args);
      this.#settle(args);
      return transition !== undefined;
    } catch (error) {
      throw this.#failure(error);
    } finally {
      this.#busy = false;
    }
  }

  #beginStep(event: AgentEvent): AgentArgs<TContext> {
    this.#busy = true;
    const now = this.#store.simulation.now;
    return { agent: this, context: this.context, event, now, random: this.#store.random };
  }

  /**
   * Exit actions, the transition's actions, entry actions (UML, SCXML, XState).
   * A transition without a target only runs its actions; one back to the
   * current state exits and enters only with `reenter`, as in XState v5.
   */
  #take(transition: Transition<TContext>, args: AgentArgs<TContext>): void {
    const target = transition.target;
    if (target === undefined) {
      runActions(transition.actions, args);
      return;
    }
    const source = this.#currentState();
    const changesState = target !== source || transition.reenter;
    if (changesState) this.#exit(source, args);
    runActions(transition.actions, args);
    if (changesState) this.#enter(target, args);
  }

  /** Takes eventless transitions until no condition holds. */
  #settle(args: AgentArgs<TContext>): void {
    for (let taken = 0; ; taken++) {
      const transition = firstEnabled(this.#currentState().always, args);
      if (transition === undefined) return;
      if (taken === MAX_EVENTLESS_TRANSITIONS) {
        throw new SimulationError(
          'INVALID_STATE',
          `more than ${String(MAX_EVENTLESS_TRANSITIONS)} eventless transitions in a row: the conditions loop`,
        );
      }
      this.#take(transition, args);
    }
  }

  /**
   * The state becomes current, its entry actions run, then its timers are set:
   * after the actions, so that a delay can read fields set on entry.
   */
  #enter(state: StateNode<TContext>, args: AgentArgs<TContext>): void {
    this.#store.setState(this.#index, state);
    runActions(state.entry, args);
    for (const timer of state.after) this.#setTimer(timer, args);
  }

  /** The timers of the state are cancelled, then its exit actions run. */
  #exit(state: StateNode<TContext>, args: AgentArgs<TContext>): void {
    this.#cancelTimers();
    runActions(state.exit, args);
  }

  #setTimer(timer: Timer<TContext>, args: AgentArgs<TContext>): void {
    const delay = this.#delayOf(timer, args);
    if (delay === Infinity) return;
    const handle = this.#store.simulation.schedule(
      delay,
      () => {
        this.#fire(timer);
      },
      { label: this.#store.timerLabel(timer) },
    );
    if (this.#timer === undefined) {
      this.#timer = handle;
    } else {
      this.#moreTimers ??= [];
      this.#moreTimers.push(handle);
    }
  }

  #delayOf(timer: Timer<TContext>, args: AgentArgs<TContext>): number {
    const delay = timer.delay;
    if (typeof delay === 'number') return delay;
    const random = this.#store.delayStream(timer);
    const value = delay({ agent: this, context: this.context, event: args.event, now: args.now, random });
    return requireAgentDelay(value, `delay "${timer.key}"`);
  }

  #cancelTimers(): void {
    this.#timer?.cancel();
    this.#timer = undefined;
    const more = this.#moreTimers;
    if (more === undefined || more.length === 0) return;
    for (const timer of more) timer.cancel();
    more.length = 0;
  }

  #currentState(): StateNode<TContext> {
    return this.#store.stateOf(this.#index);
  }

  /** "population#id", for error messages. */
  #name(): string {
    return `${this.#store.name}#${String(this.id)}`;
  }

  #failure(error: unknown): SimulationError {
    const time = String(this.#store.simulation.now);
    return new SimulationError(
      'AGENT_FAILED',
      `Agent "${this.#name()}" failed at time ${time} in state "${this.state}": ${messageOf(error)}`,
      { cause: error },
    );
  }
}

/** The first transition whose guard holds (or that has none), in the order of the definition. */
function firstEnabled<TContext extends object>(
  transitions: readonly Transition<TContext>[],
  args: AgentArgs<TContext>,
): Transition<TContext> | undefined {
  for (const transition of transitions) {
    if (transition.guard === undefined || transition.guard(args)) return transition;
  }
  return undefined;
}

function runActions<TContext extends object>(
  actions: readonly AgentAction<TContext>[],
  args: AgentArgs<TContext>,
): void {
  for (const action of actions) action(args);
}

/** A message: an object with a string `type`. */
function requireMessage(event: unknown): AgentEvent {
  const type = typeof event === 'object' && event !== null ? (event as { type?: unknown }).type : undefined;
  if (typeof type !== 'string') {
    throw new SimulationError(
      'INVALID_ARGUMENT',
      'send() expects a message: an object with a string type, e.g. { type: "called" }',
    );
  }
  return event as AgentEvent;
}
