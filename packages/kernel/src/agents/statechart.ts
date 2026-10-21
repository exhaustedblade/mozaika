/**
 * Statecharts: the type of an agent — its fields, states and transitions —
 * defined in the XState-shaped format of definition.ts (docs/AGENTS.md).
 */
import { requireFinite, SimulationError } from '../errors.js';
import type { Random } from '../random.js';
import { compileStatechart, type StateNode, type Timer } from './compile.js';
import type {
  AgentArgs,
  AgentDelayFunction,
  ContextArgs,
  StatechartConfig,
  StatechartImplementations,
} from './definition.js';

/**
 * A compiled statechart: the type of an agent. Create it with
 * defineStatechart(); one statechart can serve several populations.
 */
export class Statechart<TContext extends object = object> {
  /** The `id` of the definition, if it has one. */
  readonly id: string | undefined;
  /** State names in the order of the definition; the index is the state code. */
  readonly stateNames: readonly string[];
  /** The states, compiled, by code. */
  readonly states: readonly StateNode<TContext>[];
  readonly initial: StateNode<TContext>;
  /** Every timer of every state, by `index`. */
  readonly timers: readonly Timer<TContext>[];
  /**
   * Number of regions, each with its own current state. One — the whole
   * statechart — until parallel states are supported; then a population will
   * keep a column of state codes per region (П-30).
   */
  readonly regionCount = 1;
  readonly #statesByName: ReadonlyMap<string, StateNode<TContext>>;
  readonly #createContext: (args: ContextArgs) => TContext;

  /** Prefer defineStatechart(), which reads like XState's createMachine(). */
  constructor(config: StatechartConfig<TContext>, implementations: StatechartImplementations<TContext> = {}) {
    const compiled = compileStatechart(config, implementations);
    this.id = compiled.id;
    this.states = compiled.states;
    this.stateNames = compiled.states.map((state) => state.name);
    this.initial = compiled.initial;
    this.timers = compiled.states.flatMap((state) => state.after);
    this.#statesByName = new Map(compiled.states.map((state) => [state.name, state]));
    this.#createContext = compiled.createContext;
  }

  /** The state with this name, if there is one. */
  stateNamed(name: string): StateNode<TContext> | undefined {
    return this.#statesByName.get(name);
  }

  /** The fields of a new agent. */
  createContext(args: ContextArgs): TContext {
    return this.#createContext(args);
  }
}

/**
 * Checks a definition and compiles it. The format is a subset of the XState
 * v5 machine config (definition.ts, docs/AGENTS.md, section 2); anything
 * outside it is refused with an INVALID_ARGUMENT error that names the place.
 * Named delays come in `implementations`, as in XState's setup().
 */
export function defineStatechart<TContext extends object = object>(
  config: StatechartConfig<TContext>,
  implementations?: StatechartImplementations<TContext>,
): Statechart<TContext> {
  return new Statechart(config, implementations);
}

/**
 * A delay for a transition with rate λ (transitions per unit of model time):
 * exponential with mean 1/λ, drawn from the delay's own stream when the agent
 * enters the state. λ may depend on the agent: `rate(({ context }) => context.speed)`.
 * A rate of 0 never fires.
 */
export function rate<TContext extends object = object>(
  value: number | ((args: AgentArgs<TContext>) => number),
): AgentDelayFunction<TContext> {
  if (typeof value === 'function') {
    return (args) => exponentialDelay(requireRate(value(args)), args.random);
  }
  const fixed = requireRate(value);
  return ({ random }) => exponentialDelay(fixed, random);
}

function requireRate(value: unknown): number {
  const number = requireFinite(value, 'rate()');
  if (number < 0) throw new SimulationError('INVALID_ARGUMENT', `rate() must not be negative, got ${String(number)}`);
  return number;
}

function exponentialDelay(rateValue: number, random: Random): number {
  return rateValue === 0 ? Infinity : random.exponential(1 / rateValue);
}
