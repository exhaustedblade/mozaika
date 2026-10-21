/**
 * What the blocks package keeps for each simulation: block names, the
 * numbering of entities and the random streams of the blocks.
 */
import { type Random, SimulationError, type Simulation } from '@mozaika/kernel';

/** Numbers the arrivals of all sources of a simulation: 1, 2, 3… in order, lost ones included. */
export class EntityNumbers {
  #last = 0;

  /** The number of the next arrival. */
  next(): number {
    this.#last++;
    return this.#last;
  }
}

/** What the blocks package keeps for each simulation. */
interface SimulationRecord {
  readonly blockNames: Set<string>;
  readonly entityNumbers: EntityNumbers;
}

/**
 * The kernel knows nothing about blocks, so their per-simulation records live
 * here, keyed weakly by the simulation: a finished simulation takes its record
 * with it when it is garbage-collected. Blocks look their record up when they
 * are created, never per entity: a lookup costs too much for that.
 */
const records = new WeakMap<Simulation, SimulationRecord>();

function recordOf(simulation: Simulation): SimulationRecord {
  let record = records.get(simulation);
  if (record === undefined) {
    record = { blockNames: new Set(), entityNumbers: new EntityNumbers() };
    records.set(simulation, record);
  }
  return record;
}

/**
 * Checks that a block name is free in a simulation. Names are unique because
 * a block's random stream is chosen by its name (see blockStream), and later
 * tools refer to blocks by name.
 */
export function requireFreeBlockName(simulation: Simulation, name: string): void {
  if (recordOf(simulation).blockNames.has(name)) {
    throw new SimulationError('INVALID_ARGUMENT', `A block named "${name}" already exists in this simulation`);
  }
}

/** Claims a block name in a simulation; see requireFreeBlockName. */
export function registerBlockName(simulation: Simulation, name: string): void {
  requireFreeBlockName(simulation, name);
  recordOf(simulation).blockNames.add(name);
}

/** The numbering of the entities of a simulation, shared by its sources. */
export function entityNumbersOf(simulation: Simulation): EntityNumbers {
  return recordOf(simulation).entityNumbers;
}

/**
 * The random stream of a block: blocks/<name> under the simulation's stream.
 * It depends only on the seed and the name, so changing one block does not
 * shift the random numbers of the others.
 */
export function blockStream(simulation: Simulation, name: string): Random {
  return simulation.random.stream('blocks').stream(name);
}
