import type { Agent, Simulation } from '@mozaika/kernel';

import { type BlockAction, requireAction, runAction } from './actions.js';
import type { EntityReceiver, RequestOutcome } from './block.js';
import { registerBlockName } from './registry.js';
import { Tally } from './statistics.js';
import { requireBoolean, requireName } from './validation.js';

export interface SinkOptions {
  /** Unique within the simulation. */
  readonly name: string;
  /** Runs when an entity enters, before the agent is removed (docs/BLOCKS.md, section 8). */
  readonly onEnter?: BlockAction;
  /**
   * Whether to remove the agent from its population; default true. With
   * false, the agent stays and goes on living by its statechart.
   */
  readonly removeAgents?: boolean;
}

/**
 * Takes entities out of the model and counts them; always has room
 * (docs/BLOCKS.md, section 7). By default it removes each agent from its
 * population (П-31), so a flow of agents does not pile up in memory, and the
 * columns of a population hold just the agents still in the model.
 */
export class Sink implements EntityReceiver {
  readonly simulation: Simulation;
  readonly name: string;
  readonly stats: {
    /** Time from creation at the source to leaving through this sink. */
    readonly timeInSystem: Tally;
  };
  readonly #onEnter: BlockAction | undefined;
  readonly #removeAgents: boolean;
  #count = 0;

  constructor(simulation: Simulation, options: SinkOptions) {
    this.simulation = simulation;
    this.name = requireName(options.name, 'Sink');
    this.#onEnter = requireAction(options.onEnter, `Sink "${this.name}" onEnter`);
    this.#removeAgents = requireBoolean(options.removeAgents, `Sink "${this.name}" removeAgents`, true);
    this.stats = { timeInSystem: new Tally() };
    registerBlockName(simulation, this.name);
  }

  /** Entities that have left through this sink since the start; not affected by resetStatistics(). */
  get count(): number {
    return this.#count;
  }

  /** A sink always has room. */
  tryReserve(): RequestOutcome {
    return 'granted';
  }

  reserve(): RequestOutcome {
    return 'granted';
  }

  enter(agent: Agent): void {
    this.#count++;
    this.stats.timeInSystem.add(this.simulation.now - agent.createdAt);
    runAction(this.#onEnter, agent, this);
    if (this.#removeAgents) agent.population.remove(agent);
  }

  /** Starts the statistics again from now (e.g. after a warm-up); the count goes on. */
  resetStatistics(): void {
    this.stats.timeInSystem.reset();
  }
}
