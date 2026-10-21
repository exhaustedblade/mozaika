/** Assertions and helpers shared by the block tests. Not part of the package build. */
import { type ProcessBody, type Simulation, type SimulationErrorCode } from '@mozaika/kernel';
import { expect } from 'vitest';

import type { Entity, EntityReceiver } from '../index.js';

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
 * tests can check the order. It also shows that model code can implement
 * EntityReceiver itself.
 */
export class Recorder implements EntityReceiver {
  readonly simulation: Simulation;
  readonly name: string;
  readonly visits: Visit[] = [];
  readonly entities: Entity[] = [];

  constructor(simulation: Simulation, name = 'recorder') {
    this.simulation = simulation;
    this.name = name;
  }

  /** Ids of the entities in the order they arrived. */
  get ids(): number[] {
    return this.visits.map((visit) => visit.id);
  }

  tryReserve(): boolean {
    return true;
  }

  *reserve(): ProcessBody {
    // There is always room: nothing to wait for.
  }

  // eslint-disable-next-line require-yield -- the receiver protocol expects a generator, even one that never waits
  *enter(entity: Entity): ProcessBody<undefined> {
    this.visits.push({ id: entity.id, time: this.simulation.now });
    this.entities.push(entity);
    return undefined;
  }
}
