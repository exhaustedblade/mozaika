/**
 * The entities a block holds (П-39), by row. Events of the block carry the
 * row, so they need no object or closure per entity.
 */
import { type Agent, SimulationError } from '@mozaika/kernel';

import { RowPool } from './row-pool.js';

export class EntityTable {
  /** Name of the block, for error messages. */
  readonly #owner: string;
  readonly #rows = new RowPool();
  readonly #agents: (Agent | undefined)[] = [];

  constructor(owner: string) {
    this.#owner = owner;
  }

  /** Takes a row for an entity whose agent is filled in later, with fill(). */
  open(): number {
    return this.#rows.take();
  }

  fill(row: number, agent: Agent): void {
    this.#agents[row] = agent;
  }

  /** Takes a row for `agent` and returns it. */
  add(agent: Agent): number {
    const row = this.#rows.take();
    this.#agents[row] = agent;
    return row;
  }

  agent(row: number): Agent {
    const agent = this.#agents[row];
    if (agent === undefined) {
      throw new SimulationError('INVALID_STATE', `"${this.#owner}" holds no entity in row ${String(row)}`);
    }
    return agent;
  }

  /** The agent in a row, if any; for labels, which must not fail. */
  agentOrUndefined(row: number): Agent | undefined {
    return this.#agents[row];
  }

  /** Frees the row of an entity that has left; the agent is let go, so the table does not keep it alive. */
  release(row: number): void {
    this.#agents[row] = undefined;
    this.#rows.release(row);
  }
}
