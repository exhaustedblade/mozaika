/** Assertions and helpers shared by the block tests. Not part of the package build. */
import type { Agent, Simulation, SimulationErrorCode } from '@mozaika/kernel';
import { expect } from 'vitest';

import type { EntityReceiver, RequestOutcome } from '../index.js';

/** Matches a SimulationError with the given code and, optionally, other fields such as `cause`. */
export function simulationError(code: SimulationErrorCode, fields: object = {}): unknown {
  return expect.objectContaining({ code, ...fields });
}

/** Matches a string that contains `text`. */
export function containing(text: string): unknown {
  return expect.stringContaining(text);
}

/** One entity reaching a Recorder. */
export interface Visit {
  readonly id: number;
  readonly time: number;
}

/**
 * The end of a flow that remembers which entities reached it and when, so
 * tests can check the order. Unlike a Sink, it leaves the agents in their
 * population. It also shows that model code can implement EntityReceiver itself.
 */
export class Recorder implements EntityReceiver {
  readonly simulation: Simulation;
  readonly name: string;
  readonly visits: Visit[] = [];
  readonly entities: Agent[] = [];

  constructor(simulation: Simulation, name = 'recorder') {
    this.simulation = simulation;
    this.name = name;
  }

  /** Ids of the entities in the order they arrived. */
  get ids(): number[] {
    return this.visits.map((visit) => visit.id);
  }

  tryReserve(): RequestOutcome {
    return 'granted'; // there is always room
  }

  reserve(): RequestOutcome {
    return 'granted';
  }

  enter(agent: Agent): void {
    this.visits.push({ id: agent.id, time: this.simulation.now });
    this.entities.push(agent);
  }
}
