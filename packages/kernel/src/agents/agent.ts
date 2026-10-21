/**
 * Agents: objects with fields that live by a statechart (docs/AGENTS.md).
 *
 * An agent is not a process. Its timeouts and messages are events of kinds
 * its population registers with the kernel (store.ts, messages.ts). Such an
 * event carries numbers — the agent's place in the population's columns and
 * the timer, or a row of the message table — rather than an object and a
 * closure, so a hundred thousand agents cost their objects and fields, a few
 * columns of numbers and their pending events.
 */
import { messageOf, SimulationError } from '../errors.js';
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

/**
 * The place of a removed agent: −1 − the code of the state it was removed in.
 * Negative, so it is never a row of the columns, and it keeps the state the
 * agent still reports (П-35) without a table of removed agents: a WeakMap
 * entry per removal grew with every agent that passed a Sink.
 */
export function removedPlace(stateCode: number): number {
  return -1 - stateCode;
}

/** The state code kept in the place of a removed agent; see removedPlace. */
function stateCodeOfRemoved(place: number): number {
  return -1 - place;
}

/**
 * What an agent's population does with it beyond the public API. These need
 * the agent's private fields, so the static block of Agent defines them: a
 * static block sees the private fields of every instance, which makes it the
 * standard way to give one module "friend" access to a class (ES2022). The
 * package does not export them.
 */
export interface AgentFriend {
  /** The agent takes the step of one of its timers that has fired. */
  fireTimer<TContext extends object>(agent: Agent<TContext>, timer: Timer<TContext>): void;
  /** The agent takes the step of a message delivered to it, or discards it. */
  receive<TContext extends object>(agent: Agent<TContext>, message: AgentEvent): void;
  /**
   * Removes the agent from its population now, or at the end of its step if
   * it is taking one; returns false if it was already removed or leaving.
   */
  remove<TContext extends object>(agent: Agent<TContext>): boolean;
  /** Sets the agent's place: a row of the columns after another agent's removal moved it, or removedPlace(). */
  moveTo<TContext extends object>(agent: Agent<TContext>, index: number): void;
}

/**
 * See AgentFriend. Set once, by the static block of Agent, when this module
 * is evaluated, before any module that imports it uses it; ES modules give
 * importers a binding they cannot assign.
 */
export let agentFriend: AgentFriend;

export class Agent<TContext extends object = object> {
  /** Number in the population: 1, 2, 3… in the order of creation unless given at creation; never reused. */
  readonly id: number;
  /** Model time at which the agent was created. */
  readonly createdAt: number;
  /** The agent's fields; actions change them in place. */
  readonly context: TContext;
  readonly #store: AgentStore<TContext>;
  /**
   * Place in the population's columns, or removedPlace() of its last state.
   * It changes when the population removes another agent and moves this one
   * into its place, so every access to the columns reads it anew.
   */
  #index: number;
  /** True while the agent takes a step: its own check() then waits for the end of the step, and so does its removal. */
  #busy = false;

  static {
    agentFriend = {
      fireTimer: (agent, timer) => {
        agent.#react(timer.event, timer.transitions);
      },
      receive: (agent, message) => {
        agent.#receive(message);
      },
      remove: (agent) => agent.#remove(),
      moveTo: (agent, index) => {
        agent.#index = index;
      },
    };
  }

  /**
   * Use population.add(). The agent joins the population and enters its
   * initial state at once, inside the constructor, without an event.
   */
  constructor(store: AgentStore<TContext>, context: TContext, id: number) {
    this.#store = store;
    this.context = context;
    this.id = id;
    this.createdAt = store.simulation.now;
    this.#index = store.add(this);
    this.#start();
  }

  get population(): AgentPopulation<TContext> {
    return this.#store.population;
  }

  /** Name of the current state; for a removed agent, of the state it was removed in. */
  get state(): string {
    return this.#currentState().name;
  }

  /** True once the agent is in a final state: it no longer reacts to anything. */
  get done(): boolean {
    return this.#currentState().final;
  }

  /** True once the agent has been removed from its population: it no longer reacts to anything. */
  get removed(): boolean {
    return this.#index < 0;
  }

  /**
   * Sends the agent a message. It is delivered as an event at the current
   * time, after the events already due now (П-8); a message that finds no
   * enabled transition, or a removed agent, is discarded and counted in
   * population.discardedMessages.
   */
  send(event: AgentEvent): void {
    this.#store.send(this, requireMessage(event));
  }

  /**
   * Checks the conditions (eventless transitions) of the current state now and
   * takes the first enabled one, then the next, until none is enabled. Call it
   * after changing data that the conditions read. Does nothing while the agent
   * is taking a step of its own: the step checks the conditions at its end.
   */
  check(): void {
    if (this.#busy || this.removed || this.done) return;
    this.#react(CHECK_EVENT, undefined);
  }

  #start(): void {
    const initial = this.#store.statechart.initial;
    // The store has made the initial state current already. A state with no
    // entry actions, timers or conditions has nothing more to run, so the step
    // and its arguments are skipped: simple entities of the blocks start so.
    if (initial.entry.length === 0 && initial.after.length === 0 && initial.always.length === 0) return;
    const args = this.#beginStep(START_EVENT);
    try {
      this.#enter(initial, args);
      this.#settle(args);
    } catch (error) {
      throw this.#failure(error);
    } finally {
      this.#endStep();
    }
  }

  #receive(message: AgentEvent): void {
    if (this.removed) {
      this.#store.discardedMessages++;
      return;
    }
    const transitions = this.#currentState().on.get(message.type);
    if (!this.#react(message, transitions)) this.#store.discardedMessages++;
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
      this.#endStep();
    }
  }

  #beginStep(event: AgentEvent): AgentArgs<TContext> {
    this.#busy = true;
    const now = this.#store.simulation.now;
    return { agent: this, context: this.context, event, now, random: this.#store.random };
  }

  /** Ends a step; an agent that asked to be removed during it leaves now. */
  #endStep(): void {
    this.#busy = false;
    if (this.#store.leavesAfterStep(this)) this.#store.removeAt(this.#index);
  }

  #remove(): boolean {
    if (this.removed) return false;
    if (this.#busy) return this.#store.leaveAfterStep(this);
    this.#store.removeAt(this.#index);
    return true;
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
    this.#store.cancelTimers(this.#index);
    runActions(state.exit, args);
  }

  #setTimer(timer: Timer<TContext>, args: AgentArgs<TContext>): void {
    const delay = this.#delayOf(timer, args);
    if (delay !== Infinity) this.#store.setTimer(this.#index, timer, delay);
  }

  #delayOf(timer: Timer<TContext>, args: AgentArgs<TContext>): number {
    const delay = timer.delay;
    if (typeof delay === 'number') return delay;
    const random = this.#store.delayStream(timer);
    const value = delay({ agent: this, context: this.context, event: args.event, now: args.now, random });
    return requireAgentDelay(value, `delay "${timer.key}"`);
  }

  #currentState(): StateNode<TContext> {
    const place = this.#index;
    return place < 0 ? this.#store.stateWithCode(stateCodeOfRemoved(place)) : this.#store.stateAt(place);
  }

  #failure(error: unknown): SimulationError {
    const name = `${this.#store.name}#${String(this.id)}`;
    const time = String(this.#store.simulation.now);
    return new SimulationError(
      'AGENT_FAILED',
      `Agent "${name}" failed at time ${time} in state "${this.state}": ${messageOf(error)}`,
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
