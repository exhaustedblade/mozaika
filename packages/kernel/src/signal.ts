/**
 * Signals: notifications that processes wait for with `yield signal.wait()`.
 */

import { DEFAULT_PRIORITY } from './event-queue.js';
import { requireFinite, requireFunction } from './errors.js';
import type { Simulation } from './simulation.js';

export interface NotifyOptions {
  /** Priority of the wake-up events (default 0): smaller wakes earlier at the same time. */
  readonly priority?: number;
}

/** The command a process yields to wait for a signal: `yield signal.wait()`. */
export class SignalWait {
  readonly signal: Signal;

  constructor(signal: Signal) {
    this.signal = signal;
  }
}

interface Waiter {
  readonly listener: (value: unknown) => void;
  readonly label: string | undefined;
}

/**
 * A notification that processes can wait for, e.g. "a customer arrived" or
 * "a resource was released".
 *
 * `notify(value)` wakes everyone waiting at that moment, in the order they
 * started waiting. Each wake-up is a new event at the current time, so it fires
 * after the events already waiting at that time and priority. Whoever starts
 * waiting after the notification waits for the next one: a signal does not
 * remember notifications nobody waited for.
 */
export class Signal {
  readonly simulation: Simulation;
  readonly name: string | undefined;
  #waiters: Waiter[] = [];
  readonly #wait = new SignalWait(this);

  constructor(simulation: Simulation, name?: string) {
    this.simulation = simulation;
    this.name = name;
  }

  /** Number of processes and listeners waiting for the next notification. */
  get waiting(): number {
    return this.#waiters.length;
  }

  /** The command to yield from a process: `const value = yield signal.wait()`. */
  wait(): SignalWait {
    return this.#wait;
  }

  /**
   * Calls `listener` with the value of the next notification. Like a waiting
   * process, the listener runs as an event of its own, not inside notify().
   * `label` names that event in traces and error messages.
   */
  once(listener: (value: unknown) => void, label?: string): void {
    this.#waiters.push({ listener: requireFunction(listener, 'once() listener'), label: label ?? this.name });
  }

  /** Wakes everyone waiting now, in the order they started waiting; returns how many. */
  notify(value?: unknown, options?: NotifyOptions): number {
    const priority = requireFinite(options?.priority ?? DEFAULT_PRIORITY, 'notify() priority');
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const { listener, label } of waiters) {
      const wake = (): void => {
        listener(value);
      };
      this.simulation.schedule(0, wake, { priority, label });
    }
    return waiters.length;
  }
}
