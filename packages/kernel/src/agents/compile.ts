/**
 * Compiling statecharts: a definition in the XState-shaped format
 * (definition.ts) is checked once and turned into the tables agents run on —
 * states with their actions, transitions resolved to their target states,
 * timers numbered for the populations. Anything outside the supported subset
 * is refused with an INVALID_ARGUMENT error that names the place of the mistake.
 */
import { describeValue, requireDelay, SimulationError } from '../errors.js';
import type {
  AgentAction,
  AgentDelay,
  AgentEvent,
  AgentGuard,
  ContextArgs,
  StatechartConfig,
  StatechartImplementations,
} from './definition.js';

/** Most states a statechart can have: populations keep the state code of every agent in a Uint16Array. */
export const MAX_STATES = 0xffff;

/** A transition, compiled. */
export interface Transition<TContext extends object = object> {
  /** The state to go to; undefined for a transition that only runs its actions. */
  readonly target: StateNode<TContext> | undefined;
  readonly guard: AgentGuard<TContext> | undefined;
  readonly actions: readonly AgentAction<TContext>[];
  /** Exit and enter again even when the target is the current state. */
  readonly reenter: boolean;
}

/** A timeout of a state (one key of `after`) with its transitions. */
export interface Timer<TContext extends object = object> {
  /** Position among all timers of the statechart: populations keep their per-timer data by it. */
  readonly index: number;
  /** The key in `after`: a number of time units or the name of a delay. */
  readonly key: string;
  readonly delay: AgentDelay<TContext>;
  /** Name of the random stream the delay draws from; undefined for a fixed delay. */
  readonly streamName: string | undefined;
  /** The event of the step in which the timer fires. */
  readonly event: AgentEvent;
  /** Tried in order when the timer fires. */
  readonly transitions: readonly Transition<TContext>[];
}

/** A state, compiled. */
export interface StateNode<TContext extends object = object> {
  readonly name: string;
  /** Index in the statechart's `stateNames`: what populations store for an agent in this state. */
  readonly code: number;
  readonly final: boolean;
  readonly entry: readonly AgentAction<TContext>[];
  readonly exit: readonly AgentAction<TContext>[];
  /** Transitions by message type, each list in the order of the definition. */
  readonly on: ReadonlyMap<string, readonly Transition<TContext>[]>;
  readonly after: readonly Timer<TContext>[];
  /** Eventless transitions, in the order of the definition. */
  readonly always: readonly Transition<TContext>[];
}

export interface CompiledStatechart<TContext extends object> {
  readonly id: string | undefined;
  /** In the order of the definition; a state's code is its index. */
  readonly states: readonly StateNode<TContext>[];
  readonly initial: StateNode<TContext>;
  readonly createContext: (args: ContextArgs) => TContext;
}

export function compileStatechart<TContext extends object>(
  config: StatechartConfig<TContext>,
  implementations: StatechartImplementations<TContext>,
): CompiledStatechart<TContext> {
  return new Compiler(config, implementations).compile();
}

/** A delay value: finite and not negative, or Infinity ("never"). */
export function requireAgentDelay(value: unknown, what: string): number {
  return value === Infinity ? value : requireDelay(value, what);
}

/**
 * A state node while the compiler fills in its transitions. Transitions refer
 * to their target nodes, so all nodes are created first and completed in place.
 */
interface StateNodeDraft<TContext extends object> extends StateNode<TContext> {
  readonly on: Map<string, readonly Transition<TContext>[]>;
  readonly after: Timer<TContext>[];
  readonly always: Transition<TContext>[];
}

type Fields = Readonly<Record<string, unknown>>;

const STATECHART_KEYS = new Set(['id', 'initial', 'context', 'states', 'description']);
const STATE_KEYS = new Set(['type', 'entry', 'exit', 'on', 'after', 'always', 'description']);
const FINAL_STATE_KEYS = new Set(['type', 'entry', 'description']);
const TRANSITION_KEYS = new Set(['target', 'guard', 'actions', 'reenter', 'description']);
const IMPLEMENTATION_KEYS = new Set(['delays']);

/** Checks a definition and builds its state nodes. `where` strings name the place of a mistake. */
class Compiler<TContext extends object> {
  readonly #config: Fields;
  /** 'Statechart "<id>"' or 'Statechart': the start of every message. */
  readonly #name: string;
  readonly #delays: Fields;
  readonly #nodes = new Map<string, StateNodeDraft<TContext>>();
  #timerCount = 0;

  constructor(config: StatechartConfig<TContext>, implementations: StatechartImplementations<TContext>) {
    this.#config = requireFields(config, 'Statechart definition');
    const id = this.#config.id;
    if (id !== undefined && typeof id !== 'string') {
      throw invalid(`Statechart id must be a string, got ${describeValue(id)}`);
    }
    this.#name = id === undefined ? 'Statechart' : `Statechart "${id}"`;
    checkKeys(this.#config, STATECHART_KEYS, this.#name);
    this.#delays = this.#checkImplementations(implementations);
  }

  compile(): CompiledStatechart<TContext> {
    const stateConfigs = this.#stateConfigs();
    for (const [name, config] of stateConfigs) this.#addNode(name, config);
    for (const [name, config] of stateConfigs) this.#addTransitions(name, config);
    return {
      id: this.#config.id as string | undefined,
      states: [...this.#nodes.values()],
      initial: this.#initialState(),
      createContext: this.#contextFactory(),
    };
  }

  /** The named delays: numbers are checked now, functions when they run. */
  #checkImplementations(implementations: unknown): Fields {
    const where = `${this.#name}: implementations`;
    const checked = requireFields(implementations, where);
    checkKeys(checked, IMPLEMENTATION_KEYS, where);
    const delays = requireFields(checked.delays ?? {}, `${this.#name}: delays`);
    for (const [name, delay] of Object.entries(delays)) {
      if (typeof delay !== 'function') requireAgentDelay(delay, `${this.#name}: delay "${name}"`);
    }
    return delays;
  }

  #stateConfigs(): [string, Fields][] {
    const entries = Object.entries(requireFields(this.#config.states, `${this.#name}: states`));
    if (entries.length === 0) throw invalid(`${this.#name}: states must name at least one state`);
    if (entries.length > MAX_STATES) {
      throw invalid(`${this.#name} has ${String(entries.length)} states; at most ${String(MAX_STATES)} are supported`);
    }
    return entries.map(([name, config]) => [name, this.#checkState(name, config)]);
  }

  /** Keys of a state, including what this subset of XState leaves out. */
  #checkState(name: string, state: unknown): Fields {
    const where = `${this.#name}, state "${name}"`;
    const config = requireFields(state, where);
    if ('states' in config || 'initial' in config) {
      throw invalid(`${where}: nested (hierarchical) states are not supported yet`);
    }
    const type = config.type ?? 'atomic';
    if (type !== 'atomic' && type !== 'final') {
      throw invalid(
        `${where}: type ${describeValue(type)} is not supported; a state is 'atomic' or 'final' ` +
          '(parallel and history states are not supported yet)',
      );
    }
    if (type === 'final') {
      const extra = Object.keys(config).find((key) => !FINAL_STATE_KEYS.has(key));
      if (extra !== undefined) {
        throw invalid(`${where}: a final state has no transitions or exit actions, got "${extra}"`);
      }
    }
    checkKeys(config, STATE_KEYS, where);
    return config;
  }

  #addNode(name: string, config: Fields): void {
    const where = `${this.#name}, state "${name}"`;
    this.#nodes.set(name, {
      name,
      code: this.#nodes.size,
      final: config.type === 'final',
      entry: requireActions(config.entry, `${where}: entry`),
      exit: requireActions(config.exit, `${where}: exit`),
      on: new Map(),
      after: [],
      always: [],
    });
  }

  #addTransitions(name: string, config: Fields): void {
    const where = `${this.#name}, state "${name}"`;
    const node = this.#nodes.get(name);
    if (node === undefined) throw new Error(`Compiler: state "${name}" was not added`);
    for (const [type, transitions] of Object.entries(requireFields(config.on ?? {}, `${where}: on`))) {
      node.on.set(type, this.#transitions(transitions, `${where}, on "${type}"`));
    }
    for (const [key, transitions] of Object.entries(requireFields(config.after ?? {}, `${where}: after`))) {
      node.after.push(this.#timer(key, transitions, `${where}, after "${key}"`));
    }
    if (config.always === undefined) return;
    for (const transition of this.#transitions(config.always, `${where}, always`)) {
      checkEventless(transition, node, `${where}, always`);
      node.always.push(transition);
    }
  }

  #timer(key: string, transitions: unknown, where: string): Timer<TContext> {
    const delay = this.#delay(key, where);
    return {
      index: this.#timerCount++,
      key,
      delay,
      streamName: typeof delay === 'function' ? key : undefined,
      event: Object.freeze({ type: 'agent.after', delay: key }),
      transitions: this.#transitions(transitions, where),
    };
  }

  /** A key of `after`: a number of time units, or the name of a delay from the implementations. */
  #delay(key: string, where: string): AgentDelay<TContext> {
    const number = Number(key);
    if (key.trim() !== '' && Number.isFinite(number)) return requireDelay(number, `${where}: timeout`);
    if (!Object.hasOwn(this.#delays, key)) {
      throw invalid(
        `${where}: unknown delay "${key}"; give a number of time units or define the delay in the implementations`,
      );
    }
    return this.#delays[key] as AgentDelay<TContext>;
  }

  /** A transition, a target name or a list of them, as a list of compiled transitions. */
  #transitions(value: unknown, where: string): Transition<TContext>[] {
    const list = Array.isArray(value) ? (value as unknown[]) : [value];
    const placeOf = (index: number): string => (list.length > 1 ? `${where} [${String(index)}]` : where);
    return list.map((item, index) => this.#transition(item, placeOf(index)));
  }

  #transition(value: unknown, where: string): Transition<TContext> {
    if (typeof value === 'string') {
      return { target: this.#target(value, where), guard: undefined, actions: [], reenter: false };
    }
    const config = requireFields(value, `${where}: transition`);
    checkKeys(config, TRANSITION_KEYS, where);
    const target = config.target === undefined ? undefined : this.#target(config.target, where);
    const reenter = config.reenter ?? false;
    if (typeof reenter !== 'boolean') {
      throw invalid(`${where}: reenter must be true or false, got ${describeValue(reenter)}`);
    }
    if (reenter && target === undefined) throw invalid(`${where}: reenter needs a target state`);
    const guard = config.guard;
    if (guard !== undefined && typeof guard !== 'function') {
      throw invalid(`${where}: guard must be a function, got ${describeValue(guard)}`);
    }
    const actions = requireActions<TContext>(config.actions, `${where}: actions`);
    return { target, guard: guard as AgentGuard<TContext> | undefined, actions, reenter };
  }

  #target(name: unknown, where: string): StateNode<TContext> {
    if (typeof name !== 'string') throw invalid(`${where}: target must be a state name, got ${describeValue(name)}`);
    const node = this.#nodes.get(name);
    if (node === undefined) throw invalid(`${where}: target state "${name}" does not exist`);
    return node;
  }

  #initialState(): StateNode<TContext> {
    const initial = this.#config.initial;
    if (typeof initial !== 'string') {
      throw invalid(`${this.#name}: initial must name a state, got ${describeValue(initial)}`);
    }
    const node = this.#nodes.get(initial);
    if (node === undefined) throw invalid(`${this.#name}: initial state "${initial}" does not exist`);
    return node;
  }

  /** Every agent gets fields of its own: a shallow copy of the object, or what the function builds. */
  #contextFactory(): (args: ContextArgs) => TContext {
    const context = this.#config.context;
    const where = `${this.#name}: context`;
    // Without fields, TContext is plain `object`, so an empty object is the right value.
    if (context === undefined) return () => ({}) as TContext;
    if (typeof context === 'function') {
      const build = context as (args: ContextArgs) => TContext;
      return (args) => requireFields(build(args), `${where} function result`) as TContext;
    }
    const fields = requireFields(context, where);
    return () => ({ ...fields }) as TContext;
  }
}

/**
 * Refuses eventless transitions that would loop at once: without a guard and
 * without a target, or without a guard back to their own state.
 */
function checkEventless<TContext extends object>(
  transition: Transition<TContext>,
  state: StateNode<TContext>,
  where: string,
): void {
  if (transition.guard !== undefined) return;
  if (transition.target === undefined || transition.target === state) {
    throw invalid(
      `${where}: an eventless transition without a guard must go to another state, or it would loop forever`,
    );
  }
}

function invalid(message: string): SimulationError {
  return new SimulationError('INVALID_ARGUMENT', message);
}

/** A plain object (not null, not an array). */
function requireFields(value: unknown, what: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${what} must be an object, got ${describeValue(value)}`);
  }
  return value as Fields;
}

function checkKeys(record: Fields, allowed: ReadonlySet<string>, where: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw invalid(`${where}: unknown key "${unknown}"; supported keys: ${[...allowed].join(', ')}`);
  }
}

/** An action, a list of actions or nothing, as a list. */
function requireActions<TContext extends object>(value: unknown, what: string): AgentAction<TContext>[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? (value as unknown[]) : [value];
  for (const action of list) {
    if (typeof action !== 'function') throw invalid(`${what}: actions must be functions, got ${describeValue(action)}`);
  }
  return list as AgentAction<TContext>[];
}
