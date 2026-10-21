/**
 * Signals: notifications that processes wait for with `yield signal.wait()`.
 */

import { requireFinite, requireFunction } from './errors.js';
import { DEFAULT_PRIORITY } from './event-queue.js';
import { type Scheduler, schedulerOf } from './scheduler.js';
import type { Simulation } from './simulation.js';
import type { Listener } from './wake-ups.js';

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
  readonly #scheduler: Scheduler;
  /** Who waits, in the order they started waiting, and the label of each one's wake-up event. */
  readonly #listeners: Listener[] = [];
  readonly #labels: (string | undefined)[] = [];
  readonly #wait = new SignalWait(this);

  constructor(simulation: Simulation, name?: string) {
    this.simulation = simulation;
    this.name = name;
    this.#scheduler = schedulerOf(simulation);
  }

  /** Number of processes and listeners waiting for the next notification. */
  get waiting(): number {
    return this.#listeners.length;
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
    this.#listeners.push(requireFunction(listener, 'once() listener'));
    this.#labels.push(label ?? this.name);
  }

  /** Wakes everyone waiting now, in the order they started waiting; returns how many. */
  notify(value?: unknown, options?: NotifyOptions): number {
    const priority = requireFinite(options?.priority ?? DEFAULT_PRIORITY, 'notify() priority');
    const listeners = this.#listeners;
    const labels = this.#labels;
    const { now, wakeUps } = this.#scheduler;
    // Scheduling runs no model code, so nobody can start waiting during the loop.
    const count = listeners.length;
    for (let index = 0; index < count; index++) {
      const listener = listeners[index];
      if (listener !== undefined) wakeUps.schedule(now, priority, listener, value, labels[index]);
    }
    listeners.length = 0;
    labels.length = 0;
    return count;
  }
}
