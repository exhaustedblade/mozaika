/**
 * Processes: model logic written as generator functions, in the style of SimPy.
 *
 *     function* customer(sim: Simulation, counter: Signal): ProcessBody {
 *       yield timeout(sim.random.stream('walk').exponential(2));
 *       const ticket = yield counter.wait();
 *       ...
 *     }
 *     sim.process(customer(sim, counter), { name: 'customer-1' });
 *
 * A process runs until it yields a command, then sleeps until the command wakes
 * it. Composite waits are plain generators combined with `yield*`.
 */

import { describeValue, messageOf, requireDelay, requireFinite, SimulationError } from './errors.js';
import { DEFAULT_PRIORITY } from './event-queue.js';
import { type Scheduler, schedulerOf } from './scheduler.js';
import { SignalWait } from './signal.js';
import type { Simulation } from './simulation.js';

export interface TimeoutOptions {
  /** Priority of the wake-up event (default 0): smaller wakes earlier at the same time. */
  readonly priority?: number;
}

/** The command a process yields to sleep for some model time: `yield timeout(5)`. */
export class Timeout {
  readonly delay: number;
  readonly priority: number;

  constructor(delay: number, options?: TimeoutOptions) {
    this.delay = requireDelay(delay, 'timeout() delay');
    this.priority = requireFinite(options?.priority ?? DEFAULT_PRIORITY, 'timeout() priority');
  }
}

/** Sleep for `delay` units of model time. The command is immutable and can be reused. */
export function timeout(delay: number, options?: TimeoutOptions): Timeout {
  return new Timeout(delay, options);
}

/** What a process can yield. */
export type Command = Timeout | SignalWait;

/**
 * A process body: the generator object returned by calling a generator function.
 * `TResult` is what the body returns; it becomes the process `result`.
 */
export type ProcessBody<TResult = void> = Generator<Command, TResult, unknown>;

export interface ProcessOptions {
  /** Name for traces and error messages; default "process-<id>". */
  readonly name?: string;
  /** Priority of the start event (default 0). */
  readonly priority?: number;
}

/**
 * - created: the start event is scheduled, the body has not run yet;
 * - running: the body is executing;
 * - suspended: the body yielded a command and waits for it;
 * - finished: the body returned; `result` holds the returned value;
 * - failed: the body threw; `error` holds what it threw.
 */
export type ProcessState = 'created' | 'running' | 'suspended' | 'finished' | 'failed';

function isGenerator(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ProcessBody<unknown>>;
  return typeof candidate.next === 'function' && typeof candidate.throw === 'function';
}

/** Throws a helpful error unless `body` is a generator object. */
function checkBody(body: unknown): void {
  if (isGenerator(body)) return;
  const hint =
    typeof body === 'function'
      ? '; call the generator function: sim.process(customer(sim)), not sim.process(customer)'
      : '';
  throw new SimulationError(
    'INVALID_ARGUMENT',
    `process() expects a generator object, got ${describeValue(body)}${hint}`,
  );
}

export class Process<TResult = unknown> {
  readonly id: number;
  readonly name: string;
  readonly #simulation: Simulation;
  readonly #scheduler: Scheduler;
  readonly #body: ProcessBody<TResult>;
  #state: ProcessState = 'created';
  #result: TResult | undefined;
  #error: unknown;

  /**
   * Resumes the body with a value. Created once per process and given to every
   * wake-up event (wake-ups.ts), so that waking a process allocates nothing.
   */
  readonly #wakeUp = (value?: unknown): void => {
    this.#run(value);
  };

  /** Use `simulation.process()`; it assigns the id. */
  constructor(simulation: Simulation, body: ProcessBody<TResult>, id: number, options?: ProcessOptions) {
    this.#simulation = simulation;
    this.#scheduler = schedulerOf(simulation);
    checkBody(body);
    this.#body = body;
    this.id = id;
    this.name = options?.name ?? `process-${String(id)}`;
    const priority = requireFinite(options?.priority ?? DEFAULT_PRIORITY, 'process() priority');
    this.#wakeAfter(0, priority);
  }

  get state(): ProcessState {
    return this.#state;
  }

  /** Value returned by the body, once finished; undefined before that. */
  get result(): TResult | undefined {
    return this.#result;
  }

  /** What the body threw, once failed. */
  get error(): unknown {
    return this.#error;
  }

  /** Runs the body until it yields a usable command or ends. */
  #run(value: unknown): void {
    this.#state = 'running';
    try {
      let step = this.#body.next(value);
      while (!step.done) {
        const problem = this.#suspendOn(step.value);
        if (problem === undefined) return;
        // Raise the problem at the yield itself: the body may catch it, otherwise it fails.
        step = this.#body.throw(problem);
      }
      this.#state = 'finished';
      this.#result = step.value;
    } catch (error) {
      this.#state = 'failed';
      this.#error = error;
      throw new SimulationError(
        'PROCESS_FAILED',
        `Process "${this.name}" failed at time ${String(this.#simulation.now)}: ${messageOf(error)}`,
        { cause: error },
      );
    }
  }

  /** Arranges the wake-up a command asks for; returns an error if the value is not a usable command. */
  #suspendOn(command: unknown): SimulationError | undefined {
    if (command instanceof Timeout) {
      this.#state = 'suspended';
      this.#wakeAfter(command.delay, command.priority);
      return undefined;
    }
    if (command instanceof SignalWait) {
      if (command.signal.simulation !== this.#simulation) {
        return new SimulationError(
          'INVALID_YIELD',
          `Process "${this.name}" waits for a signal of another simulation`,
        );
      }
      this.#state = 'suspended';
      command.signal.once(this.#wakeUp, this.name);
      return undefined;
    }
    return new SimulationError(
      'INVALID_YIELD',
      `Process "${this.name}" yielded ${describeValue(command)}; a process can yield timeout(...) or signal.wait()`,
    );
  }

  /** Schedules the wake-up of the process `delay` from now; delay and priority are already checked. */
  #wakeAfter(delay: number, priority: number): void {
    const scheduler = this.#scheduler;
    scheduler.wakeUps.schedule(scheduler.now + delay, priority, this.#wakeUp, undefined, this.name);
  }
}
