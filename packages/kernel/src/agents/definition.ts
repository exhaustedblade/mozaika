/**
 * The format of statechart definitions (docs/AGENTS.md, section 2): a subset
 * of the XState v5 machine config, so that a definition reads the same here
 * and there, without a dependency on XState.
 *
 *     defineStatechart({
 *       initial: 'waiting',
 *       context: { patience: 2.5 },
 *       states: {
 *         waiting: { after: { patience: 'impatient' }, on: { called: 'served' } },
 *         impatient: { on: { called: 'served' } },
 *         served: { type: 'final' },
 *       },
 *     }, { delays: { patience: ({ context }) => context.patience } });
 *
 * Unlike XState, actions change the fields in place (`context.x = 1`): with
 * many thousands of agents, copying the fields on every change is too slow.
 */
import type { Random } from '../random.js';
import type { Agent } from './agent.js';

/** A message to an agent, or another event of its step: an object with a `type`, as in XState. */
export interface AgentEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** What actions, guards and delays receive. */
export interface AgentArgs<TContext extends object = object> {
  readonly agent: Agent<TContext>;
  /** The agent's fields: the same object as `agent.context`. */
  readonly context: TContext;
  /**
   * The message being handled, or the event of another kind of step:
   * `agent.start` (creation), `agent.after` (a timeout), `agent.check` (an explicit check).
   */
  readonly event: AgentEvent;
  /** Current model time. */
  readonly now: number;
  /** A random stream: the delay's own for a delay, the population's for the rest. */
  readonly random: Random;
}

/** Runs on entry, on exit or with a transition; may change the fields and the model. */
export type AgentAction<TContext extends object = object> = (args: AgentArgs<TContext>) => void;

/** Decides whether a transition is enabled; must not change the model. */
export type AgentGuard<TContext extends object = object> = (args: AgentArgs<TContext>) => boolean;

/** Computes a delay, in model-time units, when the agent enters the state. */
export type AgentDelayFunction<TContext extends object = object> = (args: AgentArgs<TContext>) => number;

/**
 * A delay: a fixed number of model-time units or a function. Infinity means
 * "never": no timer is set.
 */
export type AgentDelay<TContext extends object = object> = number | AgentDelayFunction<TContext>;

/** One action or several, run in order. */
export type AgentActions<TContext extends object = object> = AgentAction<TContext> | readonly AgentAction<TContext>[];

export interface TransitionConfig<TContext extends object = object> {
  /** The state to go to; without it the transition only runs its actions. */
  readonly target?: string;
  readonly guard?: AgentGuard<TContext>;
  readonly actions?: AgentActions<TContext>;
  /** Exit and enter again even if the target is the current state; default false, as in XState v5. */
  readonly reenter?: boolean;
  readonly description?: string;
}

/** A target state name, a transition, or several, tried in order until one is enabled. */
export type TransitionsConfig<TContext extends object = object> =
  | string
  | TransitionConfig<TContext>
  | readonly (string | TransitionConfig<TContext>)[];

export interface StateConfig<TContext extends object = object> {
  /** 'atomic' (default) or 'final': the agent stops there. */
  readonly type?: 'atomic' | 'final';
  readonly entry?: AgentActions<TContext>;
  readonly exit?: AgentActions<TContext>;
  /** Transitions on messages, by message type. */
  readonly on?: Readonly<Record<string, TransitionsConfig<TContext>>>;
  /** Transitions on timeouts: a number of time units or the name of a delay → transitions. */
  readonly after?: Readonly<Record<string, TransitionsConfig<TContext>>>;
  /** Transitions on conditions, without an event. */
  readonly always?: TransitionsConfig<TContext>;
  readonly description?: string;
}

/** What a function that builds the fields of a new agent receives. */
export interface ContextArgs {
  /** The id the new agent gets. */
  readonly id: number;
  /** Current model time. */
  readonly now: number;
  /** The random stream of the population. */
  readonly random: Random;
}

export interface StatechartConfig<TContext extends object = object> {
  /** Name for people and tools. */
  readonly id?: string;
  /** Name of the state each agent starts in. */
  readonly initial: string;
  /**
   * The fields of a new agent: an object, which every agent gets a shallow
   * copy of, or a function that builds them (for nested objects or random values).
   */
  readonly context?: TContext | ((args: ContextArgs) => TContext);
  readonly states: Readonly<Record<string, StateConfig<TContext>>>;
  readonly description?: string;
}

/** Implementations referred to by name, as in XState's setup(): for now, delays. */
export interface StatechartImplementations<TContext extends object = object> {
  readonly delays?: Readonly<Record<string, AgentDelay<TContext>>>;
}
