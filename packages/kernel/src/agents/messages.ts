/**
 * Messages to the agents of one population (docs/AGENTS.md, section 4.3): a
 * kind of events whose recipient and message wait in a table of this kind,
 * by row, so that sending one allocates no object or closure. The recipient
 * is the agent object, not its place in the columns: a message stays with
 * its agent when other agents' removals move it, and finds out at delivery
 * whether the agent itself has been removed.
 */
import { DEFAULT_PRIORITY } from '../event-queue.js';
import type { EventKindHandler, Scheduler } from '../scheduler.js';
import { SlotPool } from '../slot-pool.js';
import { type Agent, agentFriend } from './agent.js';
import type { AgentEvent } from './definition.js';

export class AgentMessages<TContext extends object> implements EventKindHandler {
  readonly #scheduler: Scheduler;
  readonly #kind: number;
  /** Name of the population, for labels. */
  readonly #population: string;
  /** Rows of the table; an event carries its row as `data`. */
  readonly #rows = new SlotPool();
  readonly #recipients: (Agent<TContext> | undefined)[] = [];
  readonly #messages: (AgentEvent | undefined)[] = [];

  constructor(scheduler: Scheduler, population: string) {
    this.#scheduler = scheduler;
    this.#population = population;
    this.#kind = scheduler.registerKind(this);
  }

  /** Delivers `message` to `agent` as an event at the current time, after the events already due now (П-8). */
  send(agent: Agent<TContext>, message: AgentEvent): void {
    const row = this.#rows.take();
    this.#recipients[row] = agent;
    this.#messages[row] = message;
    this.#scheduler.add(this.#scheduler.now, DEFAULT_PRIORITY, this.#kind, 0, row);
  }

  fire(_target: number, row: number): void {
    const agent = this.#recipients[row];
    const message = this.#messages[row];
    this.#recipients[row] = undefined;
    this.#messages[row] = undefined;
    this.#rows.release(row);
    if (agent === undefined || message === undefined) {
      throw new Error(`AgentMessages "${this.#population}": row ${String(row)} holds no message`);
    }
    agentFriend.receive(agent, message);
  }

  /** "<population>#<agent>: message "<type>"" (П-29). */
  label(_target: number, row: number): string {
    const agent = this.#recipients[row];
    const type = this.#messages[row]?.type ?? '?';
    return `${this.#population}#${String(agent?.id)}: message "${type}"`;
  }
}
