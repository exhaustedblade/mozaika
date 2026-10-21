/**
 * What the blocks package keeps for each simulation: block names, entity ids
 * and the random streams of the blocks.
 */
import { type Random, SimulationError, type Simulation } from '@mozaika/kernel';

/** What the blocks package keeps for each simulation. */
interface SimulationRecord {
  readonly blockNames: Set<string>;
  lastEntityId: number;
}

/**
 * The kernel knows nothing about blocks, so their per-simulation records live
 * here, keyed weakly by the simulation: a finished simulation takes its record
 * with it when it is garbage-collected.
 */
const records = new WeakMap<Simulation, SimulationRecord>();

function recordOf(simulation: Simulation): SimulationRecord {
  let record = records.get(simulation);
  if (record === undefined) {
    record = { blockNames: new Set(), lastEntityId: 0 };
    records.set(simulation, record);
  }
  return record;
}

/**
 * Claims a block name in a simulation. Names are unique because a block's
 * random stream is chosen by its name (see blockStream), and later tools refer
 * to blocks by name.
 */
export function registerBlockName(simulation: Simulation, name: string): void {
  const { blockNames } = recordOf(simulation);
  if (blockNames.has(name)) {
    throw new SimulationError('INVALID_ARGUMENT', `A block named "${name}" already exists in this simulation`);
  }
  blockNames.add(name);
}

/** The id for the next entity created in the simulation. */
export function nextEntityId(simulation: Simulation): number {
  const record = recordOf(simulation);
  record.lastEntityId++;
  return record.lastEntityId;
}

/**
 * The random stream of a block: blocks/<name> under the simulation's stream.
 * It depends only on the seed and the name, so changing one block does not
 * shift the random numbers of the others.
 */
export function blockStream(simulation: Simulation, name: string): Random {
  return simulation.random.stream('blocks').stream(name);
}
